#!/usr/bin/env node
/**
 * Carries the agent's output out of the VM.
 *
 * Replaces `log_tee`, which held one long-lived chunked `curl -T -` upload for
 * the life of the session. That upload has the same failure the input side had:
 * these connections terminate on the host at microsandbox's egress proxy, and
 * when the proxy's guest-side leg dies the socket never EOFs and never errors.
 * curl blocks in a write forever, so the reconnect loop wrapped around it can
 * never run.
 *
 * On the output side that failure is worse than losing logs. The agent's reply
 * is only posted to the chat once its `result` event reaches Maskin through
 * this path, so a dead upload means the user sees silence even though the agent
 * answered — and because the reader has stopped draining, the pipe eventually
 * fills and blocks the agent itself. Both wedges of 2026-08-21..24 ended here:
 * turn delivered, reply produced, nothing came back.
 *
 * The fix is structural rather than another timeout. There is no long-lived
 * connection at all. Output accumulates into a buffer, is POSTed in bounded
 * batches, and each batch is only dropped from the buffer once the server
 * answers with the sequence it stored. A request that hangs is abandoned by its
 * own timeout and retried; a request that vanishes into a half-open socket
 * simply never acks, so its lines are sent again. Delivery is proven by a
 * response, never by a successful write — the same contract as input-stream.js,
 * which is the only thing that reliably survives this proxy.
 *
 * stdin is drained continuously and unconditionally. The agent must never block
 * writing, whatever is happening to the network.
 */

const http = require('node:http')
const https = require('node:https')

const AGENT_SERVER_URL = process.env.AGENT_SERVER_URL
const SESSION_ID = process.env.SESSION_ID

const num = (name, fallback) => {
	const raw = Number(process.env[name])
	return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/** How often to ship whatever has accumulated. Matches the old ~2s log cadence. */
const FLUSH_INTERVAL_MS = num('OUTPUT_STREAM_FLUSH_MS', 1_000)
/**
 * Per-request deadline. Every request is bounded, which is what makes the
 * blackhole survivable: a hung POST costs one interval, not the session.
 */
const REQUEST_TIMEOUT_MS = num('OUTPUT_STREAM_TIMEOUT_MS', 20_000)
/** Lines per batch, to keep any single request small enough to retry cheaply. */
const MAX_BATCH_LINES = num('OUTPUT_STREAM_BATCH_LINES', 200)
/**
 * Cap on buffered lines awaiting ack. Reached only when the server has been
 * unreachable for a long time. Dropping output is bad, so this is generous —
 * a wedged session is worth several minutes of retained logs — but unbounded
 * growth in a 4GB VM would eventually kill the agent, which is worse.
 */
const MAX_BUFFERED_LINES = num('OUTPUT_STREAM_MAX_LINES', 20_000)

/**
 * No agent-server: the local Docker path, where container logs are read
 * straight from stdout. Everything below degrades to a passthrough rather than
 * branching the file in two.
 */
const PASSTHROUGH = !AGENT_SERVER_URL || !SESSION_ID

const BATCH_URL = PASSTHROUGH
	? null
	: new URL(`${AGENT_SERVER_URL}/sessions/${SESSION_ID}/logs/batch`)
const client = BATCH_URL?.protocol === 'https:' ? https : http

/** Lines sent but not yet acked, plus lines not yet sent. Ordered by seq. */
let pending = []
let nextSeq = 1
let ackedThrough = 0
let inFlight = false
let stdinEnded = false
let dropped = 0
let consecutiveFailures = 0

const warn = (message) => process.stderr.write(`[system] output-stream: ${message}\n`)

const enqueue = (text) => {
	pending.push({ seq: nextSeq++, text })
	if (pending.length > MAX_BUFFERED_LINES) {
		const lost = pending.length - MAX_BUFFERED_LINES
		// Drop the OLDEST: if the server is unreachable and something must go,
		// the newest output is the part still worth delivering when it returns.
		pending.splice(0, lost)
		dropped += lost
		if (dropped === lost || dropped % 1000 === 0) {
			warn(`buffer full — dropped ${dropped} lines total while unable to reach the server`)
		}
	}
}

const flush = () => {
	if (PASSTHROUGH || inFlight) return
	const batch = pending.filter((l) => l.seq > ackedThrough).slice(0, MAX_BATCH_LINES)
	if (batch.length === 0) {
		if (stdinEnded) finish()
		return
	}
	inFlight = true

	const body = JSON.stringify({
		from: batch[0].seq,
		lines: batch.map((l) => l.text),
	})

	const req = client.request(
		BATCH_URL,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
			timeout: REQUEST_TIMEOUT_MS,
		},
		(res) => {
			let raw = ''
			res.setEncoding('utf8')
			res.on('data', (d) => {
				raw += d
			})
			res.on('end', () => {
				inFlight = false
				if (res.statusCode !== 200) {
					fail(`HTTP ${res.statusCode}`)
					return
				}
				let ack = 0
				try {
					ack = Number(JSON.parse(raw)?.ack) || 0
				} catch {
					fail('unparseable ack')
					return
				}
				// The ack is the contract. Lines are only forgotten once the
				// server says it stored them; anything else is retried.
				if (ack > ackedThrough) {
					ackedThrough = ack
					pending = pending.filter((l) => l.seq > ackedThrough)
				}
				consecutiveFailures = 0
				// Keep going immediately while there is a backlog, so a recovery
				// after an outage is not paced at one batch per interval.
				if (pending.length > 0) flush()
				else if (stdinEnded) finish()
			})
		},
	)

	req.on('timeout', () => req.destroy(new Error('timeout')))
	req.on('error', (err) => {
		inFlight = false
		fail(err?.message === 'timeout' ? 'request timed out' : `request failed: ${err?.message}`)
	})
	req.end(body)
}

