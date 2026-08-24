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

/** Receives lifecycle events for logging. Must not throw. */
export type Observer = (event: string, data: Record<string, unknown>) => void

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
	 * Identifies this queue's seq space. Seqs are in-memory, so a restarted
	 * agent-server hands out seq 1 again while the VM's sandbox survives with a
	 * high-water mark of, say, 12 — the guest would discard every new turn as
	 * already-seen, and the server would ack those turns away on the next
	 * re-dial. Both sides therefore carry this epoch: the guest resets its mark
	 * when it changes, and `ackFrom` refuses an ack minted against a different
	 * one.
	 */
	readonly epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

	/**
	 * Every state change worth reading back during an incident.
	 *
	 * Three wedge diagnoses in a row stalled on the same missing fact: when a
	 * turn was enqueued, was a stream registered, and did the write report
	 * success? Nothing on this path logged anything, so a healthy quiet
	 * conversation and a guest that had silently stopped consuming were
	 * indistinguishable from outside. These events are low volume — a handful
	 * per turn, none while idle — and go to the agent-server's own log, which
	 * survives the VM and needs no guest cooperation to read.
	 */
	constructor(private readonly observe: Observer = () => {}) {}

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
	async registerStream(
		sessionId: string,
		flusher: Flusher,
		after = 0,
		epoch?: string,
	): Promise<() => void> {
		// An ack is only meaningful against the seq space that minted it. A mark
		// carried over from a previous agent-server process names turns this one
		// never sent, so honouring it would delete live turns. Treat it as 0:
		// replay everything and let the guest's own epoch reset dedupe.
		const staleEpoch = epoch !== undefined && epoch !== this.epoch
		const ackedThrough = staleEpoch ? 0 : after
		this.ack(sessionId, ackedThrough)

		// Drain until caught up, THEN register — and never both at once.
		//
		// Registering first would let a turn arriving mid-replay overtake the
		// backlog and reach the CLI out of order. Registering only after a
		// single snapshot pass leaves a window where an arriving turn finds no
		// flusher, is parked, and is never picked up: it was not in the
		// snapshot, so it sits unsent until the next idle re-dial — and if a
		// later turn is delivered live, the VM's ack jumps past it and deletes
		// it outright.
		//
		// So: loop. Each pass sends whatever is newer than what we have sent.
		// The exit check and the `streams.set` below run in the same
		// synchronous step with no await between them, so an enqueue cannot
		// slip into the gap.
		let sentUpTo = ackedThrough
		let replayed = 0
		for (;;) {
			const backlog = (this.unacked.get(sessionId) ?? []).filter((t) => t.seq > sentUpTo)
			if (backlog.length === 0) break
			for (const turn of backlog) {
				if (!(await flusher(turn.line, turn.seq))) {
					// Stream closed mid-replay. Everything stays in `unacked` — it
					// is only ever removed by an ack — so the next connection
					// replays it.
					this.observe('stream replay aborted', {
						sessionId,
						after,
						failedSeq: turn.seq,
						replayed,
					})
					return () => {}
				}
				sentUpTo = turn.seq
				replayed++
			}
		}
		this.streams.set(sessionId, flusher)
		// The guest's `after` is the only proof we ever get that it is alive and
		// consuming. A connection that never re-dials never acks, so a rising
		// `after` here is the signal that the loop is closed; a session whose
		// `after` stays at 0 across dials has a guest that is receiving nothing.
		this.observe('stream registered', {
			sessionId,
			after,
			ackedThrough,
			staleEpoch,
			replayed,
			unacked: this.unacked.get(sessionId)?.length ?? 0,
		})
		// Only delete our own registration: a dead connection's late unregister
		// (heartbeat failure or abort firing after the VM already reconnected)
		// must not tear down the replacement stream's flusher.
		return () => {
			if (this.streams.get(sessionId) === flusher) {
				this.streams.delete(sessionId)
				this.observe('stream unregistered', { sessionId })
			}
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
		if (!flusher) {
			// Parked. Normal between re-dials; a persistent state here means the
			// guest is not holding a stream open at all.
			this.observe('turn parked (no stream)', { sessionId, seq, unacked: turns.length })
			return
		}
		const writeOk = await flusher(line, seq)
		// `writeOk` says the bytes left this process, NOT that the guest read
		// them — that is the whole reason turns are retained. Logged as
		// `written`, never as `delivered`: only a later rising `after` proves
		// delivery, and the gap between the two is exactly where wedges live.
		this.observe('turn written to stream', { sessionId, seq, writeOk, unacked: turns.length })
		if (!writeOk) {
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
		const stranded = this.unacked.get(sessionId)?.length ?? 0
		// Turns still unacked when the session ends were never consumed by the
		// agent. A non-zero count here is a user message that got no reply.
		if (stranded > 0) this.observe('session drained with unacked turns', { sessionId, stranded })
		this.streams.delete(sessionId)
		this.unacked.delete(sessionId)
		this.seqs.delete(sessionId)
	}
}
