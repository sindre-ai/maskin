#!/usr/bin/env node
// Minimal tool-use conformance run for a model on the Maskin-funded OpenRouter
// route. Drives the Claude CLI the way a funded session does (same env shape as
// buildMaskinPlanEnv in apps/dev/src/lib/llm-routing.ts) against the Maskin MCP.
//
// Checks per model:
//   tool-loop-10    10 chained MCP tool calls, none errored
//   actor-roundtrip get_actor, then update_actor writing the same description back
//   lang-en/no/ru   reply is in the prompt's language, no CJK in a non-CJK prompt
// Also counts narrated fake tool calls (tool-call syntax typed into reply text).
//
// Usage:
//   OPENROUTER_API_KEY=... MASKIN_API_URL=... MASKIN_API_KEY=... MASKIN_WORKSPACE_ID=... \
//     node scripts/openrouter-conformance.mjs --actor-id <agent uuid with a description> \
//       --model openai/gpt-6.1-terra --model deepseek/deepseek-v4.1-flash [--json out.json]
//
// The actor round trip writes the actor's current description back unchanged, so
// pick any agent that has one. Needs the `claude` CLI on PATH. Spends OpenRouter credit.
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
	options: {
		model: { type: 'string', multiple: true },
		'actor-id': { type: 'string' },
		json: { type: 'string' },
		effort: { type: 'string', default: 'low' }, // MASKIN_PLAN_EFFORT
		timeout: { type: 'string', default: '420' }, // seconds per check
	},
})

const need = (name) => {
	const v = process.env[name]
	if (!v) fail(`Missing env ${name}`)
	return v
}
function fail(msg) {
	console.error(msg)
	process.exit(2)
}

const OR_KEY = need('OPENROUTER_API_KEY')
const API_URL = need('MASKIN_API_URL')
const API_KEY = need('MASKIN_API_KEY')
const WORKSPACE_ID = need('MASKIN_WORKSPACE_ID')
const models = args.model ?? []
const actorId = args['actor-id']
if (models.length === 0 || !actorId) fail('Need --actor-id and at least one --model')
const timeoutMs = Number(args.timeout) * 1000

// --- Maskin MCP, direct (used to read the actor before and after) -------------

async function mcpCall(name, toolArgs) {
	const res = await fetch(`${API_URL}/mcp`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			authorization: `Bearer ${API_KEY}`,
			'x-workspace-id': WORKSPACE_ID,
		},
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name, arguments: toolArgs },
		}),
	})
	const raw = await res.text()
	const dataLine = raw.split('\n').find((l) => l.startsWith('data:'))
	const msg = JSON.parse(dataLine ? dataLine.slice(5) : raw)
	if (msg.error || msg.result?.isError) fail(`MCP ${name} failed: ${raw.slice(0, 300)}`)
	return msg.result
}

async function readDescription() {
	const r = await mcpCall('get_actor', { id: actorId })
	const body = r.structuredContent ?? JSON.parse(r.content[0].text)
	const actor = body.actor ?? body
	if (!actor.description) fail('Target actor has no description; pick one that does')
	return actor.description
}

// --- OpenRouter: prices and spend ---------------------------------------------

const orHeaders = { authorization: `Bearer ${OR_KEY}` }
const modelList = (await (await fetch('https://openrouter.ai/api/v1/models')).json()).data
const price = (id) => {
	const m = modelList.find((x) => x.id === id)
	if (!m || m.pricing?.prompt == null) fail(`No priced model ${id} on OpenRouter`)
	return { prompt: Number(m.pricing.prompt), completion: Number(m.pricing.completion) }
}
async function keyUsage() {
	const res = await fetch('https://openrouter.ai/api/v1/key', { headers: orHeaders })
	return res.ok ? (await res.json()).data.usage : null
}

// --- Claude CLI runner --------------------------------------------------------

const workdir = mkdtempSync(join(tmpdir(), 'or-conformance-'))
const mcpConfig = join(workdir, 'mcp.json')
writeFileSync(
	mcpConfig,
	JSON.stringify({
		mcpServers: {
			maskin: {
				type: 'http',
				url: `${API_URL}/mcp`,
				headers: { Authorization: `Bearer ${API_KEY}`, 'X-Workspace-Id': WORKSPACE_ID },
			},
		},
	}),
)

