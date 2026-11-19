#!/usr/bin/env node
// On-demand tool loading for routes whose model has no tool search (the
// Maskin-funded DeepSeek route). Claude Code sends every MCP tool's full
// definition in each request; here only the names are sent, plus one small
// tool, load_tool, that the agent calls to bring the definitions it needs.
//
// Two halves in one file, so the image copies one script:
//
//   applyToolLoader(payload)  used by strip-images-proxy.js on each /v1/messages
//                             request. Drops the definitions of MCP tools the agent
//                             has not asked for, keeps the rest of the request as
//                             it was, and writes the catalog (name + one line) to
//                             a file for the loader to read.
//   node tool-loader.js mcp   the stdio MCP server that holds load_tool. agent-run.sh
//                             adds it to the session's MCP config.
//
// Why no state is kept: the request carries the whole conversation, so "what has
// been loaded" is read off the load_tool calls already in it. A tool the agent
// used without loading it (it guessed a name from the list) counts as loaded, so
// the next request shows it the real definition.
//
// Fails open: when the request has no load_tool (the MCP server did not start)
// or cannot be read, it is forwarded untouched, so the agent still has every tool.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SERVER_NAME = 'toolloader'
const TOOL_NAME = 'load_tool'
const LOADER_TOOL = `mcp__${SERVER_NAME}__${TOOL_NAME}`
const MCP_PREFIX = 'mcp__'
const MAX_SEARCH_RESULTS = 15
const ONE_LINE_MAX = 140

function catalogPath(env = process.env) {
	return env.MASKIN_TOOL_CATALOG_FILE || path.join(env.TMPDIR || os.tmpdir(), 'tool-catalog.json')
}

function oneLine(text) {
	const line = String(text ?? '')
		.replace(/\s+/g, ' ')
		.trim()
	return line.length > ONE_LINE_MAX ? `${line.slice(0, ONE_LINE_MAX - 1)}…` : line
}

// "mcp__github__create_branch" -> { server: "mcp__github__", tool: "create_branch" }.
// The server key may itself hold single underscores, never a double one.
function splitName(name) {
	const cut = name.indexOf('__', MCP_PREFIX.length)
	if (cut === -1) return { server: MCP_PREFIX, tool: name.slice(MCP_PREFIX.length) }
	return { server: name.slice(0, cut + 2), tool: name.slice(cut + 2) }
}

// Names in the loader's own description, grouped by server so the shared prefix
// is written once: "mcp__github__: create_branch, get_file_contents".
function listNames(names) {
	const groups = new Map()
	for (const name of names) {
		const { server, tool } = splitName(name)
		if (!groups.has(server)) groups.set(server, [])
		groups.get(server).push(tool)
	}
	return [...groups].map(([server, tools]) => `${server}: ${tools.join(', ')}`).join('\n')
}

const LOADER_DESCRIPTION =
	'Loads tools that are listed by name only. Most MCP tools are not loaded at the start of a session to keep it small. ' +
	'To use one, call this tool with its exact full name in names (several at once is fine); ' +
	'its full definition is available on your next step, and then you call it as usual. ' +
	'If you do not know the name, pass a query (a word or two) and you get the matching names with one line each. ' +
	'Not loaded yet, by server prefix (full name = prefix + name):\n'

const SYSTEM_NOTE =
	`Most MCP tools are listed by name only in the description of ${LOADER_TOOL}. ` +
	`Before using one, call ${LOADER_TOOL} with its exact full name, then call the tool on your next step.`

// Tool names the assistant has already called, in the order first seen: the ones
// asked for through load_tool, and any other MCP tool used directly.
function loadedFromHistory(messages) {
	const loaded = []
	const add = (name) => {
		if (typeof name === 'string' && !loaded.includes(name)) loaded.push(name)
	}
	for (const message of Array.isArray(messages) ? messages : []) {
		if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
		for (const block of message.content) {
			if (block?.type !== 'tool_use' || typeof block.name !== 'string') continue
			if (block.name === LOADER_TOOL) {
				const names = block.input?.names
				if (Array.isArray(names)) for (const name of names) add(name)
			} else if (block.name.startsWith(MCP_PREFIX)) {
				add(block.name)
			}
		}
	}
	return loaded
}

function withNote(system) {
	if (typeof system === 'string') return system ? `${system}\n\n${SYSTEM_NOTE}` : SYSTEM_NOTE
	if (Array.isArray(system)) return [...system, { type: 'text', text: SYSTEM_NOTE }]
	return SYSTEM_NOTE
}

let lastLogged = ''
let lastCatalog = ''

function writeCatalog(file, entries) {
	const json = JSON.stringify(entries)
	if (json === lastCatalog && fs.existsSync(file)) return
	const tmp = `${file}.${process.pid}.tmp`
	fs.writeFileSync(tmp, json)
	fs.renameSync(tmp, file)
	lastCatalog = json
}

