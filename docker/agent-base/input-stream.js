#!/usr/bin/env node
/**
 * Feeds interactive user turns to the CLI's stdin.
 *
 * Replaces the `curl | claude` pipe this used to be. Two things curl could not
 * do, both of which caused production chat wedges:
 *
 * 1. ACK THE TURNS IT CONSUMED. The agent-server cannot tell whether a turn it
 *    wrote actually arrived: these connections terminate on the host at
 *    microsandbox's egress proxy, and when the proxy's guest-side leg dies the
 *    host keeps ACKing writes into a socket the guest never reads. Turns are
 *    therefore retained server-side until we confirm them. This process tracks
 *    the highest seq it has written to stdout and sends it as `?after=` on
 *    every reconnect, which acknowledges those and asks for anything since.
 *    A turn lost to a blackholed socket is redelivered instead of destroyed.
 *
 * 2. NOTICE A CONNECTION THAT WENT QUIET. A blackholed socket never EOFs and
 *    never errors, so curl blocked on it forever and the reconnect loop around
 *    it could not run. The server sends a newline every 30s; if nothing at all
 *    arrives for IDLE_TIMEOUT_MS we treat the connection as dead and re-dial.
 *
 * stdout carries ONLY the inner NDJSON turn envelopes — it is the CLI's stdin.
 * Everything else (status, errors) goes to stderr.
 */

const http = require('node:http')
const https = require('node:https')

const AGENT_SERVER_URL = process.env.AGENT_SERVER_URL
const SESSION_ID = process.env.SESSION_ID

if (!AGENT_SERVER_URL || !SESSION_ID) {
	process.stderr.write('[system] input-stream: AGENT_SERVER_URL or SESSION_ID unset; exiting\n')
	process.exit(1)
}

/**
 * Three missed 30s heartbeats. Long enough that ordinary jitter or a slow
 * host never trips it, short enough that a wedged conversation recovers in
 * well under the time a human waits before assuming the agent is broken.
 */
const num = (name, fallback) => {
	const raw = Number(process.env[name])
	return Number.isFinite(raw) && raw > 0 ? raw : fallback
}
const IDLE_TIMEOUT_MS = num('INPUT_STREAM_IDLE_TIMEOUT_MS', 90_000)
const RECONNECT_DELAY_MS = num('INPUT_STREAM_RECONNECT_DELAY_MS', 1_000)

/**
 * Highest seq written to stdout. This is the ack, and it must only ever
 * advance after the write, never before — claiming a turn we then failed to
 * deliver would let the server forget it.
 */
let lastSeq = 0
let consecutiveFailures = 0
/**
 * Which server seq space `lastSeq` belongs to. Seqs live in the agent-server's
 * memory, so a restart hands out seq 1 again while this process is still
 * holding a mark of, say, 12 — without this, every new turn would look like an
 * already-seen replay and be discarded forever.
 */
let epoch = null

const connect = () => {
	const url = new URL(`${AGENT_SERVER_URL}/sessions/${SESSION_ID}/input/stream`)
	url.searchParams.set('after', String(lastSeq))
	if (epoch !== null) url.searchParams.set('epoch', epoch)
	const client = url.protocol === 'https:' ? https : http

	let gotResponse = false

	const req = client.get(url, { headers: { Accept: 'application/x-ndjson' } }, (res) => {
		gotResponse = true
		if (res.statusCode !== 200) {
			// Drain so the socket can be reused/closed cleanly, then retry. An
			// HTTP error body must never reach stdout: the CLI would try to
			// parse an HTML/JSON error page as a user turn.
			res.resume()
			fail(`HTTP ${res.statusCode}`)
			return
		}
		consecutiveFailures = 0
		res.setEncoding('utf8')

		let buf = ''
		res.on('data', (chunk) => {
			buf += chunk
			let nl = buf.indexOf('\n')
			while (nl !== -1) {
				const line = buf.slice(0, nl)
				buf = buf.slice(nl + 1)
				handleLine(line)
				nl = buf.indexOf('\n')
			}
		})
		res.on('end', () => retry())
		res.on('error', () => retry())
	})

	// Socket-level inactivity, armed before the response arrives on purpose.
	// A connection can be blackholed before its headers ever reach us — the
	// proxy accepts the TCP handshake and then delivers nothing — and a timer
	// armed only in the response callback would never fire for that case,
	// leaving us blocked exactly as curl was. Incoming bytes (turns, or the
	// server's 30s heartbeat) reset this automatically.
	req.setTimeout(IDLE_TIMEOUT_MS, () => req.destroy(new Error('idle')))

	req.on('error', (err) => {
		// Includes our own idle destroy — the whole point is that this path is
		// now reachable at all.
		const idled = err?.message === 'idle'
		if (idled && gotResponse) {
			// A healthy connection that went quiet. Expected on any conversation
			// where nobody types for a few minutes, and the re-dial is silent and
			// lossless, so this is not worth a line in the user's transcript.
			consecutiveFailures = 0
			retry()
			return
		}
		// Idling out with no response at all is the blackhole signature — the
		// socket connected and never delivered a byte. Worth reporting.
		fail(idled ? 'no response' : `connect error: ${err?.message}`)
	})
}

