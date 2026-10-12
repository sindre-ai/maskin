/**
 * Parses a `text/event-stream` body into events.
 *
 * Handles chunk boundaries that fall mid-line or mid-UTF-8 sequence, CRLF and
 * lone-CR line endings, multi-line `data:` fields, and `:` comment lines
 * (OpenRouter sends `: OPENROUTER PROCESSING` keepalives while a model warms
 * up). Does not interpret `[DONE]`; callers decide what it means.
 */
export interface SseEvent {
	event?: string
	data: string
}

export async function* parseSseStream(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let buffer = ''
	let event: string | undefined
	let data: string[] = []

	const flush = (): SseEvent | null => {
		if (data.length === 0) {
			event = undefined
			return null
		}
		const out: SseEvent = { data: data.join('\n'), ...(event !== undefined && { event }) }
		event = undefined
		data = []
		return out
	}

	const onAbort = () => {
		reader.cancel().catch(() => {})
	}
	signal?.addEventListener('abort', onAbort, { once: true })

	try {
		while (true) {
			if (signal?.aborted) return
			const { done, value } = await reader.read()
			if (done) break
			buffer += decoder.decode(value, { stream: true })
			// Normalise every line ending to \n. A trailing lone \r may be the first
			// half of a \r\n split across chunks, so hold it back until the next read.
			let held = ''
			if (buffer.endsWith('\r')) {
				held = '\r'
				buffer = buffer.slice(0, -1)
			}
			buffer = buffer.replace(/\r\n|\r/g, '\n')
			let nl = buffer.indexOf('\n')
			while (nl !== -1) {
				const line = buffer.slice(0, nl)
				buffer = buffer.slice(nl + 1)
				if (line === '') {
					const ev = flush()
					if (ev) yield ev
				} else if (!line.startsWith(':')) {
					const colon = line.indexOf(':')
					const field = colon === -1 ? line : line.slice(0, colon)
					let val = colon === -1 ? '' : line.slice(colon + 1)
					if (val.startsWith(' ')) val = val.slice(1)
					if (field === 'data') data.push(val)
					else if (field === 'event') event = val
				}
				nl = buffer.indexOf('\n')
			}
			buffer += held
		}
		buffer += decoder.decode()
		if (buffer.length > 0 && !buffer.startsWith(':')) {
			const colon = buffer.indexOf(':')
			const field = colon === -1 ? buffer : buffer.slice(0, colon)
			let val = colon === -1 ? '' : buffer.slice(colon + 1)
			if (val.startsWith(' ')) val = val.slice(1)
			if (field === 'data') data.push(val)
		}
		const last = flush()
		if (last) yield last
	} finally {
		signal?.removeEventListener('abort', onAbort)
		reader.releaseLock?.()
	}
}
