#!/usr/bin/env node
// Re-runnable scripted 4-person group chat that records the group_chat_message_routed
// events the backend emits. Four participants: H1 and H2 (people), A and B (agents).
//
// It starts a small local PostHog capture sink, drives the chat through the HTTP API
// and prints one payload per message. Nothing is mocked: the backend under test does
// the routing and the emitting.
//
// Start the backend so it captures into the sink (any non-empty key works):
//
//   MASKIN_TEST_GRANT_TOKEN=scripted POSTHOG_API_KEY=scripted \
//   POSTHOG_HOST=http://127.0.0.1:8999 pnpm dev:no-docker
//
// MASKIN_TEST_GRANT_TOKEN lets the script lift the trial plan's one-person seat cap so H2
// can join (the same seam the E2E specs use, see apps/dev/src/routes/test-grants.ts). Give
// the script the same value in its own environment. Then:
//
//   MASKIN_TEST_GRANT_TOKEN=scripted node scripts/group-chat-routing-scripted-chat.mjs \
//     --flag off --credentials oauth-only [--api-url http://localhost:3000] \
//     [--capture-port 8999] [--out payloads.json]
//
// --credentials oauth-only   A and B have no chat-callable key (their only route is Claude
//                            sign-in). The relevance check fails open: default_yes_no_credentials.
// --credentials chat-key     A and B carry a chat-callable key, read from CHAT_KEY_API_KEY
//                            (provider from CHAT_KEY_PROVIDER, default anthropic).
// --flag off|on              Which state the backend is running in. The wake-rule flag does
//                            not exist yet, so only "off" is valid today. The script cannot
//                            switch it: it records the label and fails the run if the events
//                            disagree with it.
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

const args = Object.fromEntries(
	process.argv
		.slice(2)
		.map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
		.filter(Boolean),
)
const apiUrl = (args['api-url'] ?? 'http://localhost:3000').replace(/\/$/, '')
const capturePort = Number(args['capture-port'] ?? 8999)
const flag = args.flag ?? 'off'
const credentials = args.credentials ?? 'oauth-only'
const out = args.out
const EVENT_WAIT_MS = 15_000

if (!['off', 'on'].includes(flag)) fail('--flag must be off or on')
if (!['oauth-only', 'chat-key'].includes(credentials)) {
	fail('--credentials must be oauth-only or chat-key')
}
if (!process.env.MASKIN_TEST_GRANT_TOKEN) {
	fail('MASKIN_TEST_GRANT_TOKEN must be set here and on the backend (see the header)')
}
if (credentials === 'chat-key' && !process.env.CHAT_KEY_API_KEY) {
	fail('--credentials chat-key needs CHAT_KEY_API_KEY in the environment')
}

function fail(message) {
	console.error(`error: ${message}`)
	process.exit(1)
}

// --- capture sink -----------------------------------------------------------------
const captured = []
const waiters = []
const sink = createServer((req, res) => {
	let body = ''
	req.on('data', (chunk) => {
		body += chunk
	})
	req.on('end', () => {
		res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":1}')
		try {
			const parsed = JSON.parse(body)
			if (parsed.event !== 'group_chat_message_routed') return
			captured.push(parsed)
			for (const w of waiters.splice(0)) w()
		} catch {}
	})
})
await new Promise((resolve) => sink.listen(capturePort, '127.0.0.1', resolve))

async function eventFor(messageId) {
	const deadline = Date.now() + EVENT_WAIT_MS
	for (;;) {
		const hit = captured.find((e) => e.properties.message_id === messageId)
		if (hit) return hit
		const left = deadline - Date.now()
		if (left <= 0) return null
		await new Promise((resolve) => {
			waiters.push(resolve)
			setTimeout(resolve, Math.min(left, 500))
		})
	}
}