const fail = (reason) => {
	consecutiveFailures++
	// First few, then every 30th: an extended outage stays visible without a
	// line per second. Nothing is lost meanwhile — unacked lines are retried.
	if (consecutiveFailures <= 3 || consecutiveFailures % 30 === 0) {
		warn(`${reason} (attempt ${consecutiveFailures}, ${pending.length} lines buffered)`)
	}
	if (stdinEnded && consecutiveFailures >= 20) {
		// The agent is gone and the server has been unreachable for ~7 minutes.
		// Holding the pipeline open past this only delays the session's own
		// completion signal.
		warn(`giving up with ${pending.length} lines undelivered`)
		process.exit(1)
	}
}

let finished = false
const finish = () => {
	if (finished) return
	finished = true
	if (dropped > 0) warn(`finished with ${dropped} lines dropped`)
	process.exit(0)
}

// Read stdin line by line, always. `pipe`-free on purpose: nothing about
// delivery may ever apply backpressure to the agent.
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
	if (PASSTHROUGH) {
		process.stdout.write(chunk)
		return
	}
	buf += chunk
	let nl = buf.indexOf('\n')
	while (nl !== -1) {
		enqueue(buf.slice(0, nl))
		buf = buf.slice(nl + 1)
		nl = buf.indexOf('\n')
	}
})
process.stdin.on('end', () => {
	if (PASSTHROUGH) {
		finish()
		return
	}
	if (buf.length > 0) {
		enqueue(buf)
		buf = ''
	}
	stdinEnded = true
	flush()
})
process.stdin.on('error', () => {
	stdinEnded = true
	flush()
})

setInterval(flush, FLUSH_INTERVAL_MS).unref?.()

// Never die on an unexpected error: this process holds the only path the
// agent's reply has out of the VM, and the pipeline it sits in is what signals
// session completion.
process.on('uncaughtException', (err) => {
	warn(`uncaught error: ${err?.message}`)
	inFlight = false
})

// The interval is unref'd so it cannot by itself keep the process alive; stdin
// does that. This keeps the event loop occupied until finish() runs.
const keepAlive = setInterval(() => {}, 60_000)
process.on('exit', () => clearInterval(keepAlive))
