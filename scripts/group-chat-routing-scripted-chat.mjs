#!/usr/bin/env node
// Re-runnable scripted 4-person group chat (H1, H2 people; A, B agents) that records the
// group_chat_message_routed events the backend emits. A local sink stands in for PostHog;
// nothing else is mocked.
//
// Start the backend capturing into the sink. MASKIN_TEST_GRANT_TOKEN lets the script lift
// the trial plan's one-person seat cap so H2 can join (the seam the E2E specs use):
//
//   MASKIN_TEST_GRANT_TOKEN=x POSTHOG_API_KEY=x POSTHOG_HOST=http://127.0.0.1:8999 \
//     pnpm dev:no-docker
//   MASKIN_TEST_GRANT_TOKEN=x node scripts/group-chat-routing-scripted-chat.mjs \
//     [--api-url http://localhost:3000] [--capture-port 8999] [--out payloads.json]
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const args = Object.fromEntries(
	process.argv
		.slice(2)
		.map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null))
		.filter(Boolean),
)
const apiUrl = (args['api-url'] ?? 'http://localhost:3000').replace(/\/$/, '')
const grantToken = process.env.MASKIN_TEST_GRANT_TOKEN

function fail(message) {
	console.error(`error: ${message}`)
	process.exit(1)
}
if (!grantToken) fail('MASKIN_TEST_GRANT_TOKEN must be set here and on the backend')

const captured = []
const sink = createServer((req, res) => {
	let body = ''
	req.on('data', (chunk) => {
		body += chunk
	})
	req.on('end', () => {
		res.writeHead(200).end('{"status":1}')
		try {
			const event = JSON.parse(body)
			if (event.event === 'group_chat_message_routed') captured.push(event.properties)
		} catch {}
	})
})
await new Promise((resolve) =>
	sink.listen(Number(args['capture-port'] ?? 8999), '127.0.0.1', resolve),
)

async function eventFor(messageId) {
	for (let i = 0; i < 60; i++) {
		const hit = captured.find((p) => p.message_id === messageId)
		if (hit) return hit
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
	return null
}

async function api(method, path, { key, workspaceId, body, headers } = {}) {
	const res = await fetch(`${apiUrl}${path}`, {
		method,
		headers: {
			'Content-Type': 'application/json',
			...(key ? { Authorization: `Bearer ${key}` } : {}),
			...(workspaceId ? { 'X-Workspace-Id': workspaceId } : {}),
			...headers,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	const text = await res.text()
	if (!res.ok) fail(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`)
	return text ? JSON.parse(text) : null
}

const stamp = Date.now()
const person = (name) =>
	api('POST', '/api/actors', {
		body: {
			type: 'human',
			name,
			email: `scripted-${name.toLowerCase()}-${stamp}@test.invalid`,
			password: `scripted-${stamp}-pw-A1`,
		},
	})

const h1 = await person('H1')
const h2 = await person('H2')
const [{ id: workspaceId }] = await api('GET', '/api/workspaces', { key: h1.api_key })
const asH1 = { key: h1.api_key, workspaceId }
await api('POST', `/api/test-grants/${workspaceId}`, {
	key: h1.api_key,
	body: { plan: 'team' },
	headers: { 'X-Test-Grant-Token': grantToken },
})
await api('POST', `/api/workspaces/${workspaceId}/members`, {
	...asH1,
	body: { actor_id: h2.id, role: 'member' },
})
const agent = (name) =>
	api('POST', '/api/actors', {
		key: h1.api_key,
		body: {
			type: 'agent',
			name,
			workspace_id: workspaceId,
		},
	})
const [agentA, agentB] = [await agent('Agent A'), await agent('Agent B')]
const names = { [h1.id]: 'H1', [h2.id]: 'H2', [agentA.id]: 'A', [agentB.id]: 'B' }
const label = (entry) => {
	const [id, ...rest] = entry.split('|')
	return `${names[id] ?? id}: ${rest.join(' ')}`
}

const results = []
async function say(conversationId, who, step, content, mentions = []) {
	const message = await api('POST', `/api/conversations/${conversationId}/messages`, {
		key: who.api_key,
		workspaceId,
		body: {
			content: `${mentions.map((id) => `<@${id}> `).join('')}${content}`,
			...(mentions.length ? { metadata: { mentions } } : {}),
		},
	})
	const payload = await eventFor(message.id)
	results.push({ step, author: names[who.id], message_id: message.id, payload })
	console.log(`${step}: ${payload ? '' : 'NO EVENT'}`)
	for (const entry of payload?.agent_outcomes ?? []) console.log(`    ${label(entry)}`)
}

const everyone = [h2.id, agentA.id, agentB.id]
const newChat = (title) =>
	api('POST', '/api/conversations', { ...asH1, body: { title, participant_actor_ids: everyone } })

const fresh = await newChat('Scripted: fresh chat')
await say(fresh.id, h1, 'first untagged message, fresh chat, 2 agents', 'who is around?')

const chat = await newChat('Scripted: 4 participants')
await say(chat.id, agentA, 'A speaks (A is now the last speaker)', 'Here is my take.')
await say(chat.id, h1, 'S1 H1 untagged after A spoke last', 'and the second part?')
await say(chat.id, h1, 'S2 H1 tags A', 'please go on', [agentA.id])
await say(chat.id, h1, 'S3 H1 tags B', 'your view?', [agentB.id])
await say(chat.id, h1, 'S4 H1 tags H2', 'H2, are you in?', [h2.id])
await say(chat.id, agentB, 'B speaks (B is now the last speaker)', 'Here is mine.')
await say(chat.id, h1, 'S5 H1 untagged after B spoke last', 'thanks, one more thing')
sink.close()

const json = `${JSON.stringify({ results }, null, 2)}\n`
if (args.out) writeFileSync(args.out, json)
else console.log(json)

const missing = results.filter((r) => !r.payload).length
if (missing) fail(`${missing} step(s) produced no event`)
console.log(`ok: ${results.length} events`)
