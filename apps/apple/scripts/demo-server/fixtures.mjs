import { addPerfRoom, perfOverrides } from './perf-fixtures.mjs'

// Demo data for the design review: the Northwind workspace from the Watch, iPad and TV prototypes.
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const WORKSPACE_ID = uuid(1)
export const ME = { id: uuid(2), name: 'Sindre Aasen', email: 'sindre@northwind.example' }
const CHIEF = uuid(3)
const PRIYA = uuid(4)
const OUTREACH_AGENT = uuid(5)

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString()
const DAY = 24 * 60

const actors = [
	{ id: ME.id, name: ME.name, type: 'human', email: ME.email, isSystem: false },
	{ id: CHIEF, name: 'Chief of Staff', type: 'agent', isSystem: true },
	{ id: PRIYA, name: 'Priya Rao', type: 'human' },
	{ id: OUTREACH_AGENT, name: 'Outreach', type: 'agent', isSystem: false },
]

// ── For you: three decisions waiting on the reader ────────────────────────────────────────────
const object = (n, type, title, status) => ({
	id: uuid(n),
	workspaceId: WORKSPACE_ID,
	type,
	title,
	content: null,
	status,
	metadata: {},
	driver: CHIEF,
	activeSessionId: null,
	createdBy: CHIEF,
	createdAt: ago(10 * DAY),
	updatedAt: ago(30),
	is_subscribed: true,
	unread_count: 1,
	subscriber_count: 2,
	is_starred_by_me: false,
})

const decisions = [
	{
		obj: object(100, 'insight', 'Northwind renewal risk', 'open'),
		at: 12,
		content:
			"Seven follow-ups to Northwind are drafted and approved by Sales. Sending now reaches them before Thursday's review.",
		decision: {
			title: 'Send 7 follow-ups to Northwind?',
			summary:
				"Seven follow-ups to Northwind are drafted and approved by Sales. Sending now reaches them before Thursday's review.",
			ask: 'Send them today?',
			options: [
				{
					label: 'Send all 7',
					consequences: ['Reaches them before Thursday', 'Undo for 1 hour'],
					recommended: true,
					destructive: false,
				},
				{
					label: 'Hold',
					consequences: ['Nothing is sent', 'The cycle waits for you'],
					recommended: false,
					destructive: false,
				},
			],
		},
	},
	{
		obj: object(101, 'bet', 'Q4 webinar', 'active'),
		at: 2 * DAY,
		content:
			'The Q4 webinar campaign needs $2,400 for ads and a speaker fee. Signups are at 210 of 600.',
		decision: {
			title: 'Approve the Q4 webinar spend?',
			summary:
				'The Q4 webinar campaign needs $2,400 for ads and a speaker fee. Signups are at 210 of 600.',
			ask: 'Approve the spend?',
			options: [
				{
					label: 'Approve $2,400',
					consequences: ['Charges real cards', 'Cannot be undone'],
					recommended: true,
					destructive: true,
				},
				{
					label: 'Approve $1,200 first',
					consequences: ['Half now, half at 400 signups'],
					recommended: false,
					destructive: false,
				},
				{
					label: 'Hold',
					consequences: ['Ads stay paused'],
					recommended: false,
					destructive: false,
				},
			],
		},
	},
	{
		obj: object(102, 'task', 'Contoso renewal terms', 'in_progress'),
		at: 5 * 60,
		content: 'Contoso asked for a 12-month term at the current rate. Legal has reviewed the draft.',
		decision: {
			title: 'Accept the 12-month term?',
			summary:
				'Contoso asked for a 12-month term at the current rate. Legal has reviewed the draft.',
			ask: 'Accept the term?',
			options: [
				{
					label: 'Accept',
					consequences: ['Locks the rate for 12 months'],
					recommended: true,
					destructive: false,
				},
				{
					label: 'Counter at 10% off',
					consequences: ['Adds a round of review'],
					recommended: false,
					destructive: false,
				},
				{
					label: 'Hold',
					consequences: ['Nothing is sent'],
					recommended: false,
					destructive: false,
				},
			],
		},
	},
]

