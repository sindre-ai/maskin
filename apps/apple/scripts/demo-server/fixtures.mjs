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
const participant = (id) => {
	const a = actors.find((x) => x.id === id)
	return { id, name: a.name, type: a.type, kind: a.type }
}

// The create and detail responses list participants as full rows rather than the list's summaries.
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

export function overrides({ method, path, params, query, base, item }) {
	if (method !== 'get' && method !== 'post') return null
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
	if (method === 'get' && path === '/api/actors')
		return { body: actors.map((a) => ({ ...item, ...a })) }
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
		const flow = flows.find((f) => uuid(f.n) === id)
		if (flow) {
			return {
				body: {
					...base,
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
		if (d) return { body: { ...base, object: d.obj } }
		return null
	}
	if (method === 'get' && path === '/api/files') {
		const ids = (query.get('ids') ?? '').split(',').filter(Boolean)
		const rows = flows
			.filter((f) => ids.includes(pageId(f)))
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
					participants: [...r.with.map(participant), participant(ME.id)],
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
			spawned_sessions: [],
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
	if (method === 'get' && path === '/api/objects') {
		return {
			body: decisions.map((d) => ({ ...item, ...d.obj })),
		}
	}
	return null
}