// Returns the payload to send. The same object when nothing was changed.
function applyToolLoader(payload, { file = catalogPath(), log = console.log } = {}) {
	if (!payload || !Array.isArray(payload.tools)) return payload
	const loader = payload.tools.find((tool) => tool?.name === LOADER_TOOL)
	if (!loader) return payload

	const deferred = payload.tools.filter(
		(tool) => typeof tool?.name === 'string' && tool.name.startsWith(MCP_PREFIX) && tool !== loader,
	)
	if (deferred.length === 0) return payload

	const byName = new Map(deferred.map((tool) => [tool.name, tool]))
	const loaded = loadedFromHistory(payload.messages).filter((name) => byName.has(name))

	writeCatalog(
		file,
		deferred.map((tool) => ({ name: tool.name, description: oneLine(tool.description) })),
	)

	// Stable order for the cache: everything that never changes first (the CLI's
	// own tools, then the loader with its fixed name list), then loaded tools in
	// the order they were asked for. A new load only appends.
	const deferredSet = new Set(deferred)
	const tools = [
		...payload.tools.filter((tool) => tool !== loader && !deferredSet.has(tool)),
		{ ...loader, description: LOADER_DESCRIPTION + listNames(deferred.map((tool) => tool.name)) },
		...loaded.map((name) => byName.get(name)),
	]

	const signature = `${payload.tools.length}/${loaded.length}`
	if (signature !== lastLogged) {
		lastLogged = signature
		log(
			`tool-loader: tools_before=${payload.tools.length} tools_sent_in_full=${tools.length - 1} tools_by_name_only=${deferred.length - loaded.length} loaded_on_request=${loaded.length}`,
		)
	}
	return { ...payload, tools, system: withNote(payload.system) }
}

function readCatalog(file) {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
		return Array.isArray(parsed) ? parsed : []
	} catch {
		return []
	}
}

function search(catalog, query) {
	const words = String(query).toLowerCase().split(/\W+/).filter(Boolean)
	if (words.length === 0) return []
	return catalog
		.map((entry) => {
			const haystack = `${entry.name} ${entry.description}`.toLowerCase()
			return { entry, score: words.filter((word) => haystack.includes(word)).length }
		})
		.filter((hit) => hit.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, MAX_SEARCH_RESULTS)
		.map((hit) => hit.entry)
}

// The text load_tool returns. `names` are loaded by exact name; `query` searches.
function runLoadTool(args, file = catalogPath()) {
	const catalog = readCatalog(file)
	if (catalog.length === 0) return 'No tool list is available yet. Try again on your next step.'
	const known = new Set(catalog.map((entry) => entry.name))
	const names = Array.isArray(args?.names) ? args.names.filter((n) => typeof n === 'string') : []
	const lines = []
	const found = names.filter((name) => known.has(name))
	const missing = names.filter((name) => !known.has(name))
	if (found.length > 0) {
		lines.push(
			`Loaded: ${found.join(', ')}. Their full definitions are available on your next step; call them then.`,
		)
	}
	for (const name of missing) {
		const close = search(catalog, name.replace(/^mcp__/, '').replace(/__/g, ' ')).slice(0, 5)
		lines.push(
			`No tool named ${name}.${close.length ? ` Closest: ${close.map((e) => e.name).join(', ')}.` : ''}`,
		)
	}
	if (typeof args?.query === 'string' && args.query.trim()) {
		const hits = search(catalog, args.query)
		lines.push(
			hits.length
				? `Matches for "${args.query.trim()}" (call load_tool with the names you want):\n${hits.map((e) => `${e.name}: ${e.description}`).join('\n')}`
				: `No tool matches "${args.query.trim()}".`,
		)
	}
	if (lines.length === 0)
		return 'Pass names (exact tool names to load) or a query (words to search for).'
	return lines.join('\n')
}

const INPUT_SCHEMA = {
	type: 'object',
	properties: {
		names: {
			type: 'array',
			items: { type: 'string' },
			description: 'Exact full tool names to load, e.g. mcp__github__create_branch',
		},
		query: { type: 'string', description: 'Words to search tool names and descriptions for' },
	},
}

// Minimal MCP server over stdio (newline-delimited JSON-RPC), enough for the CLI:
// initialize, tools/list, tools/call. Plain node, so the image needs no package.
function serveMcp(input = process.stdin, output = process.stdout) {
	const send = (message) => output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
	const handle = (request) => {
		const { id, method, params } = request
		if (method === 'initialize') {
			return send({
				id,
				result: {
					protocolVersion: params?.protocolVersion || '2024-11-05',
					capabilities: { tools: {} },
					serverInfo: { name: SERVER_NAME, version: '1.0.0' },
				},
			})
		}
		if (method === 'tools/list') {
			return send({
				id,
				result: {
					tools: [
						{
							name: TOOL_NAME,
							description:
								'Load MCP tools that are listed by name only, or search for them by a word.',
							inputSchema: INPUT_SCHEMA,
						},
					],
				},
			})
		}
		if (method === 'tools/call') {
			if (params?.name !== TOOL_NAME) {
				return send({ id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } })
			}
			return send({
				id,
				result: { content: [{ type: 'text', text: runLoadTool(params.arguments) }] },
			})
		}
		if (method === 'ping') return send({ id, result: {} })
		// Notifications (no id) need no reply; an unknown request does.
		if (id !== undefined)
			send({ id, error: { code: -32601, message: `Unknown method: ${method}` } })
	}
	let buffer = ''
	input.setEncoding('utf8')
	input.on('data', (chunk) => {
		buffer += chunk
		let newline = buffer.indexOf('\n')
		while (newline !== -1) {
			const line = buffer.slice(0, newline).trim()
			buffer = buffer.slice(newline + 1)
			newline = buffer.indexOf('\n')
			if (!line) continue
			try {
				handle(JSON.parse(line))
			} catch (err) {
				process.stderr.write(`tool-loader: bad message: ${err.message}\n`)
			}
		}
	})
}

if (require.main === module) {
	if (process.argv[2] === 'mcp') serveMcp()
	else {
		console.error('tool-loader: usage: node tool-loader.js mcp')
		process.exit(1)
	}
}

module.exports = {
	SERVER_NAME,
	LOADER_TOOL,
	applyToolLoader,
	runLoadTool,
	serveMcp,
	catalogPath,
}
