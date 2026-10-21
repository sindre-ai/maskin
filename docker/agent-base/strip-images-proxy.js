#!/usr/bin/env node
// Local HTTP proxy between the Claude CLI and the model endpoint that swaps
// every image block in a /v1/messages request for a short text note.
//
// Started by agent-run.sh only when MASKIN_STRIP_IMAGES=1 (set by llm-routing.ts
// only for models that cannot read images) or MASKIN_PROVIDER_PREFS is set (the
// OpenRouter provider exclusions, injected into every request) or MASKIN_TTFT_TIMEOUT_MS is
// set (the time-to-first-token guard below). Without it, a screenshot tool
// result sent to such a model dies with "400 No endpoints found that support
// image input" and the whole turn is lost. Images are found in user messages
// and inside tool_result content (screenshots, the get_file tool, attachments).
//
// This is not a byte relay: it reads and rewrites the
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

// OpenRouter "provider" preferences (e.g. { ignore: ['CoreWeave'] }) from
// MASKIN_PROVIDER_PREFS, merged into each request body because the Claude CLI
// has no way to send them. Anything unparseable is ignored (fail open).
function readProviderPrefs(raw) {
	if (!raw) return null
	try {
		const parsed = JSON.parse(raw)
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
	} catch {
		console.error('strip-images-proxy: MASKIN_PROVIDER_PREFS is not valid JSON, ignoring')
		return null
	}
}

// Body to send upstream: rewritten JSON when it holds images or provider
// preferences are configured, else the original bytes untouched.
function rewriteBody(req, bytes, providerPrefs = null) {
	const pathname = (req.url || '').split('?')[0]
	if (req.method !== 'POST' || !MESSAGES_PATH.test(pathname)) return bytes
	if (req.headers['content-encoding'] || bytes.length > MAX_PARSE_BYTES) return bytes
	try {
		let { payload, count } = stripImages(JSON.parse(bytes.toString('utf8')))
		if (count === 0 && !providerPrefs) return bytes
		if (providerPrefs) payload = { ...payload, provider: { ...payload.provider, ...providerPrefs } }
		if (count > 0) console.log(`strip-images-proxy: stripped ${count} image(s)`)
		return Buffer.from(JSON.stringify(payload))
	} catch (err) {
		console.error(`strip-images-proxy: could not parse body, forwarding unchanged: ${err.message}`)
		return bytes
	}
}

// Time-to-first-token guard, off unless MASKIN_TTFT_TIMEOUT_MS is a positive
// number. A streamed /v1/messages call whose first content event has not
// arrived by then is cancelled and sent again; after attemptsPerProvider tries
// on one provider the next one in provider.only is used. Measured against
// OpenRouter: it sends the response headers and message_start only once the
// provider has produced its first token, so waiting for the first content_block_*
// event is the same moment, and still correct if a gateway sends headers early.
const DEFAULT_ATTEMPTS_PER_PROVIDER = 2

function readTtftConfig(env = process.env) {
	const timeoutMs = Number(env.MASKIN_TTFT_TIMEOUT_MS)
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { timeoutMs: 0, attemptsPerProvider: 0 }
	const per = Number(env.MASKIN_TTFT_ATTEMPTS_PER_PROVIDER)
	return {
		timeoutMs,
		attemptsPerProvider: Number.isInteger(per) && per > 0 ? per : DEFAULT_ATTEMPTS_PER_PROVIDER,
	}
}

// One provider-prefs object per attempt. With two or more providers in
// prefs.only each gets attemptsPerProvider consecutive attempts, pinned with
// only: [p], starting at index `start` so load is spread; with one or none the
// same prefs are tried attemptsPerProvider times.
function buildAttemptPlan(providerPrefs, attemptsPerProvider, start = 0) {
	const only = Array.isArray(providerPrefs?.only) ? providerPrefs.only : []
	if (only.length < 2) return Array.from({ length: attemptsPerProvider }, () => providerPrefs)
	const plan = []
	for (let i = 0; i < only.length; i++) {
		const provider = only[(start + i) % only.length]
		for (let n = 0; n < attemptsPerProvider; n++) plan.push({ ...providerPrefs, only: [provider] })
	}
	return plan
}

function isStreamingMessagesRequest(req, bytes) {
	const pathname = (req.url || '').split('?')[0]
	if (req.method !== 'POST' || !/\/v1\/messages$/.test(pathname)) return false
	if (req.headers['content-encoding']) return false
	try {
		return JSON.parse(bytes.toString('utf8')).stream === true
	} catch {
		return false
	}
}

function upstreamOptions(req, bytes, target) {
	// Body is fully buffered, so the length is known; drop hop-by-hop framing.
	const { 'transfer-encoding': _te, connection: _conn, ...passthrough } = req.headers
	return {
		hostname: target.hostname,
		port: target.port || (target.protocol === 'https:' ? 443 : 80),
		method: req.method,
		path: target.pathname.replace(/\/$/, '') + req.url,
		headers: { ...passthrough, host: target.host, 'content-length': bytes.length },
	}
}