function unreadFeed(item) {
	return {
		items: decisions.map((d, i) => ({
			...item,
			entity_type: 'object',
			entity_id: d.obj.id,
			unread_count: 1,
			mentioning_unread_count: 1,
			max_unread_attention: 90 - i * 10,
			latest_event_id: 1000 + i,
			latest_activity_at: ago(d.at),
			object: d.obj,
			latest_mention: {
				event_id: 1000 + i,
				actor_id: CHIEF,
				created_at: ago(d.at),
				content: d.content,
				attention: 90 - i * 10,
				decision: d.decision,
			},
		})),
	}
}

// ── Flows ────────────────────────────────────────────────────────────────────────────────────────
const flows = [
	{
		n: 200,
		name: 'Outreach',
		pill: 'waiting_on_you',
		status: 'learning',
		waiting: 1,
		open: 6,
		closed: 4,
		headline: 'Replies up 18%',
	},
	{
		n: 201,
		name: 'Renewals',
		pill: 'supervised',
		status: 'supervised',
		waiting: 0,
		open: 2,
		closed: 9,
		headline: 'Three deals moved',
	},
	{
		n: 202,
		name: 'Webinars',
		pill: 'waiting_on_you',
		status: 'learning',
		waiting: 1,
		open: 5,
		closed: 3,
		headline: 'Signups behind plan',
	},
	{
		n: 203,
		name: 'Pipeline',
		pill: 'supervised',
		status: 'supervised',
		waiting: 0,
		open: 4,
		closed: 6,
		headline: 'Pipeline steady',
	},
]

const loopRow = (f, row) => ({
	...row,
	id: uuid(f.n),
	workspaceId: WORKSPACE_ID,
	name: f.name,
	content: `${f.name} keeps the work moving and asks you only when it needs a call.`,
	status: f.status,
	pill: f.pill,
	entryCondition: null,
	closeCondition: null,
	inProgressCount: f.open,
	closedCount: f.closed,
	medianTimeToCloseMs: 3 * 3600_000,
	agentIds: [OUTREACH_AGENT],
	triggerIds: [],
	waitingOnViewer: f.waiting > 0,
	waitingCount: f.waiting,
	targets: null,
	createdAt: ago(30 * DAY),
	updatedAt: ago(20 + f.n),
})

// Each flow has one HTML page attached: a story card.
const pageId = (f) => uuid(f.n + 100)
const pageHtml = (f) =>
	`<!doctype html><html><head><title>${f.headline}</title></head><body><h1>${f.headline}</h1></body></html>`

// ── Team ─────────────────────────────────────────────────────────────────────────────────────────
const rooms = [
	{
		n: 300,
		title: 'Chief of Staff',
		with: [CHIEF],
		unread: 2,
		snippet: 'Seven follow-ups are ready. Want me to send them?',
		by: 'Chief of Staff',
		at: 9,
	},
	{
		n: 301,
		title: 'Outreach',
		with: [OUTREACH_AGENT, CHIEF],
		unread: 1,
		snippet: 'Replies are up 18% on last week.',
		by: 'Outreach',
		at: 40,
	},
	{
		n: 302,
		title: 'Priya Rao',
		with: [PRIYA],
		unread: 0,
		snippet: 'I can review the Northwind draft tomorrow.',
		by: 'Priya Rao',
		at: 3 * 60,
	},
	{
		n: 303,
		title: 'Webinars',
		with: [CHIEF],
		unread: 0,
		snippet: 'Signups are at 210 of 600.',
		by: 'Chief of Staff',
		at: DAY,
	},
]

const PERF = process.env.DEMO_PERF === '1'
if (PERF) addPerfRoom(rooms, { PRIYA, CHIEF })
// Participants as the API sends them on the list, create and detail responses alike.
const participantRow = (id) => {
	const a = actors.find((x) => x.id === id)
	return {
		actorId: id,
		actorName: a.name,
		actorType: a.type,
		joinedAt: ago(5 * DAY),
		addedBy: ME.id,
	}
}

