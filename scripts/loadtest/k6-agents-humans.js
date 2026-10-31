// k6 load test: 30 agent writers plus 100 human tabs against a STAGING Maskin API.
//
// Replays today's read pattern (see docs/runbooks/k6-load-test.md): every human tab
// refetches the chat list, actors list, sessions list, for-you, unread chats and the
// open chat after each event, and holds one event stream (SSE) connection. Every agent
// creates, updates and deletes a throwaway task, which is what produces the events.
//
// Staging only. The script refuses to start against a production host and requires
// ALLOW_STAGING=yes. It never takes a hostname from the repo: pass BASE_URL.
//
//   k6 run -e BASE_URL=https://<staging-host> -e ALLOW_STAGING=yes \
//     -e API_KEY=ank_... -e WORKSPACE_ID=<uuid> scripts/loadtest/k6-agents-humans.js
//
// Env:
//   BASE_URL         required, staging origin, no trailing slash
//   ALLOW_STAGING    required, must be "yes"
//   API_KEY          required, API key of a staging member (used for humans and agents)
//   AGENT_API_KEY    optional, separate key for the agent writers (defaults to API_KEY)
//   WORKSPACE_ID     required, staging workspace to load
//   PROFILE          smoke (default) | baseline | breakpoint
//   SUMMARY_FILE     optional, where to write the JSON summary (default k6-summary.json)

import { check, group, sleep } from 'k6'
import exec from 'k6/execution'
import http from 'k6/http'
import { Counter } from 'k6/metrics'

const BASE_URL = (__ENV.BASE_URL || '').replace(/\/+$/, '')
const API_KEY = __ENV.API_KEY || ''
const AGENT_API_KEY = __ENV.AGENT_API_KEY || API_KEY
const WORKSPACE_ID = __ENV.WORKSPACE_ID || ''
const PROFILE = __ENV.PROFILE || 'smoke'
const SUMMARY_FILE = __ENV.SUMMARY_FILE || 'k6-summary.json'

// Hosts this script must never touch. Matched on the hostname only.
const PRODUCTION_HOSTS = [/^(www\.|api\.)?maskin\.io$/i, /^maskin\.sindre\.ai$/i]
// A staging host must say so in its name.
const STAGING_HINT = /(^|[.-])(staging|stage|stg|loadtest|test)([.-]|$)/i

const TITLE_PREFIX = 'k6-loadtest'

const eventStreamsOpened = new Counter('event_streams_opened')
const agentWrites = new Counter('agent_writes')

const ROUTES = {
	conversations: 'GET /api/conversations',
	conversationsUnread: 'GET /api/conversations?unread_only',
	messages: 'GET /api/conversations/:id/messages',
	actors: 'GET /api/actors?limit=100',
	sessions: 'GET /api/sessions?limit=100',
	sessionsByChat: 'GET /api/sessions?verbose&conversation_id',
	forYou: 'GET /api/for-you',
	objects: 'GET /api/objects',
	objectGraph: 'GET /api/objects/:id/graph',
	eventsHistory: 'GET /api/events/history',
	eventsStream: 'GET /api/events (stream)',
	objectCreate: 'POST /api/objects',
	objectUpdate: 'PATCH /api/objects/:id',
	objectDelete: 'DELETE /api/objects/:id',
}

const PROFILES = {
	// A minute with a handful of users: proves the script and the credentials work.
	smoke: {
		humans: [
			{ duration: '20s', target: 5 },
			{ duration: '20s', target: 5 },
			{ duration: '10s', target: 0 },
		],
		agents: [
			{ duration: '20s', target: 2 },
			{ duration: '20s', target: 2 },
			{ duration: '10s', target: 0 },
		],
	},
	// The target load: 100 human tabs and 30 agents, held for ten minutes.
	baseline: {
		humans: [
			{ duration: '2m', target: 100 },
			{ duration: '10m', target: 100 },
			{ duration: '1m', target: 0 },
		],
		agents: [
			{ duration: '2m', target: 30 },
			{ duration: '10m', target: 30 },
			{ duration: '1m', target: 0 },
		],
	},
	// Keep adding load in steps until the error rate or latency threshold aborts the run.
	breakpoint: {
		humans: [
			{ duration: '3m', target: 100 },
			{ duration: '3m', target: 200 },
			{ duration: '3m', target: 300 },
			{ duration: '3m', target: 400 },
		],
		agents: [
			{ duration: '3m', target: 30 },
			{ duration: '3m', target: 60 },
			{ duration: '3m', target: 90 },
			{ duration: '3m', target: 120 },
		],
	},
}

const profile = PROFILES[PROFILE]