function forward(req, res, bytes, target) {
	const lib = target.protocol === 'https:' ? https : http
	const upstream = lib.request(upstreamOptions(req, bytes, target), (upstreamRes) => {
		res.writeHead(upstreamRes.statusCode, upstreamRes.headers)
		upstreamRes.on('error', () => res.destroy())
		upstreamRes.pipe(res)
	})
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

const FIRST_TOKEN_EVENT = /event: content_block_(start|delta)/
const ERROR_EVENT = /event: error/

// forward() plus the time-to-first-token guard. bodyFor(prefs) is the request
// body to send for one attempt's provider preferences. Every attempt but the last
// is timed; the last is a plain forward(), so a request that is slow on every
// provider (a huge prompt after compaction) is served as it was before the guard
// instead of failing the same way each time.
function forwardGuarded(req, res, bodyFor, plan, target, timeoutMs) {
	const lib = target.protocol === 'https:' ? https : http
	let current = null
	let finished = false

	// The client hung up (user stopped the turn): drop the upstream call and stop retrying.
	res.on('close', () => {
		if (!res.writableFinished) {
			finished = true
			current?.abort()
		}
	})

	function attempt(index) {
		if (finished) return
		const prefs = plan[index]
		const bytes = bodyFor(prefs)
		if (index === plan.length - 1) {
			console.error('strip-images-proxy: last attempt, no first-token timeout')
			return forward(req, res, bytes, target)
		}
		const label = prefs?.only ? ` (provider only=${prefs.only.join(',')})` : ''
		let settled = false
		let upstreamRes = null
		let timer = null

		const upstream = lib.request(upstreamOptions(req, bytes, target), (r) => {
			upstreamRes = r
			// Anything but a 200 event stream is an answer, not a slow start: pass it through.
			if (
				r.statusCode !== 200 ||
				!String(r.headers['content-type']).includes('text/event-stream')
			) {
				return release(Buffer.alloc(0))
			}
			const held = []
			const onData = (chunk) => {
				held.push(chunk)
				const text = Buffer.concat(held).toString('utf8')
				if (FIRST_TOKEN_EVENT.test(text) || ERROR_EVENT.test(text))
					release(Buffer.concat(held), onData)
			}
			r.on('data', onData)
			r.on('end', () => release(Buffer.concat(held), onData))
			// A no-op once settled: release() installs its own error handler.
			r.on('error', () => retry('stream error before first token'))
		})

		function release(head, onData) {
			if (settled || finished) return
			settled = true
			clearTimeout(timer)
			if (onData) upstreamRes.removeListener('data', onData)
			res.writeHead(upstreamRes.statusCode, upstreamRes.headers)
			if (head.length) res.write(head)
			upstreamRes.on('error', () => res.destroy())
			upstreamRes.pipe(res)
		}

		function retry(reason) {
			if (settled || finished) return
			settled = true
			clearTimeout(timer)
			upstream.destroy()
			upstreamRes?.destroy()
			console.error(
				`strip-images-proxy: ${reason} on attempt ${index + 1}/${plan.length}${label}, retrying`,
			)
			attempt(index + 1)
		}

		current = {
			abort: () => {
				settled = true
				clearTimeout(timer)
				upstream.destroy()
				upstreamRes?.destroy()
			},
		}
		timer = setTimeout(() => retry(`no first token within ${timeoutMs}ms`), timeoutMs)
		upstream.on('error', (err) => {
			// Refused or reset before any response: as good as a stall, try the next attempt
			// (the last one is a plain forward(), which answers 502 if it fails too).
			retry(`upstream error before response (${err.message})`)
		})
		upstream.end(bytes)
	}

	attempt(0)
}

function createProxyServer(
	upstreamBaseUrl,
	providerPrefs = readProviderPrefs(process.env.MASKIN_PROVIDER_PREFS),
	ttft = readTtftConfig(),
) {
	const target = new URL(upstreamBaseUrl)
	return http.createServer((req, res) => {
		const chunks = []
		req.on('data', (chunk) => chunks.push(chunk))
		req.on('error', () => res.destroy())
		req.on('end', () => {
			try {
				const bytes = Buffer.concat(chunks)
				if (ttft.timeoutMs > 0 && isStreamingMessagesRequest(req, bytes)) {
					const start = Math.floor(Math.random() * 1000)
					const plan = buildAttemptPlan(providerPrefs, ttft.attemptsPerProvider, start)
					forwardGuarded(
						req,
						res,
						(prefs) => rewriteBody(req, bytes, prefs),
						plan,
						target,
						ttft.timeoutMs,
					)
					return
				}
				forward(req, res, rewriteBody(req, bytes, providerPrefs), target)
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

module.exports = {
	PLACEHOLDER,
	stripImages,
	createProxyServer,
	readTtftConfig,
	buildAttemptPlan,
}