function runClaude(model, prompt) {
	const env = {
		...process.env,
		CLAUDE_CONFIG_DIR: join(workdir, 'claude-config'),
		ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
		ANTHROPIC_AUTH_TOKEN: OR_KEY,
		ANTHROPIC_API_KEY: '',
		ANTHROPIC_MODEL: model,
		ANTHROPIC_SMALL_FAST_MODEL: model,
		MAX_THINKING_TOKENS: '0',
	}
	const cli = [
		'-p',
		prompt,
		'--output-format',
		'stream-json',
		'--verbose',
		'--model',
		model,
		'--effort',
		args.effort,
		'--mcp-config',
		mcpConfig,
		'--strict-mcp-config',
		'--allowedTools',
		'mcp__maskin',
		'--tools',
		'',
		'--no-session-persistence',
	]
	return new Promise((resolve) => {
		const child = spawn('claude', cli, { env, cwd: workdir })
		let out = ''
		let err = ''
		const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
		child.stdout.on('data', (d) => {
			out += d
		})
		child.stderr.on('data', (d) => {
			err += d
		})
		child.on('close', (code) => {
			clearTimeout(timer)
			resolve({ code, events: parseStream(out), stderr: err.slice(-500) })
		})
	})
}

function parseStream(out) {
	const events = []
	for (const line of out.split('\n')) {
		if (!line.startsWith('{')) continue
		try {
			events.push(JSON.parse(line))
		} catch {}
	}
	return events
}

// Pull out what the checks need from one CLI run.
function summarise(run) {
	const toolUses = []
	const toolResults = []
	const texts = []
	let result = null
	for (const e of run.events) {
		if (e.type === 'assistant') {
			for (const b of e.message?.content ?? []) {
				if (b.type === 'tool_use') toolUses.push({ name: b.name, input: b.input })
				if (b.type === 'text') texts.push(b.text)
			}
		} else if (e.type === 'user') {
			for (const b of e.message?.content ?? []) {
				if (b.type === 'tool_result') toolResults.push({ error: b.is_error === true })
			}
		} else if (e.type === 'result') {
			result = e
		}
	}
	return {
		toolUses,
		toolResults,
		texts,
		finalText: result?.result ?? texts.at(-1) ?? '',
		usage: result?.usage ?? {},
		cliError: result?.is_error === true || run.code !== 0,
		stderr: run.stderr,
	}
}

