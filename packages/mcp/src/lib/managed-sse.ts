// Shared ref-counted SSE consumer for the MCP server.
// Handles reconnect with exponential backoff, Last-Event-ID resumption,
// dedup of replayed frames, terminal HTTP statuses, abort-to-reader-cancel
// cascade, and replay-cap gap detection. Used by both event and session-log
// subscription registries.

export interface ParsedSSEFrame {
	id?: string
	event?: string
	data?: string
}

// Split a buffer of SSE text into complete frames plus a residual partial frame.
// Frames are `\n\n`-delimited; `\r\n` line endings are normalized to `\n`.
// Within a frame, each line is `field: value` — `data` lines are concatenated with `\n`,
// and lines starting with `:` are comments (including heartbeat comments from the server).
export function parseSSEChunk(buffer: string): { frames: ParsedSSEFrame[]; residual: string } {
	const frames: ParsedSSEFrame[] = []
	const normalized = buffer.replace(/\r\n/g, '\n')
	const parts = normalized.split('\n\n')
	const residual = parts.pop() ?? ''
	for (const part of parts) {
		if (!part) continue
		const frame: ParsedSSEFrame = {}
		const dataLines: string[] = []
		let hasField = false
		for (const line of part.split('\n')) {
			if (!line || line.startsWith(':')) continue
			const colon = line.indexOf(':')
			if (colon === -1) continue
			const field = line.slice(0, colon)
			let value = line.slice(colon + 1)
			if (value.startsWith(' ')) value = value.slice(1)
			if (field === 'id') {
				frame.id = value
				hasField = true
			} else if (field === 'event') {
				frame.event = value
				hasField = true
			} else if (field === 'data') {
				dataLines.push(value)
				hasField = true
			}
		}
		if (dataLines.length) frame.data = dataLines.join('\n')
		if (hasField) frames.push(frame)
	}
	return { frames, residual }
}

export class SSEStatusError extends Error {
	constructor(
		public readonly status: number,
		message?: string,
	) {
		super(message ?? `SSE connect failed: ${status}`)
		this.name = 'SSEStatusError'
	}
}

// Treat all 4xx as terminal EXCEPT 408 (Request Timeout) and 429 (Too Many
// Requests), which are transient. 5xx is always transient.
export function isTerminalStatus(status: number): boolean {
	if (status === 408 || status === 429) return false
	return status >= 400 && status < 500
}

export function isAbortError(err: unknown): boolean {
	return err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort'))
}

export type TerminalReason = 'auth_error' | 'terminal_status' | 'stream_end'

export interface ParsedItem<T> {
	item?: T
	terminal?: boolean
}

export interface ManagedSSEOptions<T> {
	url: string
	// Base headers (Authorization, X-Workspace-Id, Accept, ...). Called fresh on
	// each reconnect. The manager adds `Last-Event-ID` automatically when set.
	headers: () => Record<string, string>
	// Called per SSE frame. Return `{ item }` to deliver, `{ terminal: true }` to
	// end the stream (optionally with a final item), or `null` to skip.
	parseFrame: (frame: ParsedSSEFrame) => ParsedItem<T> | null
	onItem: (item: T, meta: { eventId?: string }) => Promise<void>
	onWarn: (level: 'warning' | 'error', message: string) => Promise<void>
	onTerminal: (reason: TerminalReason) => void
	// Max number of frames the backend will replay on resumption. When we
	// reconnect with Last-Event-ID and exactly this many frames come back, we
	// emit one gap-warning — the backend may have dropped older frames.
	replayCap: number
	// Used as a stderr prefix, e.g. "workspace abc" or "session xyz".
	logTag: string
}

export interface ManagedSSEStream {
	addRef(id: string): void
	removeRef(id: string): boolean
	hasRefs(): boolean
	refCount(): number
	stop(): Promise<void>
}

