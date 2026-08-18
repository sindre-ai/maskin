#!/usr/bin/env node
// Polls this guest's own listening TCP sockets for dev servers the agent
// starts on its own (e.g. `pnpm dev`, `vite`), and asks agent-server to open
// an on-demand relay for each one it finds — see POST
// /sessions/:id/preview-ports in apps/agent-server/src/index.ts. Removes the
// need to declare previewGuestPorts upfront in create_session: any port the
// agent's own process opens within the range below is picked up automatically.
//
// Results are written to PREVIEW_PORTS_FILE, which a PostToolUse hook (see
// docker/agent-base/hooks/preview-ports-changed.sh) reads after every tool
// call and surfaces to Claude as additionalContext the first time a mapping
// appears — the agent never has to know to poll this file itself.
//
// Requires AGENT_SERVER_URL, SESSION_ID, and BROWSER_CDP_URL to be set (the
// caller in agent-run.sh only starts this when all three are present).

const fs = require('node:fs/promises')

const AGENT_SERVER_URL = process.env.AGENT_SERVER_URL
const SESSION_ID = process.env.SESSION_ID
// Lives directly under /agent, not inside /agent/workspace, so it never
// shows up in `git status`/`git add -A` inside the agent's own checkout —
// see docker/agent-base/hooks/preview-ports-changed.sh, which reads the same
// path.
const PREVIEW_PORTS_FILE = process.env.PREVIEW_PORTS_FILE || '/agent/.preview-ports.json'

// Must match DEV_SERVER_HOST_PORT_RANGE_START/END in
// apps/agent-server/src/services/microsandbox.ts — that's the only range the
// browser sidecar's standing allow@host:tcp grant actually covers, and the
// agent-server endpoint rejects anything outside it anyway. Kept as a
// separate literal (not fetched from the server) so this script has no
// startup dependency beyond AGENT_SERVER_URL being reachable.
const RANGE_START = 3000
const RANGE_END = 12000

const POLL_INTERVAL_MS = 2_000
const MAX_ATTEMPTS_PER_PORT = 10

if (!AGENT_SERVER_URL || !SESSION_ID) {
	process.stderr.write('[preview-port-watcher] AGENT_SERVER_URL/SESSION_ID not set, exiting\n')
	process.exit(0)
}

// This process is launched detached (`node preview-port-watcher.js &`, see
// agent-run.sh's start_preview_port_watcher) with its stdout/stderr piped to
// /tmp/preview-port-watcher.log INSIDE the guest VM — a file nothing ships
// anywhere and that's destroyed with the VM at session end. Without also
// shipping these lines to the same log-ingest endpoint the main agent
// process streams through, a session where the whole relay pipeline never
// works (agent-server unreachable, every request rejected, ...) leaves zero
// operator-visible trace. log() below does both: local stderr (still useful
// for anyone who execs into a live container) AND a best-effort POST to
// /sessions/:id/logs/ingest, so these lines show up in the Maskin UI like
// any other session output.
const LOG_INGEST_URL = `${AGENT_SERVER_URL}/sessions/${SESSION_ID}/logs/ingest`

function log(line) {
	const withPrefix = `[preview-port-watcher] ${line}`
	process.stderr.write(`${withPrefix}\n`)
	// Fire-and-forget — log-ingest is best-effort by design (see agent-run.sh's
	// log_tee), and a failed log POST must never block or crash the watcher
	// loop itself.
	fetch(LOG_INGEST_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'text/plain' },
		body: `${withPrefix}\n`,
		signal: AbortSignal.timeout(5_000),
	}).catch(() => {})
}

