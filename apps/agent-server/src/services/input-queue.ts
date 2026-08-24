/**
 * Delivers user turns to an interactive session's VM.
 *
 * The delivery contract is ACK-based, and it has to be. A turn is written into
 * a long-lived HTTP response whose socket terminates on the host at
 * microsandbox's egress proxy, not inside the VM. When the proxy's guest-side
 * leg dies, the host keeps accepting and ACKing everything written into it
 * while nothing reaches the guest — `write()` resolves against the kernel
 * buffer, which proves the bytes left this process and nothing more.
 *
 * The original implementation treated that successful write as delivery and
 * dropped the turn. The result was silent, total, and unrecoverable: the user
 * sent a message, the agent-server returned 200, and the turn ceased to exist.
 * Reconnecting could not help, because there was nothing left to replay
 * (production wedges of 2026-08-21..24).
 *
 * So turns live in `unacked` until the VM reports having consumed them. Each
 * turn carries a monotonic seq; the VM sends its high-water mark as `after` on
 * every (re)connect, which both acknowledges everything up to that point and
 * asks for whatever followed. A write that silently vanished is redelivered on
 * the next connection instead of being lost.
 */

/** Returns false if the stream is closed and the turn must be re-delivered. */
type Flusher = (line: string, seq: number) => boolean | Promise<boolean>

type Turn = { seq: number; line: string }

/**
 * Cap on turns retained per session awaiting ack. A stream that never acks
 * (permanently blackholed VM, or one that dies before its first read) would
 * otherwise grow this without bound for the life of the session. 200 turns is
 * far more than any real conversation gets through between reconnects — the VM
 * re-dials on its idle timeout, so the buffer normally holds 0 or 1 — while
 * still bounding the damage. Oldest turns are evicted first: if we must lose
 * something, lose the stalest context, not the message the user just sent.
 */
const MAX_UNACKED_PER_SESSION = 200

export class InputQueue {
	private streams = new Map<string, Flusher>()
	private unacked = new Map<string, Turn[]>()
	private seqs = new Map<string, number>()

	/**
	 * Register a stream flusher for `sessionId`.
	 *
	 * `after` is the VM's high-water mark: the seq of the last turn it actually
	 * consumed. Everything up to it is acknowledged and discarded; everything
	 * after it is replayed onto the new stream. A VM that has seen nothing
	 * sends 0, which replays the whole retained buffer.
	 *
	 * Returns an unregister function to call when the stream closes.
	 */
	async registerStream(sessionId: string, flusher: Flusher, after = 0): Promise<() => void> {
		this.ack(sessionId, after)

		// Replay against a snapshot: an await below yields, and a concurrent
		// enqueue may append to the live array while we are iterating it.
		const backlog = [...(this.unacked.get(sessionId) ?? [])]
		for (const turn of backlog) {
			if (!(await flusher(turn.line, turn.seq))) {
				// Stream closed mid-replay. Everything stays in `unacked` — it is
				// only ever removed by an ack — so the next connection replays it.
				return () => {}
			}
		}
		this.streams.set(sessionId, flusher)
		// Only delete our own registration: a dead connection's late unregister
		// (heartbeat failure or abort firing after the VM already reconnected)
		// must not tear down the replacement stream's flusher.
		return () => {
			if (this.streams.get(sessionId) === flusher) this.streams.delete(sessionId)
		}
	}

	/**
	 * Enqueue a newline-terminated JSON line for `sessionId` and attempt
	 * immediate delivery.
	 *
	 * The turn is retained regardless of what the write reports. A successful
	 * write is an optimisation, not proof of arrival — see the class comment.
	 */
	async enqueue(sessionId: string, line: string): Promise<void> {
		const seq = (this.seqs.get(sessionId) ?? 0) + 1
		this.seqs.set(sessionId, seq)

		const turns = this.unacked.get(sessionId) ?? []
		turns.push({ seq, line })
		if (turns.length > MAX_UNACKED_PER_SESSION) {
			turns.splice(0, turns.length - MAX_UNACKED_PER_SESSION)
		}
		this.unacked.set(sessionId, turns)

		const flusher = this.streams.get(sessionId)
		if (!flusher) return
		if (!(await flusher(line, seq))) {
			// Same identity guard as unregister: a reconnect may have replaced
			// the entry while we awaited the failing flusher.
			if (this.streams.get(sessionId) === flusher) this.streams.delete(sessionId)
		}
	}

	/** Discard every turn up to and including `seq`. */
	private ack(sessionId: string, seq: number): void {
		if (seq <= 0) return
		const turns = this.unacked.get(sessionId)
		if (!turns) return
		const remaining = turns.filter((t) => t.seq > seq)
		if (remaining.length === 0) this.unacked.delete(sessionId)
		else this.unacked.set(sessionId, remaining)
	}

	drainSession(sessionId: string): void {
		this.streams.delete(sessionId)
		this.unacked.delete(sessionId)
		this.seqs.delete(sessionId)
	}
}