export function createManagedSSE<T>(opts: ManagedSSEOptions<T>): ManagedSSEStream {
	const refs = new Set<string>()
	const recentEventIds: string[] = []
	// Dedup ring must be at least as large as the backend's replay window, or a
	// resume after we delivered a full replay window's worth of frames could
	// re-deliver the oldest ones (their ids would have aged out of the ring).
	// 2× replayCap gives slack for overlap; floor at 256 keeps the small-replay
	// case (event stream replayCap=100) bounded above the typical noise.
	const dedupRingSize = Math.max(256, opts.replayCap * 2)
	let abortController: AbortController | null = null
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null
	let lastEventId: string | null = null
	let stopped = false
	let reconnectAttempts = 0
	let runPromise: Promise<void> | null = null
	// When the dedup ring evicts an id it has never sent back through dedup, any
	// future replay could silently re-deliver it. Warn once per process so the
	// client can reconcile; see comment above `dedupRingSize` for sizing.
	let evictionWarned = false

	async function waitBackoff() {
		reconnectAttempts++
		const attempt = Math.min(reconnectAttempts - 1, 5)
		const delay = Math.min(1000 * 2 ** attempt, 30000)
		await new Promise<void>((resolve) => {
			reconnectTimer = setTimeout(() => {
				reconnectTimer = null
				resolve()
			}, delay)
		})
	}

	async function connect() {
		const controller = new AbortController()
		abortController = controller
		const headers = { ...opts.headers() }
		const resuming = lastEventId !== null
		if (resuming) {
			headers['Last-Event-ID'] = lastEventId as string
		}

		const response = await fetch(opts.url, {
			method: 'GET',
			headers,
			signal: controller.signal,
		})

		if (!response.ok) {
			throw new SSEStatusError(response.status)
		}

		reconnectAttempts = 0

		if (!response.body) {
			throw new Error('SSE response has no body')
		}

		const reader = response.body.getReader()
		// Cascade abort → reader cancel. Manually-constructed ReadableStreams
		// (and some runtimes' fetch bodies) don't always honor AbortController on
		// their own, so we wire it up explicitly.
		const onAbort = () => {
			reader.cancel().catch(() => {})
		}
		controller.signal.addEventListener('abort', onAbort)
		const decoder = new TextDecoder()
		let buffer = ''

		// Gap detection: if we resumed with Last-Event-ID and end up receiving at
		// least `replayCap` frames during this connect, emit a single warning.
		// The backend caps its replay, so older frames may have been dropped.
		let itemsReceivedThisConnect = 0
		let gapWarned = false

		try {
			while (!stopped) {
				const { done, value } = await reader.read()
				if (done) break
				buffer += decoder.decode(value, { stream: true })
				const { frames, residual } = parseSSEChunk(buffer)
				buffer = residual
				for (const frame of frames) {
					const { fresh, terminal } = await handleFrame(frame)
					if (fresh && resuming && !gapWarned) {
						itemsReceivedThisConnect++
						if (itemsReceivedThisConnect >= opts.replayCap) {
							gapWarned = true
							await opts.onWarn(
								'warning',
								`Replayed ${opts.replayCap} frames on reconnect — older frames may have been dropped. Backfill with get_events/get_session_logs to fill the gap.`,
							)
						}
					}
					if (terminal) return 'stream_end' as const
				}
			}
			return null
		} finally {
			controller.signal.removeEventListener('abort', onAbort)
			try {
				reader.releaseLock()
			} catch {
				// reader may already be released if the body was aborted
			}
			abortController = null
		}
	}

	async function handleFrame(
		frame: ParsedSSEFrame,
	): Promise<{ fresh: boolean; terminal: boolean }> {
		const parsed = opts.parseFrame(frame)
		if (!parsed) return { fresh: false, terminal: false }

		let fresh = false
		if (parsed.item !== undefined) {
			if (frame.id && recentEventIds.includes(frame.id)) {
				// duplicate — skip delivery, do not advance lastEventId
			} else {
				fresh = true
				let delivered = true
				try {
					await opts.onItem(parsed.item, { eventId: frame.id })
				} catch (err) {
					delivered = false
					console.error(
						`[maskin-mcp] Item delivery failed (${opts.logTag}):`,
						err instanceof Error ? err.message : err,
					)
				}
				// Only advance the resume cursor + dedup ring on success. On failure,
				// the next reconnect will replay this id; if a later id succeeds the
				// failed one is permanently lost (counted as dropped by the registry),
				// but we don't pretend it was delivered for resumption purposes.
				if (frame.id && delivered) {
					recentEventIds.push(frame.id)
					if (recentEventIds.length > dedupRingSize) {
						recentEventIds.shift()
						if (!evictionWarned) {
							evictionWarned = true
							await opts.onWarn(
								'warning',
								`Dedup ring exceeded ${dedupRingSize} entries — a future reconnect may re-deliver already-seen frames. Increase replayCap or reconcile via get_events/get_session_logs.`,
							)
						}
					}
					lastEventId = frame.id
				}
			}
		}

		return { fresh, terminal: parsed.terminal === true }
	}

	async function run() {
		let terminalReason: TerminalReason | null = null
		try {
			while (!stopped && refs.size > 0) {
				try {
					const streamEnd = await connect()
					if (streamEnd === 'stream_end') {
						terminalReason = 'stream_end'
						break
					}
					if (stopped || refs.size === 0) break
					await waitBackoff()
				} catch (err) {
					if (stopped) break
					if (isAbortError(err)) break
					if (err instanceof SSEStatusError && isTerminalStatus(err.status)) {
						const authLike = err.status === 401 || err.status === 403
						console.error(`[maskin-mcp] SSE terminal status ${err.status} (${opts.logTag})`)
						await opts.onWarn(
							'error',
							authLike
								? 'Subscription ended: authorization failed.'
								: `Subscription ended: server returned ${err.status}.`,
						)
						terminalReason = authLike ? 'auth_error' : 'terminal_status'
						break
					}
					console.error(
						`[maskin-mcp] SSE error (${opts.logTag}):`,
						err instanceof Error ? err.message : err,
					)
					if (refs.size === 0) break
					await waitBackoff()
				}
			}
		} finally {
			runPromise = null
			if (terminalReason !== null) opts.onTerminal(terminalReason)
		}
	}

	function startIfIdle() {
		if (!runPromise && !stopped && refs.size > 0) {
			runPromise = run()
		}
	}

	return {
		addRef(id) {
			refs.add(id)
			startIfIdle()
		},
		removeRef(id) {
			return refs.delete(id)
		},
		hasRefs() {
			return refs.size > 0
		},
		refCount() {
			return refs.size
		},
		async stop() {
			stopped = true
			if (reconnectTimer) {
				clearTimeout(reconnectTimer)
				reconnectTimer = null
			}
			abortController?.abort()
			abortController = null
			if (runPromise) {
				try {
					await runPromise
				} catch {
					// run() already logs errors; swallow here to keep shutdown clean
				}
			}
		},
	}
}
