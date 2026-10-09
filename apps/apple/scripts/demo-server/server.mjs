#!/usr/bin/env node
// A local stand-in for the Maskin API that serves demo data (the Northwind workspace from the
// design prototypes), so the Apple apps can be run in a simulator and screenshotted without a
// backend. Debug builds already point at http://localhost:3000.
//
//   node apps/apple/scripts/demo-server/server.mjs        # listens on :3000
//
// Every route in openapi.json answers with a minimal VALID response built from its schema, so an
// endpoint nobody curated never breaks decoding. The ones the screens show are overridden with
// real-looking data in `fixtures.mjs`.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { overrides } from './fixtures.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const spec = JSON.parse(readFileSync(join(here, '../../openapi.json'), 'utf8'))
const PORT = Number(process.env.PORT ?? 3000)

// ── schema → minimal valid instance ────────────────────────────────────────────────────────────
function deref(node) {
	let n = node
	let guard = 0
	while (n?.$ref && guard++ < 50) {
		n = n.$ref
			.replace(/^#\//, '')
			.split('/')
			.reduce((acc, key) => acc?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], spec)
	}
	return n
}

function sample(schema, depth = 0) {
	const s = deref(schema)
	if (!s || depth > 8) return null
	if (s.enum) return s.enum[0]
	if (s.const !== undefined) return s.const
	if (s.anyOf)
		return sample(s.anyOf.find((x) => deref(x)?.type !== 'null') ?? s.anyOf[0], depth + 1)
	if (s.oneOf) return sample(s.oneOf[0], depth + 1)
	if (s.allOf) return Object.assign({}, ...s.allOf.map((x) => sample(x, depth + 1)))
	const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type
	switch (type) {
		case 'object': {
			const out = {}
			for (const key of s.required ?? []) out[key] = sample(s.properties?.[key] ?? {}, depth + 1)
			return out
		}
		case 'array':
			return []
		case 'string':
			if (s.format === 'date-time') return new Date().toISOString()
			if (s.format === 'uuid') return '00000000-0000-4000-8000-000000000000'
			if (s.format === 'uri' || s.format === 'url') return 'https://maskin.io'
			if (s.format === 'email') return 'demo@example.com'
			return ''
		case 'integer':
		case 'number':
			return s.minimum ?? 0
		case 'boolean':
			return false
		default:
			return null
	}
}

// ── routing ─────────────────────────────────────────────────────────────────────────────────────
const routes = []
for (const [path, item] of Object.entries(spec.paths)) {
	const regex = new RegExp(`^${path.replace(/\{[^}]+\}/g, '([^/]+)')}$`)
	for (const method of Object.keys(item)) routes.push({ path, method, regex, op: item[method] })
}

/** The schema of one item of the response's array (the response itself, or its first array property). */
function firstArrayItemSchema(route) {
	const responses = route.op.responses ?? {}
	const code = Object.keys(responses).find((c) => c.startsWith('2'))
	const top = deref(responses[code]?.content?.['application/json']?.schema)
	if (!top) return null
	if (top.type === 'array') return top.items
	for (const prop of Object.values(top.properties ?? {})) {
		const d = deref(prop)
		if (d?.type === 'array') return d.items
	}
	return null
}

function generic(route) {
	const responses = route.op.responses ?? {}
	const code = Object.keys(responses).find((c) => c.startsWith('2')) ?? '200'
	const content = responses[code]?.content?.['application/json']?.schema
	return { status: Number(code), body: content ? sample(content) : {} }
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
	const method = (req.method ?? 'GET').toLowerCase()
	const chunks = []
	for await (const c of req) chunks.push(c)
	const raw = Buffer.concat(chunks).toString()
	let body
	try {
		body = raw ? JSON.parse(raw) : undefined
	} catch {
		body = undefined
	}

	res.setHeader('Access-Control-Allow-Origin', '*')
	if (process.env.DEMO_LOG) console.log(`${method.toUpperCase()} ${url.pathname}${url.search}`)
	if (url.pathname === '/api/health') return json(res, 200, { status: 'ok' })
	// The live event stream: held open and silent, which is what an idle workspace looks like.
	if (url.pathname === '/api/events' && method === 'get') {
		res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
		res.write(': demo\n\n')
		return
	}

	const route = routes.find((r) => r.method === method && r.regex.test(url.pathname))
	const params = route ? (url.pathname.match(route.regex) ?? []).slice(1) : []
	// What the curated fixtures build on: a minimal valid body for this route, and one minimal item
	// of the first array in it, so a fixture only states the fields it wants to show.
	const base = route ? generic(route).body : null
	const arrayProp =
		base && !Array.isArray(base) ? Object.keys(base).find((k) => Array.isArray(base[k])) : null
	const itemSchema = route ? firstArrayItemSchema(route) : null
	const custom = overrides({
		method,
		path: url.pathname,
		query: url.searchParams,
		params,
		body,
		base,
		arrayProp,
		item: itemSchema ? sample(itemSchema) : {},
	})
	if (custom) return json(res, custom.status ?? 200, custom.body)
	if (!route)
		return json(res, 404, { error: { code: 'NOT_FOUND', message: 'demo: no such route' } })
	const out = generic(route)
	console.log(`generic ${method.toUpperCase()} ${url.pathname}`)
	return json(res, out.status, out.body)
})

function json(res, status, body) {
	res.writeHead(status, { 'Content-Type': 'application/json' })
	res.end(JSON.stringify(body))
}

server.listen(PORT, () => console.log(`Maskin demo API on http://localhost:${PORT}`))
