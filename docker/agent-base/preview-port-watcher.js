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

// guestPort -> previewUrl for ports we've successfully relayed this session.
const relayed = new Map()
// guestPort -> attempt count, for ports seen listening but not yet relayed.
const attempts = new Map()

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
		process.stderr.write(`[preview-port-watcher] failed to write ${PREVIEW_PORTS_FILE}: ${err}\n`)
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
			process.stderr.write(
				`[preview-port-watcher] relay request for port ${guestPort} failed: HTTP ${res.status}\n`,
			)
			return
		}
		const body = await res.json()
		if (typeof body.previewUrl !== 'string') return
		relayed.set(guestPort, body.previewUrl)
		attempts.delete(guestPort)
		await persistMappings()
		process.stderr.write(`[preview-port-watcher] relayed port ${guestPort} -> ${body.previewUrl}\n`)
	} catch (err) {
		process.stderr.write(
			`[preview-port-watcher] relay request for port ${guestPort} errored: ${err}\n`,
		)
	}
}

async function tick() {
	let listening
	try {
		listening = await listListeningPorts()
	} catch (err) {
		process.stderr.write(`[preview-port-watcher] failed to read /proc/net/tcp*: ${err}\n`)
		return
	}
	for (const port of listening) {
		if (relayed.has(port)) continue
		const attemptCount = attempts.get(port) ?? 0
		if (attemptCount >= MAX_ATTEMPTS_PER_PORT) continue
		attempts.set(port, attemptCount + 1)
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