function routeThresholds() {
	const thresholds = {
		// Hard stop for breakpoint runs; reported but not enforced for smoke and baseline.
		http_req_failed: [
			{ threshold: 'rate<0.05', abortOnFail: PROFILE === 'breakpoint', delayAbortEval: '30s' },
		],
		// The event stream is held open for 30s on purpose, so it is left out (kind:api only).
		'http_req_duration{kind:api}': [
			{ threshold: 'p(95)<5000', abortOnFail: PROFILE === 'breakpoint', delayAbortEval: '30s' },
		],
	}
	// An always-true threshold per route makes k6 print a per-route p(95) in the summary.
	for (const route of Object.values(ROUTES)) {
		thresholds[`http_req_duration{route:${route}}`] = ['max>=0']
	}
	return thresholds
}

export const options = {
	scenarios: profile
		? {
				humans: {
					executor: 'ramping-vus',
					exec: 'human',
					startVUs: 0,
					stages: profile.humans,
					gracefulRampDown: '10s',
					gracefulStop: '40s',
				},
				agents: {
					executor: 'ramping-vus',
					exec: 'agent',
					startVUs: 0,
					stages: profile.agents,
					gracefulRampDown: '10s',
					gracefulStop: '30s',
				},
			}
		: {},
	thresholds: routeThresholds(),
	summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'max'],
}

function headers(key) {
	return {
		Authorization: `Bearer ${key}`,
		'X-Workspace-Id': WORKSPACE_ID,
		'x-client-source': 'k6-loadtest',
		Accept: 'application/json',
	}
}

function get(path, route, key = API_KEY) {
	return http.get(`${BASE_URL}${path}`, {
		headers: headers(key),
		tags: { route, kind: 'api' },
	})
}

function json(res) {
	try {
		return res.json()
	} catch (_e) {
		return null
	}
}

function firstId(body, keys) {
	if (!body) return null
	if (Array.isArray(body)) return body[0]?.id ?? null
	for (const key of keys) {
		if (Array.isArray(body[key]) && body[key][0]?.id) return body[key][0].id
	}
	return null
}