const handleLine = (line) => {
	// Heartbeats are bare newlines and arrive here as empty strings. They exist
	// to reset the idle timer (already done by the caller) and carry no turn.
	if (line.trim() === '') return

	let parsed
	try {
		parsed = JSON.parse(line)
	} catch {
		process.stderr.write('[system] input-stream: dropping unparseable line\n')
		return
	}
	if (typeof parsed.turn !== 'string' || typeof parsed.maskin_seq !== 'number') {
		process.stderr.write('[system] input-stream: dropping line with no turn/seq\n')
		return
	}

	// A new seq space (agent-server restarted). Our mark names turns this
	// server never sent, so it is meaningless — reset and take what it gives us.
	if (parsed.maskin_epoch !== undefined && parsed.maskin_epoch !== epoch) {
		if (epoch !== null) {
			process.stderr.write('[system] input stream: agent-server restarted, resyncing turns\n')
		}
		epoch = parsed.maskin_epoch
		lastSeq = 0
	}

	// Already consumed on an earlier connection — the server replays anything
	// it has not seen acked, which after a lost ack can include turns we did
	// deliver. Skipping them keeps redelivery from duplicating a user message.
	// Within one epoch a seq can only repeat as a genuine replay, so this is
	// expected and silent; a regression across epochs is handled above.
	if (parsed.maskin_seq <= lastSeq) return

	// Write the envelope through verbatim: these are the exact bytes apps/dev
	// put on the wire, and the CLI's stdin parser must see them unaltered.
	process.stdout.write(`${parsed.turn}\n`)
	lastSeq = parsed.maskin_seq
}

const fail = (reason) => {
	consecutiveFailures++
	// First few and then every 30th: a permanently misrouted endpoint stays
	// visible without a line per second in the session transcript. An idle
	// timeout during a normal quiet conversation is expected and unremarkable,
	// so it is reported only if it keeps happening.
	if (consecutiveFailures <= 3 || consecutiveFailures % 30 === 0) {
		process.stderr.write(
			`[system] input stream reconnecting (${reason}, attempt ${consecutiveFailures})\n`,
		)
	}
	retry()
}

let retrying = false
const retry = () => {
	// end/error/idle can all fire for one dead connection; only re-dial once.
	if (retrying) return
	retrying = true
	setTimeout(() => {
		retrying = false
		connect()
	}, RECONNECT_DELAY_MS)
}

// Our stdout IS the CLI's stdin. Once the CLI is gone that pipe is broken, and
// staying alive is actively destructive: every write fails, yet `lastSeq` keeps
// advancing and the next re-dial acks those turns away. That is the original
// bug — a "delivery" that delivers nothing — rebuilt on the guest side. So a
// dead pipe is terminal, and we exit and let the session tear down.
//
// This is the exception to "never exit": the no-exit rule exists to protect a
// LIVE CLI from an EOF on its stdin. There is nothing left to protect here.
process.stdout.on('error', (err) => {
	process.stderr.write(`[system] input stream: stdout closed (${err?.code ?? err?.message})\n`)
	process.exit(1)
})

// Anything else: keep the CLI's stdin open — closing it mid-conversation EOFs
// the agent and wedges the session for good — and retry.
process.on('uncaughtException', (err) => {
	if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') {
		process.stderr.write(`[system] input stream: stdout closed (${err.code})\n`)
		process.exit(1)
	}
	process.stderr.write(`[system] input-stream: ${err?.message}\n`)
	retry()
})

connect()
