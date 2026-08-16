#!/usr/bin/env node
// Local TCP proxy that sits between @playwright/mcp's CDP client and the real
// browser-sidecar CDP endpoint, retrying the initial connection (the
// /json/version discovery request, or the WebSocket upgrade handshake) with
// backoff when the upstream connection resets before completing.
//
// @playwright/mcp's own CDP client gives up immediately on a single
// ECONNRESET (see "async initializeServer: write/read ECONNRESET" in agent
// session logs) — msb's guest<->host networking has been observed to
// intermittently reset a session VM's very first connection attempt to the
// sidecar. This proxy is the retry layer @playwright/mcp doesn't have: it
// buffers only the initial request head (a client never sends a body on
// either the discovery GET or the WS upgrade request), so a reset before a
// response is fully received can be retried by opening a fresh upstream
// connection and resending the same buffered bytes. Once a response head (or
// the WS 101 Switching Protocols upgrade) has been relayed back to the
// client, retrying is no longer possible without corrupting an in-flight
// exchange, so the proxy falls back to a plain byte-for-byte relay for the
// rest of that connection's lifetime — the same point host-rewrite-proxy.py
// (docker/browser-sidecar) stops rewriting and starts relaying raw.
//
// Usage: node cdp-retry-proxy.js <localPort> <targetHost> <targetPort>

const net = require('node:net')

const LISTEN_HOST = '127.0.0.1'
const MAX_ATTEMPTS = 5
const RETRY_DELAYS_MS = [100, 250, 500, 1000, 2000]
const HEAD_READ_TIMEOUT_MS = 5_000

const [, , localPortArg, targetHost, targetPortArg] = process.argv
const localPort = Number(localPortArg)
const targetPort = Number(targetPortArg)
if (!Number.isInteger(localPort) || !targetHost || !Number.isInteger(targetPort)) {
	console.error(
		'cdp-retry-proxy: usage: node cdp-retry-proxy.js <localPort> <targetHost> <targetPort>',
	)
	process.exit(1)
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

// Reads from `client` until the blank line ending the HTTP header block, or
// the timeout elapses. Returns the accumulated bytes (header block only —
// callers here never see a request body, since both the discovery GET and
// the WS upgrade request are header-only).
function readRequestHead(client) {
	return new Promise((resolve, reject) => {
		let buf = Buffer.alloc(0)
		const timer = setTimeout(() => {
			cleanup()
			reject(new Error('timed out reading request head'))
		}, HEAD_READ_TIMEOUT_MS)
		function onData(chunk) {
			buf = Buffer.concat([buf, chunk])
			if (buf.includes('\r\n\r\n')) {
				cleanup()
				resolve(buf)
			}
		}
		function onClose() {
			cleanup()
			reject(new Error('client closed before sending a full request head'))
		}
		function cleanup() {
			clearTimeout(timer)
			client.off('data', onData)
			client.off('close', onClose)
			client.off('error', onClose)
		}
		client.on('data', onData)
		client.on('close', onClose)
		client.on('error', onClose)
	})
}

// Try to connect to upstream and write `head`, then wait for the first byte
// of a response. Resolves with the connected socket (with `head`'s response
// bytes already buffered — see the 'data' listener removal) on success;
// rejects on any connect/write/reset error before a response byte arrives.
function attemptUpstream(head) {
	return new Promise((resolve, reject) => {
		const upstream = net.connect(targetPort, targetHost)
		let settled = false
		let firstChunk = null
		function fail(err) {
			if (settled) return
			settled = true
			upstream.destroy()
			reject(err)
		}
		upstream.on('error', fail)
		upstream.on('close', () => {
			if (!settled) fail(new Error('upstream closed before responding'))
		})
		upstream.on('connect', () => {
			upstream.write(head)
		})
		upstream.once('data', (chunk) => {
			if (settled) return
			settled = true
			firstChunk = chunk
			upstream.off('error', fail)
			resolve({ upstream, firstChunk })
		})
	})
}

async function connectWithRetry(head) {
	let lastErr
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		try {
			return await attemptUpstream(head)
		} catch (err) {
			lastErr = err
			const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS.at(-1)
			console.error(
				`cdp-retry-proxy: attempt ${attempt + 1}/${MAX_ATTEMPTS} failed (${err.message}), retrying in ${delay}ms`,
			)
			await sleep(delay)
		}
	}
	throw lastErr
}

function relay(a, b) {
	a.pipe(b)
	b.pipe(a)
	const closeBoth = () => {
		a.destroy()
		b.destroy()
	}
	a.on('close', closeBoth)
	b.on('close', closeBoth)
	a.on('error', closeBoth)
	b.on('error', closeBoth)
}

const server = net.createServer(async (client) => {
	let head
	try {
		head = await readRequestHead(client)
	} catch (err) {
		console.error(`cdp-retry-proxy: ${err.message}`)
		client.destroy()
		return
	}

	let upstream
	let firstChunk
	try {
		;({ upstream, firstChunk } = await connectWithRetry(head))
	} catch (err) {
		console.error(`cdp-retry-proxy: giving up after ${MAX_ATTEMPTS} attempts: ${err.message}`)
		client.destroy()
		return
	}

	client.write(firstChunk)
	relay(client, upstream)
})

server.on('error', (err) => {
	console.error(`cdp-retry-proxy: server error: ${err.message}`)
	process.exit(1)
})

server.listen(localPort, LISTEN_HOST, () => {
	console.log(
		`cdp-retry-proxy: listening on ${LISTEN_HOST}:${localPort}, forwarding to ${targetHost}:${targetPort}`,
	)
})