// --- API helpers ------------------------------------------------------------------
async function api(method, path, { key, workspaceId, body, extraHeaders } = {}) {
	const res = await fetch(`${apiUrl}${path}`, {
		method,
		headers: {
			'Content-Type': 'application/json',
			...(key ? { Authorization: `Bearer ${key}` } : {}),
			...(workspaceId ? { 'X-Workspace-Id': workspaceId } : {}),
			...extraHeaders,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const text = await res.text()
	if (!res.ok) fail(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`)
	return text ? JSON.parse(text) : null
}

const stamp = Date.now()
async function signUpPerson(name) {
	return api('POST', '/api/actors', {
		body: {
			type: 'human',
			name,
			email: `scripted-${name.toLowerCase()}-${stamp}@test.invalid`,
			password: 'scripted-chat-password-123',
		},
	})
}

async function createAgent(name, h1, workspaceId) {
	const body = { type: 'agent', name, workspace_id: workspaceId }
	if (credentials === 'chat-key') {
		body.llm_provider = process.env.CHAT_KEY_PROVIDER ?? 'anthropic'
		body.llm_config = { api_key: process.env.CHAT_KEY_API_KEY }
	}
	return api('POST', '/api/actors', { key: h1.api_key, body })
}

// --- the script -------------------------------------------------------------------
const h1 = await signUpPerson('H1')
const h2 = await signUpPerson('H2')
const [workspace] = await api('GET', '/api/workspaces', { key: h1.api_key })
const workspaceId = workspace.id
await api('POST', `/api/test-grants/${workspaceId}`, {
	key: h1.api_key,
	body: { plan: 'team' },
	extraHeaders: { 'X-Test-Grant-Token': process.env.MASKIN_TEST_GRANT_TOKEN },
})
await api('POST', `/api/workspaces/${workspaceId}/members`, {
	key: h1.api_key,
	workspaceId,
	body: { actor_id: h2.id, role: 'member' },
})
const agentA = await createAgent('Agent A', h1, workspaceId)
const agentB = await createAgent('Agent B', h1, workspaceId)
const names = { [h1.id]: 'H1', [h2.id]: 'H2', [agentA.id]: 'A', [agentB.id]: 'B' }

const results = []

async function say(conversationId, who, label, content, mentions = []) {
	const message = await api('POST', `/api/conversations/${conversationId}/messages`, {
		key: who.api_key,
		workspaceId,
		body: {
			content: mentions.length
				? `${mentions.map((id) => `<@${id}>`).join(' ')} ${content}`
				: content,
			...(mentions.length ? { metadata: { mentions } } : {}),
		},
	})
	const event = await eventFor(message.id)
	const p = event?.properties
	results.push({
		step: label,
		author: names[who.id],
		message_id: message.id,
		emitted: Boolean(p),
		payload: p ?? null,
	})
	console.log(
		`${label.padEnd(44)} ${p ? 'emitted' : 'NO EVENT'}${
			p
				? `  woke=[${p.woken_agent_ids.map((id) => names[id] ?? id)}]  ${p.agent_outcomes.map(readable).join('')}`
				: ''
		}`,
	)
}

function readable(entry) {
	const [id, decision, reason, delivery] = entry.split('|')
	return `\n      ${names[id] ?? id}: ${decision} ${reason} ${delivery}`
}

// Fresh chat with two agents: the first untagged message.
const fresh = await api('POST', '/api/conversations', {
	key: h1.api_key,
	workspaceId,
	body: { title: 'Scripted: fresh chat', participant_actor_ids: [h2.id, agentA.id, agentB.id] },
})
await say(fresh.id, h1, 'first untagged message, fresh chat, 2 agents', 'who is around?')

// The main chat.
const chat = await api('POST', '/api/conversations', {
	key: h1.api_key,
	workspaceId,
	body: { title: 'Scripted: 4 participants', participant_actor_ids: [h2.id, agentA.id, agentB.id] },
})
await say(chat.id, agentA, 'A speaks (makes A the last speaker)', 'Here is my take.')
await say(chat.id, h1, 'S1 H1 untagged after A spoke last', 'and what about the second part?')
await say(chat.id, h1, 'S2 H1 tags A', 'please go on', [agentA.id])
await say(chat.id, h1, 'S3 H1 tags B', 'your view?', [agentB.id])
await say(chat.id, h1, 'S4 H1 tags H2', 'H2, are you in?', [h2.id])
await say(chat.id, agentB, 'B speaks (makes B the last speaker)', 'Here is mine.')
await say(chat.id, h1, 'S5 H1 untagged after B spoke last', 'thanks, one more thing')

sink.close()

const wrongFlag = results.filter((r) => r.payload && r.payload.flag_on !== (flag === 'on'))
const payload = { flag, credentials, results }
if (out) writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`)
else console.log(JSON.stringify(payload, null, 2))

const missing = results.filter((r) => !r.emitted)
if (missing.length) fail(`${missing.length} step(s) produced no event`)
if (wrongFlag.length) {
	fail(
		`--flag ${flag} does not match flag_on on ${wrongFlag.length} event(s); start the backend in that state`,
	)
}
console.log(`ok: ${results.length} events, flag=${flag}, credentials=${credentials}`)