// Tool-call syntax typed into reply text instead of made as a real call.
const FAKE_CALL = [
	/<skill_called/i,
	/<\/?(tool_call|function_call|function_calls|invoke|tool_use)\b/i,
	/\bantml:/i,
	/<\|(tool|python_tag|im_start)/i,
	/\bto=functions\./i,
	/\bfunctions\.[a-z_]+\s*\(/i,
	/\bmcp__maskin__[a-z_]+\s*[({]/i,
	/"name"\s*:\s*"(mcp__maskin__)?(get_actor|update_actor|search_objects|list_objects)"/i,
]
const fakeCalls = (texts) => texts.filter((t) => FAKE_CALL.some((re) => re.test(t))).length

// --- Language detection -------------------------------------------------------

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/
const CYRILLIC = /[Ѐ-ӿ]/g
const words = (t) => t.toLowerCase().match(/[a-zæøåäöü]+/g) ?? []
const share = (ws, set) => (ws.length ? ws.filter((w) => set.has(w)).length / ws.length : 0)
const EN = new Set('the and is of to in that it for with on are as this be you can'.split(' '))
const NO = new Set('og er det som på av for med ikke til en et har den kan de hovedstaden'.split(' '))
const NO_ONLY = new Set('og det som på av ikke til har kan hovedstaden jeg deg ble'.split(' '))

const LANG_CHECKS = [
	{
		name: 'lang-en',
		prompt: 'What is the capital of Norway? Name two sights there. Answer in two sentences.',
		ok: (t) => !CJK.test(t) && share(words(t), EN) > share(words(t), NO_ONLY) && share(words(t), EN) > 0.1,
	},
	{
		name: 'lang-no',
		prompt: 'Hva er hovedstaden i Norge? Nevn to severdigheter der. Svar med to setninger.',
		ok: (t) => !CJK.test(t) && share(words(t), NO_ONLY) > 0.05 && share(words(t), NO_ONLY) > share(words(t), EN),
	},
	{
		name: 'lang-ru',
		prompt: 'Какая столица Норвегии? Назови две достопримечательности. Ответь двумя предложениями.',
		ok: (t) => !CJK.test(t) && (t.match(CYRILLIC) ?? []).length / Math.max(t.length, 1) > 0.5,
	},
]

// --- The checks ---------------------------------------------------------------

const noMcpNote = 'Use only the tools. Do not describe a tool call in text; make it.'

async function runModel(model, description) {
	const p = price(model)
	const checks = []
	let fake = 0
	let inTok = 0
	let outTok = 0

	const record = (name, run, s, pass, detail) => {
		fake += fakeCalls(s.texts)
		inTok +=
			(s.usage.input_tokens ?? 0) +
			(s.usage.cache_read_input_tokens ?? 0) +
			(s.usage.cache_creation_input_tokens ?? 0)
		outTok += s.usage.output_tokens ?? 0
		checks.push({ name, pass: pass && !s.cliError, detail: s.cliError ? `cli error: ${s.stderr}` : detail })
	}

	// 1. ten chained tool calls: each query comes from the previous result.
	{
		const prompt = `${noMcpNote} Call search_objects ten times, one call at a time, never in parallel. The first query is "bet". For each later call use as the query one word taken from the first result title of the previous call. After the tenth call reply with the single word DONE.`
		const run = await runClaude(model, prompt)
		const s = summarise(run)
		const calls = s.toolUses.filter((t) => t.name.endsWith('search_objects')).length
		const errors = s.toolResults.filter((r) => r.error).length
		record('tool-loop-10', run, s, calls >= 10 && errors === 0 && /DONE/.test(s.finalText), `${calls} calls, ${errors} errored`)
	}

	// 2. get_actor then update_actor with the same description.
	{
		const prompt = `${noMcpNote} Call get_actor for id ${actorId}. Then call update_actor for the same id, setting description to exactly the description you read, character for character. Then reply with the single word DONE.`
		const run = await runClaude(model, prompt)
		const s = summarise(run)
		const get = s.toolUses.findIndex((t) => t.name.endsWith('get_actor'))
		const upd = s.toolUses.findIndex((t) => t.name.endsWith('update_actor'))
		const wrote = upd >= 0 && s.toolUses[upd].input?.id === actorId
		const same = wrote && s.toolUses[upd].input?.description === description
		const after = await readDescription()
		const intact = after === description
		record(
			'actor-roundtrip',
			run,
			s,
			get >= 0 && get < upd && same && intact && s.toolResults.every((r) => !r.error),
			`get=${get >= 0} update=${wrote} description_matches=${same} unchanged_after=${intact}`,
		)
	}

	// 3-5. reply language, no tools needed.
	for (const lc of LANG_CHECKS) {
		const run = await runClaude(model, lc.prompt)
		const s = summarise(run)
		record(lc.name, run, s, lc.ok(s.finalText), `reply: ${s.finalText.replace(/\s+/g, ' ').slice(0, 120)}`)
	}

	const estCost = inTok * p.prompt + outTok * p.completion
	return { model, checks, fakeToolCalls: fake, inTok, outTok, estCostUsd: estCost }
}

// --- Main ---------------------------------------------------------------------

const description = await readDescription()
const results = []
for (const model of models) {
	const before = await keyUsage()
	const r = await runModel(model, description)
	const after = await keyUsage()
	r.billedUsd = before != null && after != null ? after - before : null
	results.push(r)
	console.log(`\n== ${model}`)
	for (const c of r.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}  ${c.detail}`)
	console.log(`narrated fake tool calls: ${r.fakeToolCalls}`)
	console.log(`tokens: ${r.inTok} in, ${r.outTok} out`)
	console.log(
		`cost: est $${r.estCostUsd.toFixed(4)} from public prices${r.billedUsd != null ? `, billed $${r.billedUsd.toFixed(4)} (key usage delta)` : ''}`,
	)
}
if (args.json) writeFileSync(args.json, JSON.stringify(results, null, 2))
process.exit(results.every((r) => r.checks.every((c) => c.pass) && r.fakeToolCalls === 0) ? 0 : 1)
