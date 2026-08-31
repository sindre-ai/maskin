import { StringDecoder } from 'node:string_decoder'
import { logger } from './logger'

/**
 * Host-side capture of a microVM's guest console (`msb exec <session>` stdout /
 * stderr).
 *
 * The guest helper processes launched by agent-run.sh — input-stream.js,
 * output-stream.js, preview-port-watcher.js, cdp-retry-proxy.js — write their
 * diagnostics to stderr, which is inherited by `msb exec` on the host. That
 * stream used to be drained into empty callbacks, so when a helper died
 * silently the only evidence of it was discarded (see the wedged-chat incident
 * behind PRs #1450-#1454).
 *
 * This module turns that stream into structured `logger` lines. It is
 * deliberately independent of the guest's own log-shipping path
 * (output-stream.js -> POST /sessions/:id/logs/ingest): output-stream.js is one
 * of the helpers we need visibility into, and a broken shipper cannot report
 * its own brokenness.
 *
 * These lines are operator-facing: journalctl on the box today, a log shipper
 * later. Nothing here writes to `session_logs`.
 *
 * That is not the same as saying an operator line can never appear in a
 * customer's transcript. `input-stream.js`'s `note()` independently POSTs its
 * own diagnostics to /sessions/:id/logs/ingest, so those specific lines land in
 * both places. That predates this module and is unchanged by it — but it is a
 * property of the system, not of this sink, and the distinction matters if the
 * ingest POST is ever retired now that this host-side channel exists.
 */

/** Longest single line emitted; anything beyond is truncated with a marker. */
export const GUEST_LOG_MAX_LINE_BYTES = 4_000

/**
 * The volume cap is a *rate*, not a lifetime budget.
 *
 * A lifetime cap is the wrong shape for this feature. Interactive sessions run
 * for hours; a moderately chatty helper would exhaust a per-session budget in
 * the first minutes, leaving the sink dead for exactly the window where a wedge
 * becomes interesting. In the incident behind PRs #1450-#1454 the diagnostic
 * signal was a helper going quiet *late* — 15 minutes in, with no re-dial. A
 * lifetime cap would have suppressed it.
 *
 * So the budget resets every window. Recent output is always available no
 * matter how long the session has been alive, while disk-per-hour stays bounded
 * (200 lines / 100 KB per minute is at most ~12k lines / ~6 MB per session-hour).
 */

/** Length of the rate-cap window. */
export const GUEST_LOG_WINDOW_MS = 60_000

/** Lines emitted per window, across BOTH streams. */
export const GUEST_LOG_MAX_LINES_PER_WINDOW = 200

/** Bytes emitted per window, across BOTH streams. */
export const GUEST_LOG_MAX_BYTES_PER_WINDOW = 100_000

const TRUNCATION_MARKER = '…[truncated]'
const REDACTED = '[REDACTED]'

/**
 * Token-shaped strings that must never leave the box. agent-run.sh handles
 * GITHUB_TOKEN, ANTHROPIC_* credentials and arbitrary MCP server env, and a
 * guest helper can plausibly echo any of them (a curl error quoting a URL, a
 * helper dumping its env on failure). Redaction runs before anything is
 * logged.
 *
 * Ordered most-specific-first: `KEY=value` / `Bearer x` forms are applied
 * before the bare-token patterns so the whole assignment collapses rather than
 * leaving a dangling `GITHUB_TOKEN=` prefix behind a redacted value.
 */