// guestPort -> previewUrl for ports we've successfully relayed this session.
const relayed = new Map()
// guestPort -> attempt count, for ports seen listening but not yet relayed.
const attempts = new Map()
// Ports that have exhausted MAX_ATTEMPTS_PER_PORT — tracked so the give-up
// message below is logged exactly once per port instead of on every
// subsequent tick.
const gaveUp = new Set()
// Ports with a requestRelay() call currently awaiting a response — guards
// against tick() (every POLL_INTERVAL_MS) re-firing a request for a port
// whose previous request hasn't resolved yet. establishPreviewPortRelay on
// the server involves several sequential awaits (port resolution, spawning
// ssh, polling TCP readiness) that can easily exceed POLL_INTERVAL_MS, so
// without this guard two concurrent requests for the same port are the
// expected steady-state behavior, not a rare edge case — and each one can
// open its own relay, wasting a slot out of the fixed RANGE_START-RANGE_END
// range. The server also coalesces concurrent requests for the same port
// (see SessionPreviewState.pendingRelays in apps/agent-server/src/index.ts)
// as defense in depth, but fixing it here avoids the redundant HTTP round
// trips in the first place.
const inFlight = new Set()

async function listListeningPorts() {
	const ports = new Set()
	for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
		let content
		try {
			content = await fs.readFile(path, 'utf8')
		} catch {
			continue // e.g. IPv6 disabled — just skip that table
		}
		const lines = content.split('\n').slice(1) // header row
		for (const line of lines) {
			const fields = line.trim().split(/\s+/)
			if (fields.length < 4) continue
			const [, localAddress, , state] = fields
			if (state !== '0A') continue // 0A = TCP_LISTEN
			const hexPort = localAddress.split(':')[1]
			if (!hexPort) continue
			const port = Number.parseInt(hexPort, 16)
			if (Number.isFinite(port) && port >= RANGE_START && port <= RANGE_END) {
				ports.add(port)
			}
		}
	}
	return ports
}

async function persistMappings() {
	const obj = Object.fromEntries(relayed)
	try {
		await fs.writeFile(PREVIEW_PORTS_FILE, JSON.stringify(obj, null, 2), 'utf8')
	} catch (err) {
		log(`failed to write ${PREVIEW_PORTS_FILE}: ${err}`)
	}
}

async function requestRelay(guestPort) {
	try {
		const res = await fetch(`${AGENT_SERVER_URL}/sessions/${SESSION_ID}/preview-ports`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ guestPort }),
			signal: AbortSignal.timeout(10_000),
		})
		if (!res.ok) {
			log(`relay request for port ${guestPort} failed: HTTP ${res.status}`)
			return
		}
		const body = await res.json()
		if (typeof body.previewUrl !== 'string') return
		relayed.set(guestPort, body.previewUrl)
		attempts.delete(guestPort)
		await persistMappings()
		log(`relayed port ${guestPort} -> ${body.previewUrl}`)
	} catch (err) {
		log(`relay request for port ${guestPort} errored: ${err}`)
	} finally {
		inFlight.delete(guestPort)
	}
}

async function tick() {
	let listening
	try {
		listening = await listListeningPorts()
	} catch (err) {
		log(`failed to read /proc/net/tcp*: ${err}`)
		return
	}
	for (const port of listening) {
		if (relayed.has(port) || inFlight.has(port)) continue
		const attemptCount = attempts.get(port) ?? 0
		if (attemptCount >= MAX_ATTEMPTS_PER_PORT) {
			// The port's final attempt has already resolved (it's not in
			// `inFlight`, checked above) and didn't succeed (it's not in
			// `relayed`, also checked above) — this is genuinely the give-up
			// point, not a guess made before the outcome is known.
			if (!gaveUp.has(port)) {
				gaveUp.add(port)
				log(`giving up on port ${port} after ${MAX_ATTEMPTS_PER_PORT} attempts`)
			}
			continue
		}
		attempts.set(port, attemptCount + 1)
		inFlight.add(port)
		void requestRelay(port)
	}
}

async function main() {
	// Pre-create an empty mappings file so the PostToolUse hook reading it has
	// something to diff against from session start (entrypoint.sh already does
	// this before the agent user's process tree starts, but guard here too in
	// case this script ever runs standalone).
	await fs.writeFile(PREVIEW_PORTS_FILE, '{}', { flag: 'wx' }).catch(() => {})
	for (;;) {
		await tick()
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
	}
}

main()
