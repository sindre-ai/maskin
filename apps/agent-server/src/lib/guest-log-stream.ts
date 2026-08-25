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
 * These lines are operator-facing (journalctl on the box today, a log shipper
 * later) — they never reach `session_logs` or the customer's chat transcript.
 */

/** Longest single line emitted; anything beyond is truncated with a marker. */
export const GUEST_LOG_MAX_LINE_BYTES = 4_000

/** Per-session ceiling on lines emitted across BOTH streams. */
export const GUEST_LOG_MAX_LINES = 2_000

/** Per-session ceiling on bytes emitted across BOTH streams. */
export const GUEST_LOG_MAX_BYTES = 1_000_000

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

export type GuestLogStreamName = 'stdout' | 'stderr'

type EmitFn = (msg: string, ctx: Record<string, unknown>) => void

export interface GuestLogSinkOptions {
	sessionId: string
	/** Overrideable in tests. Defaults to `logger.info`. */
	emit?: EmitFn
	/** Overrideable in tests — reports the cap tripping. Defaults to `logger.warn`. */
	emitCapped?: EmitFn
	maxLines?: number
	maxBytes?: number
}

export interface GuestLogSink {
	/** Feed a raw chunk from one of the two streams. Buffers until newline. */
	push(stream: GuestLogStreamName, chunk: string | Uint8Array): void
	/** Emit any trailing partial line and the suppression summary. Idempotent. */
	close(): void
}

/**
 * One sink per `msb exec` process, shared by its stdout and stderr handlers so
 * the volume cap is a single per-session budget rather than one per stream.
 */
export function createGuestLogSink(options: GuestLogSinkOptions): GuestLogSink {
	const { sessionId } = options
	const emit = options.emit ?? ((msg, ctx) => logger.info(msg, ctx))
	const emitCapped = options.emitCapped ?? ((msg, ctx) => logger.warn(msg, ctx))
	const maxLines = options.maxLines ?? GUEST_LOG_MAX_LINES
	const maxBytes = options.maxBytes ?? GUEST_LOG_MAX_BYTES

	const partial: Record<GuestLogStreamName, string> = { stdout: '', stderr: '' }
	let lines = 0
	let bytes = 0
	let suppressed = 0
	let capReported = false
	let closed = false

	function emitLine(stream: GuestLogStreamName, raw: string): void {
		// Guest console is a PTY-ish stream: drop the CR of CRLF and any stray
		// carriage returns so a progress-spinner line doesn't log as one blob.
		const stripped = raw.replace(/\r/g, '')
		if (stripped.trim() === '') return

		if (lines >= maxLines || bytes >= maxBytes) {
			suppressed++
			if (!capReported) {
				capReported = true
				emitCapped('guest log volume cap reached; suppressing further output', {
					sessionId,
					source: 'msb-exec',
					lines,
					bytes,
					maxLines,
					maxBytes,
				})
			}
			return
		}

		let line = redactSecrets(stripped)
		if (line.length > GUEST_LOG_MAX_LINE_BYTES) {
			line = line.slice(0, GUEST_LOG_MAX_LINE_BYTES) + TRUNCATION_MARKER
		}
		lines++
		bytes += line.length
		emit('guest log', { sessionId, source: 'msb-exec', stream, line })
	}

	return {
		push(stream, chunk) {
			if (closed) return
			const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
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
			while (buf.length > GUEST_LOG_MAX_LINE_BYTES) {
				emitLine(stream, buf.slice(0, GUEST_LOG_MAX_LINE_BYTES))
				buf = buf.slice(GUEST_LOG_MAX_LINE_BYTES)
			}
			partial[stream] = buf
		},

		close() {
			if (closed) return
			for (const stream of ['stdout', 'stderr'] as const) {
				const rest = partial[stream]
				partial[stream] = ''
				if (rest !== '') emitLine(stream, rest)
			}
			closed = true
			if (suppressed > 0) {
				emitCapped('guest log output suppressed', {
					sessionId,
					source: 'msb-exec',
					suppressedLines: suppressed,
					maxLines,
					maxBytes,
				})
			}
		},
	}
}