const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
	// `Authorization: Bearer <tok>` / `x-api-key: <tok>` style headers.
	[
		/\b(authorization|x-api-key|api-key|proxy-authorization)(\s*[:=]\s*)(?:\w+\s+)?\S+/gi,
		`$1$2${REDACTED}`,
	],
	// A bare `Bearer <tok>` with no header name in front of it.
	[/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
	// Any secret-shaped env assignment, in shell (`FOO=bar`) or JSON
	// (`"FOO": "bar"`) form. Matches the key name, not the value shape, so it
	// catches provider tokens we have no prefix for.
	[
		/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)[A-Z0-9_]*)("?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
		`$1$2${REDACTED}`,
	],
	// Credentials embedded in a URL's userinfo: https://user:pass@host
	[/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${REDACTED}@`],
	// Known token prefixes, wherever they appear (log prose, JSON, argv dumps).
	[/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
	[/\bgh[pousr]_[A-Za-z0-9]{16,}/g, REDACTED],
	[/\bsk-ant-[A-Za-z0-9._-]{16,}/g, REDACTED],
	[/\bsk-[A-Za-z0-9]{20,}/g, REDACTED],
	[/\bank_[A-Za-z0-9]{16,}/g, REDACTED],
	[/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
	// JWTs (Anthropic OAuth, GitHub App installation tokens, MCP bearer tokens).
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
]

/**
 * Strip token-shaped substrings from a single guest line. Hard requirement:
 * these logs are shipped off-box, so this runs on every line before it reaches
 * the logger — never after.
 */
export function redactSecrets(line: string): string {
	let out = line
	for (const [pattern, replacement] of REDACTIONS) {
		out = out.replace(pattern, replacement)
	}
	return out
}

/** Real UTF-8 byte length — `String.length` counts UTF-16 code units. */
function byteLength(s: string): number {
	return Buffer.byteLength(s, 'utf8')
}

/**
 * Cut `s` to at most `maxBytes` UTF-8 bytes without splitting a character.
 *
 * `StringDecoder.write` returns only the complete characters in the slice and
 * retains any trailing partial sequence in its own state, which we discard by
 * dropping the decoder. Slicing by `String.length` instead would enforce a byte
 * limit with a character count — the same mistake the `session_logs` NOTIFY
 * trigger made with `left(NEW.content, 7000)` against an 8 KB limit, which
 * silently rolled back inserts (see .claude/rules/known-pitfalls.md).
 */
function truncateToBytes(s: string, maxBytes: number): string {
	if (byteLength(s) <= maxBytes) return s
	return new StringDecoder('utf8').write(Buffer.from(s, 'utf8').subarray(0, maxBytes))
}

export type GuestLogStreamName = 'stdout' | 'stderr'

type EmitFn = (msg: string, ctx: Record<string, unknown>) => void

export interface GuestLogSinkOptions {
	sessionId: string
	/** Overrideable in tests. Defaults to `logger.info`. */
	emit?: EmitFn
	/** Overrideable in tests — reports the cap tripping. Defaults to `logger.warn`. */
	emitCapped?: EmitFn
	/** Lines allowed per window, across both streams. */
	maxLines?: number
	/** Bytes allowed per window, across both streams. */
	maxBytes?: number
	/** Length of the rate-cap window in ms. */
	windowMs?: number
	/**
	 * Clock source. Injected rather than calling `Date.now()` inline so window
	 * tests are deterministic without fake timers or sleeps.
	 */
	now?: () => number
}

export interface GuestLogSink {
	/** Feed a raw chunk from one of the two streams. Buffers until newline. */
	push(stream: GuestLogStreamName, chunk: string | Uint8Array): void
	/** Emit any trailing partial line and the suppression summary. Idempotent. */
	close(): void
}

/**
 * One sink per `msb exec` process, shared by its stdout and stderr handlers so
 * the rate cap is a single per-session budget rather than one per stream.
 */
export function createGuestLogSink(options: GuestLogSinkOptions): GuestLogSink {
	const { sessionId } = options
	const emit = options.emit ?? ((msg, ctx) => logger.info(msg, ctx))
	const emitCapped = options.emitCapped ?? ((msg, ctx) => logger.warn(msg, ctx))
	const maxLines = options.maxLines ?? GUEST_LOG_MAX_LINES_PER_WINDOW
	const maxBytes = options.maxBytes ?? GUEST_LOG_MAX_BYTES_PER_WINDOW
	const windowMs = options.windowMs ?? GUEST_LOG_WINDOW_MS
	const now = options.now ?? (() => Date.now())

	const partial: Record<GuestLogStreamName, string> = { stdout: '', stderr: '' }
	// One decoder per stream: they are independent, and a decoder carries the
	// trailing bytes of a multi-byte character across chunk boundaries.
	const decoders: Record<GuestLogStreamName, StringDecoder> = {
		stdout: new StringDecoder('utf8'),
		stderr: new StringDecoder('utf8'),
	}

	// Per-window counters. `windowStart` is the open window's start instant.
	let windowStart = now()
	let lines = 0
	let bytes = 0
	let droppedInWindow = 0
	let capReportedInWindow = false
	// Lifetime tally, for the summary on close only — it never gates emission.
	let totalSuppressed = 0
	let closed = false

	/**
	 * Roll the window forward if it has expired, reporting what the closing
	 * window dropped. Suppression is then visible in the timeline at the point
	 * it ended, rather than inferred from a gap.
	 */
	function rollWindow(): void {
		const elapsed = now() - windowStart
		if (elapsed < windowMs) return
		if (droppedInWindow > 0) {
			emitCapped('guest log rate cap window closed; output resuming', {
				sessionId,
				source: 'msb-exec',
				droppedLines: droppedInWindow,
				windowMs,
				maxLines,
				maxBytes,
			})
		}
		// Snap to a window boundary rather than to `now`, so a burst arriving
		// mid-window does not shift the cadence.
		windowStart += Math.floor(elapsed / windowMs) * windowMs
		lines = 0
		bytes = 0
		droppedInWindow = 0
		capReportedInWindow = false
	}

	function emitLine(stream: GuestLogStreamName, raw: string): void {
		// Guest console is a PTY-ish stream: drop the CR of CRLF and any stray
		// carriage returns so a progress-spinner line doesn't log as one blob.
		const stripped = raw.replace(/\r/g, '')
		if (stripped.trim() === '') return

		rollWindow()

		if (lines >= maxLines || bytes >= maxBytes) {
			droppedInWindow++
			totalSuppressed++
			if (!capReportedInWindow) {
				capReportedInWindow = true
				emitCapped('guest log rate cap reached; suppressing output for this window', {
					sessionId,
					source: 'msb-exec',
					lines,
					bytes,
					windowMs,
					maxLines,
					maxBytes,
				})
			}
			return
		}

		const redacted = redactSecrets(stripped)
		const line =
			byteLength(redacted) > GUEST_LOG_MAX_LINE_BYTES
				? truncateToBytes(redacted, GUEST_LOG_MAX_LINE_BYTES) + TRUNCATION_MARKER
				: redacted
		lines++
		bytes += byteLength(line)
		emit('guest log', { sessionId, source: 'msb-exec', stream, line })
	}

	return {
		push(stream, chunk) {
			if (closed) return
			// One decoder per stream, so a multi-byte character split across two
			// chunks is reassembled instead of decoding to U+FFFD twice.
			const text = typeof chunk === 'string' ? chunk : decoders[stream].write(Buffer.from(chunk))
			let buf = partial[stream] + text

			let nl = buf.indexOf('\n')
			while (nl !== -1) {
				emitLine(stream, buf.slice(0, nl))
				buf = buf.slice(nl + 1)
				nl = buf.indexOf('\n')
			}

			// A guest that never emits a newline (a stuck progress bar, a binary
			// dump) must not grow this buffer without bound — flush it as a line
			// once it passes the per-line ceiling.
			while (byteLength(buf) > GUEST_LOG_MAX_LINE_BYTES) {
				const head = truncateToBytes(buf, GUEST_LOG_MAX_LINE_BYTES)
				// A single character wider than the ceiling would loop forever.
				if (head === '') break
				emitLine(stream, head)
				buf = buf.slice(head.length)
			}
			partial[stream] = buf
		},

		close() {
			if (closed) return
			for (const stream of ['stdout', 'stderr'] as const) {
				// The decoder holds the trailing bytes of a character that was still
				// incomplete when the stream ended; flush it before the final line or
				// that character is lost.
				const rest = partial[stream] + decoders[stream].end()
				partial[stream] = ''
				if (rest !== '') emitLine(stream, rest)
			}
			closed = true
			if (droppedInWindow > 0) {
				emitCapped('guest log rate cap window closed; output resuming', {
					sessionId,
					source: 'msb-exec',
					droppedLines: droppedInWindow,
					windowMs,
					maxLines,
					maxBytes,
				})
			}
			if (totalSuppressed > 0) {
				emitCapped('guest log output suppressed', {
					sessionId,
					source: 'msb-exec',
					suppressedLines: totalSuppressed,
					windowMs,
					maxLines,
					maxBytes,
				})
			}
		},
	}
}
