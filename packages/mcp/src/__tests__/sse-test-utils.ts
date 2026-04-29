import { vi } from 'vitest'

export function buildSSEFrame(
	data: string | Record<string, unknown>,
	opts: { id?: string; event?: string } = {},
): string {
	const lines: string[] = []
	if (opts.id) lines.push(`id: ${opts.id}`)
	if (opts.event) lines.push(`event: ${opts.event}`)
	const body = typeof data === 'string' ? data : JSON.stringify(data)
	lines.push(`data: ${body}`)
	return `${lines.join('\n')}\n\n`
}

// Build an SSE Response. If `keepOpen` is true (default), the stream emits the
// chunks and then hangs — this models a long-lived SSE connection. Pass
// `keepOpen: false` to close the stream after emitting (useful for testing
// reconnect behavior).
export function makeSSEResponse(chunks: string[], opts: { keepOpen?: boolean } = {}): Response {
	const keepOpen = opts.keepOpen ?? true
	const encoder = new TextEncoder()
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
			if (!keepOpen) controller.close()
		},
	})
	return new Response(stream, {
		status: 200,
		headers: { 'content-type': 'text/event-stream' },
	})
}

export function makeHangingSSEResponse(): Response {
	return makeSSEResponse([], { keepOpen: true })
}

// A mock fetch impl that returns a never-resolving promise, but rejects when
// the request's AbortSignal fires.
export function makeHangingFetch(): ReturnType<typeof vi.fn> {
	return vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
		return new Promise((_resolve, reject) => {
			const signal = init?.signal
			if (signal?.aborted) {
				reject(new DOMException('aborted', 'AbortError'))
				return
			}
			signal?.addEventListener('abort', () => {
				reject(new DOMException('aborted', 'AbortError'))
			})
		})
	})
}

export function makeMockServer() {
	const sendLoggingMessage = vi.fn().mockResolvedValue(undefined)
	return {
		server: { sendLoggingMessage },
		_send: sendLoggingMessage,
	} as unknown as {
		server: { sendLoggingMessage: ReturnType<typeof vi.fn> }
		_send: ReturnType<typeof vi.fn>
	}
}