// Comments posted to an object, kept for the life of the server so a refetch still shows them.
const postedComments = new Map()
let nextEventId = 9000

export function overrides({ method, path, params, query, body, base, item }) {
	if (PERF) {
		const hit = perfOverrides({
			method,
			path,
			query,
			item,
			base,
			ctx: { uuid, ago, ME, actors, WORKSPACE_ID, CHIEF, PRIYA },
		})
		if (hit) return hit
	}
	if (method !== 'get' && method !== 'post') return null
	if (method === 'post' && path === '/api/events' && typeof body?.entity_id === 'string') {
		const event = {
			...base,
			id: nextEventId++,
			actorId: ME.id,
			entityType: 'object',
			entityId: body.entity_id,
			action: 'commented',
			description: 'commented',
			data: {
				content: body.content,
				mentions: body.mentions ?? [],
				parentEventId: body.parent_event_id,
				attachmentFileIds: body.attachment_file_ids ?? [],
				metadata: body.metadata,
			},
			createdAt: new Date().toISOString(),
		}
		postedComments.set(body.entity_id, [...(postedComments.get(body.entity_id) ?? []), event])
		return { status: 201, body: event }
	}
	// Any email and password signs in as the first human, with a key and the demo workspace, so the
	// app has a workspace to load instead of the schema-sample's empty one.
	if (method === 'post' && path === '/api/auth/login') {
		const me = actors.find((a) => a.type === 'human') ?? actors[0]
		return {
			// Every field the login schema marks required, so the app's decoder accepts it.
			body: {
				id: me.id,
				type: 'human',
				name: me.name,
				email: me.email ?? 'sindre@northwind.example',
				description: '',
				system_prompt: null,
				tools: {},
				memory: {},
				llm_provider: null,
				llm_config: {},
				isSystem: false,
				agentState: 'idle',
				agentStateUpdatedAt: null,
				createdAt: ago(90 * DAY),
				updatedAt: ago(90 * DAY),
				api_key: 'ank_demo',
				workspace_id: WORKSPACE_ID,
			},
		}
	}
	if (method === 'get' && path === '/api/workspaces') {
		return {
			body: [
				{
					id: WORKSPACE_ID,
					name: 'Northwind',
					role: 'owner',
					member_count: 4,
					memberCount: 4,
					created_at: ago(90 * DAY),
				},
			],
		}
	}
	// Triggers and members, so the Triggers and Members screens show populated rows.
	if (method === 'get' && path === '/api/triggers')
		return {
			body: [
				{
					id: uuid(900),
					workspaceId: WORKSPACE_ID,
					name: 'Review new tasks',
					type: 'event',
					config: {
						entity_type: 'task',
						action: 'status_changed',
						from_status: 'todo',
						to_status: 'in_review',
					},
					actionPrompt: 'Review the task and say what is missing.',
					targetActorId: uuid(3),
					enabled: true,
					metadata: null,
					createdBy: uuid(2),
					createdAt: ago(20 * DAY),
					updatedAt: ago(2 * DAY),
				},
				{
					id: uuid(901),
					workspaceId: WORKSPACE_ID,
					name: 'Monday pipeline review',
					type: 'cron',
					config: { expression: '0 9 * * 1' },
					actionPrompt: 'Summarise the pipeline for the week.',
					targetActorId: uuid(5),
					enabled: true,
					metadata: null,
					createdBy: uuid(2),
					createdAt: ago(40 * DAY),
					updatedAt: ago(1 * DAY),
				},
			],
		}
	if (method === 'get' && /^\/api\/workspaces\/[^/]+\/members$/.test(path))
		return {
			body: actors.map((a) => ({
				actorId: a.id,
				role: a.id === uuid(2) ? 'owner' : 'member',
				joinedAt: ago(60 * DAY),
				name: a.name,
				type: a.type,
			})),
		}
	if (method === 'get' && path === '/api/actors')
		return { body: actors.map((a) => ({ ...item, ...a })) }
	// Session log reader: one finished session with a spread of envelope kinds, newest rows paged
	// by `before` / `since` the way the real route does.
	if (method === 'get' && path === '/api/sessions' && query.get('verbose') === 'true') {
		const wantsOutreach = !query.get('actor_id') || query.get('actor_id') === OUTREACH_AGENT
		const sessionRow = (over) => ({
			...item,
			workspaceId: WORKSPACE_ID,
			triggerId: null,
			containerId: null,
			config: null,
			result: null,
			snapshotPath: null,
			timeoutAt: null,
			createdBy: uuid(2),
			interactive: false,
			...over,
		})
		// One running session, so the agents list shows "1 working" and the agent page a live row.
		const running = wantsOutreach
			? [
					sessionRow({
						id: uuid(902),
						actorId: OUTREACH_AGENT,
						status: 'running',
						actionPrompt: 'Score the new Northwind leads',
						currentActivity: 'Reading the CRM export',
						startedAt: ago(4),
						completedAt: null,
						createdAt: ago(5),
						updatedAt: ago(1),
					}),
				]
			: []
		return {
			body: [
				...running,
				{
					...item,
					id: uuid(900),
					workspaceId: WORKSPACE_ID,
					actorId: query.get('actor_id') ?? OUTREACH_AGENT,
					triggerId: null,
					containerId: null,
					config: null,
					result: null,
					snapshotPath: null,
					currentActivity: null,
					timeoutAt: null,
					createdBy: uuid(2),
					updatedAt: ago(35),
					status: 'completed',
					actionPrompt: 'Draft the follow-up for Priya',
					interactive: false,
					startedAt: ago(40),
					completedAt: ago(35),
					createdAt: ago(41),
				},
			],
		}
	}
	const logsMatch = path.match(/^\/api\/sessions\/[^/]+\/logs$/)
	if (method === 'get' && logsMatch) {
		const env = (o) => JSON.stringify(o)
		const all = [
			{ stream: 'system', content: 'Container started' },
			{ stream: 'stdout', content: env({ type: 'system', subtype: 'init' }) },
			{
				stream: 'stdout',
				content: env({
					type: 'assistant',
					message: {
						content: [
							{ type: 'text', text: 'Reading the last thread with Priya before drafting.' },
						],
					},
				}),
			},
			{
				stream: 'stdout',
				content: env({
					type: 'assistant',
					message: { content: [{ type: 'tool_use', name: 'mcp__maskin__get_conversation' }] },
				}),
			},
			{ stream: 'stderr', content: 'warn: slow response from the mail provider (retrying)' },
			{
				stream: 'stdout',
				content: env({
					type: 'assistant',
					message: {
						content: [{ type: 'text', text: 'Draft is ready and waiting on your approval.' }],
					},
				}),
			},
			{
				stream: 'stdout',
				content: env({ type: 'result', is_error: false, result: 'Draft saved for review.' }),
			},
		].map((r, i) => ({ ...item, id: i + 1, sessionId: uuid(900), createdAt: ago(40 - i), ...r }))
		const since = Number(query.get('since') ?? 0)
		const before = Number(query.get('before') ?? Number.POSITIVE_INFINITY)
		let rows = all.filter((r) => r.id > since && r.id < before)
		if (query.get('order') === 'desc') rows = rows.reverse()
		return { body: rows.slice(0, Number(query.get('limit') ?? 100)) }
	}
	if (method === 'get' && path === '/api/integrations/providers') {
		const provider = (name, displayName, authType, externalIdDisplay = 'email') => ({
			...item,
			name,
			displayName,
			authType,
			externalIdDisplay,
			events: [],
		})
		return {
			body: [
				provider('github', 'GitHub', 'oauth2_custom', 'installation'),
				provider('slack', 'Slack', 'oauth2', 'installation'),
				provider('gmail', 'Gmail', 'oauth2'),
				provider('google-calendar', 'Google Calendar', 'oauth2'),
				provider('linear', 'Linear', 'oauth2'),
				provider('google-drive', 'Google Drive', 'oauth2'),
			],
		}
	}
	if (method === 'get' && path === '/api/integrations') {
		const row = (n, provider, externalId, over = {}) => ({
			...item,
			id: uuid(n),
			workspaceId: WORKSPACE_ID,
			provider,
			status: 'active',
			externalId,
			config: null,
			actorId: null,
			createdBy: ME.id,
			createdAt: ago(30 * DAY),
			updatedAt: ago(DAY),
			missingScopes: [],
			needsReconnect: false,
			...over,
		})
		return {
			body: [
				row(950, 'gmail', 'sindre@northwind.example'),
				row(951, 'slack', 'northwind'),
				row(952, 'github', 'northwind-labs', {
					needsReconnect: true,
					missingScopes: ['workflow'],
				}),
			],
		}
	}
	// A trial a few days from its end, with a credit meter, so Billing shows its banner and bar.
	if (method === 'get' && path === '/api/billing/usage') {
		return {
			body: {
				...base,
				plan: 'trial',
				status: 'active',
				usd_cents_used: 4120,
				hard_cap_usd_cents: 10000,
				period_start: Date.now() - 9 * DAY * 60_000,
				period_resets_in_ms: 5 * DAY * 60_000,
				credit_balance_cents: 4120,
				credit_topup_available: false,
			},
		}
	}
	if (method === 'get' && path === '/api/subscriptions/unread') return { body: unreadFeed(item) }
	if (method === 'get' && path === '/api/briefing') {
		return {
			body: { workspace_id: WORKSPACE_ID, markdown: '## Good morning\n\nTwo things need you.' },
		}
	}
	if (method === 'post' && path === '/api/briefing/spoken') {
		return {
			body: {
				headline: 'Good morning',
				script:
					'Good morning. Two things need you before noon. Seven follow-ups to Northwind are ready to send. The Q4 webinar needs a spend decision. Replies are up eighteen percent this week.',
			},
		}
	}
	if (method === 'get' && path === '/api/loops')
		return { body: { loops: flows.map((f) => loopRow(f, item)) } }
	if (method === 'get' && /^\/api\/loops\/[^/]+\/(steps|activity)$/.test(path)) return null
	// A flow's graph (its attached page) and an object's graph.
	if (method === 'get' && /^\/api\/objects\/[^/]+\/graph$/.test(path)) {
		const id = params[0]
		const events = postedComments.get(id) ?? []
		const flow = flows.find((f) => uuid(f.n) === id)
		if (flow) {
			return {
				body: {
					...base,
					events,
					object: {
						...base.object,
						id,
						workspaceId: WORKSPACE_ID,
						type: 'loop',
						title: flow.name,
						status: flow.status,
					},
					relationships: [
						{
							id: uuid(flow.n + 500),
							sourceType: 'object',
							sourceId: id,
							sourceTitle: flow.name,
							targetType: 'file',
							targetId: pageId(flow),
							targetTitle: `${flow.headline}.html`,
							type: 'attached',
							metadata: null,
							createdBy: CHIEF,
							createdAt: ago(60),
						},
					],
					files: [
						{
							id: pageId(flow),
							name: `${flow.headline}.html`,
							mimeType: 'text/html',
							sizeBytes: 400,
							url: 'https://maskin.io',
						},
					],
				},
			}
		}
		const d = decisions.find((x) => x.obj.id === id)
		if (d) return { body: { ...base, object: d.obj, events } }
		return events.length ? { body: { ...base, events } } : null
	}
	if (method === 'get' && path === '/api/files') {
		const ids = (query.get('ids') ?? '').split(',').filter(Boolean)
		const rows = flows
			.filter((f) => !ids.length || ids.includes(pageId(f)))
			.map((f) => ({
				...item,
				id: pageId(f),
				workspaceId: WORKSPACE_ID,
				name: `${f.headline}.html`,
				description: null,
				mimeType: 'text/html',
				sizeBytes: 400,
				storageKey: 'k',
				createdBy: CHIEF,
				createdAt: ago(60),
				updatedAt: ago(60 + f.n - 200),
			}))
		return { body: rows }
	}
	const fileMatch = path.match(/^\/api\/files\/([^/]+)$/)
	if (method === 'get' && fileMatch) {
		const f = flows.find((x) => pageId(x) === fileMatch[1])
		if (f) {
			return {
				body: {
					...base,
					id: pageId(f),
					workspaceId: WORKSPACE_ID,
					name: `${f.headline}.html`,
					description: null,
					mimeType: 'text/html',
					sizeBytes: 400,
					createdBy: CHIEF,
					createdAt: ago(60),
					updatedAt: ago(60),
					content: pageHtml(f),
					encoding: 'utf8',
					url: 'https://maskin.io',
				},
			}
		}
		return null
	}
	if (method === 'get' && path === '/api/conversations') {
		return {
			body: {
				conversations: rooms.map((r) => ({
					...item,
					id: uuid(r.n),
					workspaceId: WORKSPACE_ID,
					title: r.title,
					createdBy: ME.id,
					lastMessageAt: ago(r.at),
					createdAt: ago(5 * DAY),
					updatedAt: ago(r.at),
					pinned: false,
					archived: false,
					unread_count: r.unread,
					snippet: r.snippet,
					snippet_actor_id: r.with[0],
					snippet_actor_name: r.by,
					participants: [...r.with.map(participantRow), participantRow(ME.id)],
				})),
				has_more: false,
			},
		}
	}
	if (method === 'post' && path === '/api/conversations') {
		// "Ask Chief of Staff" about a card: answer with the standing Chief of Staff room.
		const r = rooms[0]
		return {
			status: 201,
			body: {
				...base,
				id: uuid(r.n),
				workspaceId: WORKSPACE_ID,
				title: r.title,
				createdBy: ME.id,
				lastMessageAt: ago(r.at),
				createdAt: ago(5 * DAY),
				updatedAt: ago(r.at),
				pinned: false,
				archived: false,
				unread_count: 0,
				participants: [...r.with.map(participantRow), participantRow(ME.id)],
				last_read_message_id: 0,
			},
		}
	}
	const convoMatch = path.match(/^\/api\/conversations\/([^/]+)$/)
	if (method === 'get' && convoMatch) {
		const r = rooms.find((x) => uuid(x.n) === convoMatch[1])
		if (r) {
			return {
				body: {
					...base,
					id: uuid(r.n),
					workspaceId: WORKSPACE_ID,
					title: r.title,
					createdBy: ME.id,
					lastMessageAt: ago(r.at),
					createdAt: ago(5 * DAY),
					updatedAt: ago(r.at),
					pinned: false,
					archived: false,
					unread_count: r.unread,
					participants: [...r.with.map(participantRow), participantRow(ME.id)],
					last_read_message_id: 0,
				},
			}
		}
		return null
	}
	const msgMatch = path.match(/^\/api\/conversations\/([^/]+)\/messages$/)
	if (method === 'get' && msgMatch) {
		const r = rooms.find((x) => uuid(x.n) === msgMatch[1])
		if (!r) return null
		const m = (id, actor, text, at) => ({
			...item,
			id,
			conversationId: uuid(r.n),
			actorId: actor.id,
			actorName: actor.name,
			actorType: actor.type ?? 'human',
			kind: 'message',
			content: text,
			metadata: null,
			sessionId: null,
			createdAt: ago(at),
			editedAt: null,
			// null, as the real API sends it: a number (even 0) marks the message as a thread reply
			// and the app then hides it from the main chat.
			threadRootId: null,
			threadAlsoInChannel: false,
			thread: null,
			spawned_sessions: [],
			reactions: [],
		})
		const first = actors.find((a) => a.id === r.with[0])
		if (r.n === 300) {
			return {
				body: {
					messages: [
						m(1, first, 'Seven follow-ups to Northwind are ready.', 30),
						m(2, ME, 'Why not all 47 contacts?', 20),
						m(3, first, 'Only 7 have Sales approval. The other 40 still need review.', 10),
					],
					has_more: false,
				},
			}
		}
		if (r.n === 303) {
			const ask = (id, text, metadata, at) => ({ ...m(id, first, text, at), metadata })
			const session = uuid(902)
			return {
				body: {
					messages: [
						m(1, ME, 'Can you run the webinar follow-ups?', 300),
						ask(
							2,
							'I need a key for the email provider.',
							{
								keychain_request: {
									session_id: session,
									kind: 'api_key',
									suggested_name: 'Resend API key',
									hint: 'Create one under API keys in Resend.',
								},
							},
							200,
						),
						ask(
							3,
							'I would like to use the Linear tool server.',
							{
								mcp_server_request: {
									session_id: session,
									name: 'linear',
									type: 'http',
									url: 'https://mcp.linear.app/mcp',
									hint: 'To file the follow-up tasks.',
								},
							},
							120,
						),
						ask(
							4,
							'I need to read your Gmail to find the signups.',
							{
								integration_access_request: {
									session_id: session,
									integration_id: uuid(950),
									display_name: 'Gmail',
									level: 'read',
									reason: 'To find the webinar signups.',
								},
							},
							60,
						),
					],
					has_more: false,
				},
			}
		}
		if (r.n === 302) {
			// One real thread, shaped as the API sends it: the root carries a `thread` summary, each reply
			// carries the root's id (and is hidden from the main timeline), and `?thread_root_id=` returns
			// only the replies. MK-04 depends on this; do not reword the texts without updating it.
			const root = {
				...m(3, ME, 'Can you also check the pricing page?', 40),
				thread: {
					replyCount: 2,
					unreadCount: 0,
					lastReplyId: 5,
					lastReplyAt: ago(20),
					participants: [participantRow(ME.id), participantRow(first.id)],
				},
			}
			const replies = [
				{ ...m(4, first, 'Yes, the pricing page looks right.', 30), threadRootId: 3 },
				{ ...m(5, ME, 'Thanks, I will ship it today.', 20), threadRootId: 3 },
			]
			const wanted = query.get('thread_root_id')
			return {
				body: {
					messages: wanted
						? replies.filter((x) => x.threadRootId === Number(wanted))
						: [
								m(1, ME, 'Where are we on the Northwind follow-ups?', r.at + 12),
								m(2, first, r.snippet, r.at),
								root,
								...replies,
								// MK-05: a long email draft linked in the chat. This chat, not an agent chat: the Live
								// tests leave a call record in those, which folds later messages into a call card.
								m(
									6,
									first,
									`Not sent yet. Here is the draft:\n\nhttps://maskin.io/${WORKSPACE_ID}/objects/${uuid(7001)}\n\nReply "send" and it goes out.`,
									1,
								),
							],
					has_more: false,
				},
			}
		}
		return {
			body: {
				messages: [
					m(1, ME, 'Where are we on the Northwind follow-ups?', r.at + 12),
					m(2, first, r.snippet, r.at),
				],
				has_more: false,
			},
		}
	}
	if (method === 'get' && path === `/api/objects/${uuid(7001)}`) {
		return {
			body: {
				...base,
				id: uuid(7001),
				workspaceId: WORKSPACE_ID,
				type: 'task',
				title: 'Email Jorgen Moller Nielsen (Orsted) - idea deck after the coffee',
				content: 'Draft email body.',
				status: 'in_progress',
				metadata: {},
				driver: CHIEF,
				activeSessionId: null,
				createdBy: CHIEF,
				createdAt: ago(60),
				updatedAt: ago(5),
				preview: {
					kind: 'email',
					label: 'Email',
					provider: 'gmail',
					recipients: [{ role: 'to', name: 'Jorgen', address: 'jorni@orsted.example' }],
					subject: 'Idea deck after the coffee',
					details: [],
					context: null,
					body: Array.from(
						{ length: 6 },
						(_, i) =>
							`Paragraph ${i + 1}. Tak for kaffen i dag, her er de syv slides som lovet, med de tre ideer vi talte om.`,
					).join('\n\n'),
					maxLength: null,
					missing: [],
					warnings: [],
					content_hash: 'hash-7001',
					delivery: { state: 'draft', at: null },
				},
			},
		}
	}
	if (method === 'get' && path === '/api/objects') {
		return {
			body: decisions.map((d) => ({ ...item, ...d.obj })),
		}
	}
	return null
}