function refuseUnlessStaging() {
	const problems = []
	if (!profile) problems.push(`PROFILE must be smoke, baseline or breakpoint (got "${PROFILE}")`)
	if (!/^https?:\/\/[^/]+$/i.test(BASE_URL)) problems.push('BASE_URL must be an origin, e.g. https://host')
	if (__ENV.ALLOW_STAGING !== 'yes') problems.push('set ALLOW_STAGING=yes to confirm this is staging')
	if (!API_KEY) problems.push('API_KEY is required')
	if (!WORKSPACE_ID) problems.push('WORKSPACE_ID is required')
	const host = BASE_URL.replace(/^https?:\/\//i, '').replace(/:\d+$/, '')
	const looksStaging = STAGING_HINT.test(host) || /^(localhost|127\.0\.0\.1)$/.test(host)
	if (PRODUCTION_HOSTS.some((re) => re.test(host))) {
		problems.push(`${host} is a production host`)
	}
	if (!looksStaging) {
		problems.push(`${host} does not look like staging (needs staging, stg, test or loadtest in the name)`)
	}
	return problems
}

export function setup() {
	const problems = refuseUnlessStaging()
	if (problems.length > 0) {
		exec.test.abort(`Refusing to run: ${problems.join('; ')}`)
	}

	const probe = get('/api/conversations?limit=20', ROUTES.conversations)
	if (probe.status !== 200) {
		exec.test.abort(
			`Staging probe failed: GET /api/conversations returned ${probe.status}. Check API_KEY and WORKSPACE_ID.`,
		)
	}
	const conversationId = firstId(json(probe), ['conversations', 'items', 'data'])
	const objects = get('/api/objects?limit=5', ROUTES.objects)
	const objectId = firstId(json(objects), ['objects', 'items', 'data'])
	return { conversationId, objectId }
}

// One human tab. An iteration is the burst of refetches an event causes in the web app.
export function human(data) {
	group('refetch burst', () => {
		const calls = [
			['/api/conversations?limit=50', ROUTES.conversations],
			['/api/conversations?limit=50&unread_only=true', ROUTES.conversationsUnread],
			['/api/actors?limit=100&offset=0', ROUTES.actors],
			['/api/sessions?limit=100', ROUTES.sessions],
			['/api/for-you', ROUTES.forYou],
			['/api/objects?limit=50', ROUTES.objects],
		]
		if (data.conversationId) {
			calls.push([`/api/conversations/${data.conversationId}/messages?limit=50`, ROUTES.messages])
			calls.push([
				`/api/sessions?verbose=true&conversation_id=${data.conversationId}`,
				ROUTES.sessionsByChat,
			])
		}
		if (data.objectId) {
			calls.push([`/api/objects/${data.objectId}/graph`, ROUTES.objectGraph])
		}
		// Every tab sends its requests together, like the browser does after an invalidation.
		const responses = http.batch(
			calls.map(([path, route]) => ({
				method: 'GET',
				url: `${BASE_URL}${path}`,
				params: { headers: headers(API_KEY), tags: { route, kind: 'api' } },
			})),
		)
		for (const res of responses) {
			check(res, { 'read returned 200': (r) => r.status === 200 })
		}
	})

	// One event stream per tab, held for 30s then reopened (a reconnect). The stream
	// never ends on its own, so a timeout is the expected outcome and is not an error.
	if (exec.scenario.iterationInTest % 5 === 0) {
		const res = http.get(`${BASE_URL}/api/events`, {
			headers: { ...headers(API_KEY), Accept: 'text/event-stream' },
			timeout: '30s',
			responseType: 'none',
			responseCallback: http.expectedStatuses({ min: 200, max: 399 }, 0),
			tags: { route: ROUTES.eventsStream },
		})
		eventStreamsOpened.add(1)
		check(res, { 'event stream opened': (r) => r.status === 200 || r.status === 0 })
	}

	sleep(2 + Math.random() * 4)
}

// One agent. Writes a throwaway task so the event stream carries real change events.
export function agent() {
	const key = AGENT_API_KEY
	const writeHeaders = {
		...headers(key),
		'Content-Type': 'application/json',
		'Idempotency-Key': `${TITLE_PREFIX}-${exec.vu.idInTest}-${exec.vu.iterationInScenario}-${Date.now()}`,
	}
	const created = http.post(
		`${BASE_URL}/api/objects`,
		JSON.stringify({
			type: 'task',
			title: `${TITLE_PREFIX} ${exec.vu.idInTest}-${exec.vu.iterationInScenario}`,
			content: 'Throwaway object written by the k6 load test. Safe to delete.',
			status: 'todo',
			metadata: { loadtest: true },
		}),
		{ headers: writeHeaders, tags: { route: ROUTES.objectCreate, kind: 'api' } },
	)
	agentWrites.add(1)
	const ok = check(created, { 'object created': (r) => r.status === 200 || r.status === 201 })
	const id = ok ? created.json('id') : null

	if (id) {
		sleep(0.5 + Math.random())
		const updated = http.patch(
			`${BASE_URL}/api/objects/${id}`,
			JSON.stringify({ status: 'in_progress' }),
			{
				headers: { ...writeHeaders, 'Idempotency-Key': `${writeHeaders['Idempotency-Key']}-u` },
				tags: { route: ROUTES.objectUpdate, kind: 'api' },
			},
		)
		agentWrites.add(1)
		check(updated, { 'object updated': (r) => r.status === 200 })

		const removed = http.del(`${BASE_URL}/api/objects/${id}`, null, {
			headers: headers(key),
			tags: { route: ROUTES.objectDelete, kind: 'api' },
		})
		agentWrites.add(1)
		check(removed, { 'object deleted': (r) => r.status === 200 || r.status === 204 })
	}

	// Agents also read the history they react to.
	get('/api/events/history?limit=50', ROUTES.eventsHistory, key)
	sleep(1 + Math.random() * 2)
}

export function handleSummary(data) {
	const duration = data.state.testRunDurationMs / 1000
	const total = data.metrics.http_reqs?.values.count ?? 0
	const routes = {}
	for (const route of Object.values(ROUTES)) {
		const m = data.metrics[`http_req_duration{route:${route}}`]
		if (m) {
			routes[route] = {
				p95_ms: Math.round(m.values['p(95)']),
				avg_ms: Math.round(m.values.avg),
				max_ms: Math.round(m.values.max),
			}
		}
	}
	const summary = {
		profile: PROFILE,
		duration_s: Math.round(duration),
		requests: total,
		requests_per_second: Number((total / Math.max(duration, 1)).toFixed(2)),
		error_rate: data.metrics.http_req_failed?.values.rate ?? null,
		overall_p95_ms: Math.round(data.metrics['http_req_duration{kind:api}']?.values['p(95)'] ?? 0),
		peak_vus: data.metrics.vus_max?.values.max ?? null,
		event_streams_opened: data.metrics.event_streams_opened?.values.count ?? 0,
		agent_writes: data.metrics.agent_writes?.values.count ?? 0,
		routes,
	}
	const lines = [
		`profile ${summary.profile}: ${summary.requests} requests, ${summary.requests_per_second} req/s, ` +
			`error rate ${(Number(summary.error_rate) * 100).toFixed(2)}%, overall p95 ${summary.overall_p95_ms} ms`,
		...Object.entries(routes).map(([route, v]) => `  ${route}: p95 ${v.p95_ms} ms`),
	]
	return {
		[SUMMARY_FILE]: JSON.stringify(summary, null, 2),
		stdout: `\n${lines.join('\n')}\n`,
	}
}
