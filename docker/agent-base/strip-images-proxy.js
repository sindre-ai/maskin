#!/usr/bin/env node
// Local HTTP proxy between the Claude CLI and the model endpoint that swaps
// every image block in a /v1/messages request for a short text note.
//
// Started by agent-run.sh only when MASKIN_STRIP_IMAGES=1, which llm-routing.ts
// sets only for models that cannot read images. Without it, a screenshot tool
// result sent to such a model dies with "400 No endpoints found that support
// image input" and the whole turn is lost. Images are found in user messages
// and inside tool_result content (screenshots, the get_file tool, attachments).
//
// Unlike cdp-retry-proxy.js this is not a byte relay: it reads and rewrites the
// request body, speaks TLS to the upstream, and streams the reply back
// unbuffered. It fails open: anything it cannot safely rewrite is forwarded
// byte for byte.
//
// Usage: node strip-images-proxy.js <localPort> <upstreamBaseUrl>

const http = require('node:http')
const https = require('node:https')

const LISTEN_HOST = '127.0.0.1'
const PLACEHOLDER = '[image omitted: this model cannot read images]'
const MESSAGES_PATH = /\/v1\/messages(\/count_tokens)?$/
const MAX_PARSE_BYTES = 100 * 1024 * 1024

function stripBlocks(blocks) {
	let count = 0
	const out = blocks.map((block) => {
		if (!block || typeof block !== 'object') return block
		if (block.type === 'image') {
			count++
			return { type: 'text', text: PLACEHOLDER }
		}
		if (block.type === 'tool_result' && Array.isArray(block.content)) {
			const inner = stripBlocks(block.content)
			count += inner.count
			return { ...block, content: inner.blocks }
		}
		return block
	})
	return { blocks: out, count }
}

// Returns { payload, count }. count is 0 (and payload the same object) when
// there was nothing to strip.
function stripImages(payload) {
	if (!payload || !Array.isArray(payload.messages)) return { payload, count: 0 }
	let count = 0
	const messages = payload.messages.map((message) => {
		if (!message || !Array.isArray(message.content)) return message
		const stripped = stripBlocks(message.content)
		count += stripped.count
		return { ...message, content: stripped.blocks }
	})
	return count === 0 ? { payload, count: 0 } : { payload: { ...payload, messages }, count }
}

// Body to send upstream: rewritten JSON when it holds images, else the
// original bytes untouched.
function rewriteBody(req, bytes) {
	const pathname = (req.url || '').split('?')[0]
	if (req.method !== 'POST' || !MESSAGES_PATH.test(pathname)) return bytes
	if (req.headers['content-encoding'] || bytes.length > MAX_PARSE_BYTES) return bytes
	try {
		const { payload, count } = stripImages(JSON.parse(bytes.toString('utf8')))
		if (count === 0) return bytes
		console.log(`strip-images-proxy: stripped ${count} image(s)`)
		return Buffer.from(JSON.stringify(payload))
	} catch (err) {
		console.error(`strip-images-proxy: could not parse body, forwarding unchanged: ${err.message}`)
		return bytes
	}
}

function forward(req, res, bytes, target) {
	// Body is fully buffered, so the length is known; drop hop-by-hop framing.
	const { 'transfer-encoding': _te, connection: _conn, ...passthrough } = req.headers
	const headers = { ...passthrough, host: target.host, 'content-length': bytes.length }
	const lib = target.protocol === 'https:' ? https : http
	const upstream = lib.request(
		{
			hostname: target.hostname,
			port: target.port || (target.protocol === 'https:' ? 443 : 80),
			method: req.method,
			path: target.pathname.replace(/\/$/, '') + req.url,
			headers,
		},
		(upstreamRes) => {
			res.writeHead(upstreamRes.statusCode, upstreamRes.headers)
			upstreamRes.on('error', () => res.destroy())
			upstreamRes.pipe(res)
		},
	)
	upstream.on('error', (err) => {
		console.error(`strip-images-proxy: upstream error: ${err.message}`)
		if (res.headersSent) res.destroy()
		else res.writeHead(502).end()
	})
	// The client hung up (user stopped the turn): drop the upstream call too.
	res.on('close', () => {
		if (!res.writableFinished) upstream.destroy()
	})
	upstream.end(bytes)
}

function createProxyServer(upstreamBaseUrl) {
	const target = new URL(upstreamBaseUrl)
	return http.createServer((req, res) => {
		const chunks = []
		req.on('data', (chunk) => chunks.push(chunk))
		req.on('error', () => res.destroy())
		req.on('end', () => {
			try {
				forward(req, res, rewriteBody(req, Buffer.concat(chunks)), target)
			} catch (err) {
				console.error(`strip-images-proxy: request failed: ${err.message}`)
				if (res.headersSent) res.destroy()
				else res.writeHead(502).end()
			}
		})
	})
}

if (require.main === module) {
	const [, , localPortArg, upstreamBaseUrl] = process.argv
	const localPort = Number(localPortArg)
	if (!Number.isInteger(localPort) || !upstreamBaseUrl) {
		console.error(
			'strip-images-proxy: usage: node strip-images-proxy.js <localPort> <upstreamBaseUrl>',
		)
		process.exit(1)
	}
	// A bad connection must never take the proxy down mid-session.
	process.on('uncaughtException', (err) => {
		console.error(`strip-images-proxy: uncaught: ${err.message}`)
	})
	createProxyServer(upstreamBaseUrl).listen(localPort, LISTEN_HOST, () => {
		console.log(`strip-images-proxy: listening on ${LISTEN_HOST}:${localPort}`)
	})
}

module.exports = { PLACEHOLDER, stripImages, createProxyServer }
