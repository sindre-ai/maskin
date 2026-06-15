type Flusher = (line: string) => boolean

export class InputQueue {
	private streams = new Map<string, Flusher>()
	private pending = new Map<string, string[]>()

	/**
	 * Register a stream flusher for `sessionId`. Any messages queued before this
	 * call are flushed immediately. Returns an unregister function to call when
	 * the stream closes.
	 */
	registerStream(sessionId: string, flusher: Flusher): () => void {
		const queued = this.pending.get(sessionId) ?? []
		this.pending.delete(sessionId)
		for (let i = 0; i < queued.length; i++) {
			if (!flusher(queued[i])) {
				// Stream closed mid-flush — re-park this message and everything after it.
				this.pending.set(sessionId, queued.slice(i))
				return () => {}
			}
		}
		this.streams.set(sessionId, flusher)
		return () => this.streams.delete(sessionId)
	}

	/**
	 * Enqueue a newline-terminated JSON line for `sessionId`. If a stream is
	 * connected it is flushed immediately; otherwise the message is parked until
	 * `registerStream` is called. If the flusher signals the stream is closed
	 * (returns false) the message is re-parked for the next connection.
	 */
	enqueue(sessionId: string, line: string): void {
		const flusher = this.streams.get(sessionId)
		if (flusher) {
			const ok = flusher(line)
			if (!ok) {
				this.streams.delete(sessionId)
				const q = this.pending.get(sessionId) ?? []
				q.push(line)
				this.pending.set(sessionId, q)
			}
			return
		}
		const q = this.pending.get(sessionId) ?? []
		q.push(line)
		this.pending.set(sessionId, q)
	}

	drainSession(sessionId: string): void {
		this.streams.delete(sessionId)
		this.pending.delete(sessionId)
	}
}
