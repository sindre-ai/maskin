// Demo data for the must-keep rows MK-10 and up (docs/must-keep-features.md). Kept apart from
// fixtures.mjs so the first rows' data and this data do not touch the same lines.
//
// One new chat, "Contoso renewal" (room 304), nobody else uses it, so edits, reactions and sends here
// cannot change what another row sees:
//   - a thread whose replies include one from an agent (MK-10, MK-11)
//   - an older message of yours, which can be edited (MK-15a), and an agent message to react to (MK-15b)
//   - a send that the server refuses when the text says REJECT, which leaves an unsent message (MK-15c)
// plus the Threads list (MK-11) and one integration that connects with a pasted key (MK-17).

// The same ids as fixtures.mjs.
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ME = { id: uuid(2), name: 'Sindre Aasen' }
const CHIEF = { id: uuid(3), name: 'Chief of Staff', type: 'agent' }
const DAY = 24 * 60
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString()

export const CONTOSO_ROOM = {
	n: 304,
	title: 'Contoso renewal',
	with: [CHIEF.id],
	unread: 0,
	snippet: 'Draft the counter offer for Contoso.',
	by: 'Sindre Aasen',
	// Old enough to sort below the other chats, so the Chats list the other rows read keeps its order.
	at: 2 * DAY + 30,
}

const ROOM_ID = uuid(CONTOSO_ROOM.n)
const ROOT_ID = 2

// What the demo remembers, so a refetch shows the same as the screen did.
const edited = new Map() // message id -> { content, editedAt }
const reactions = new Map() // message id -> [{ emoji, count, reactedByMe, actors }]
const connectedKeyProviders = []

/** Providers connected with a pasted key during this run, for the Connected tab. */
export const keyConnected = () => [...connectedKeyProviders]

const person = (a) => ({ actorId: a.id, actorName: a.name, actorType: a.type ?? 'human' })

function message(id, actor, content, at, over = {}) {
	return {
		id,
		conversationId: ROOM_ID,
		actorId: actor.id,
		actorName: actor.name,
		actorType: actor.type ?? 'human',
		kind: 'message',
		content,
		metadata: null,
		sessionId: null,
		createdAt: ago(at),
		editedAt: null,
		deletedAt: null,
		// null, as the real API sends it: a number marks the message as a thread reply.
		threadRootId: null,
		threadAlsoInChannel: false,
		...over,
	}
}

const root = () =>
	message(ROOT_ID, ME, 'Which clause did Legal flag?', 2 * DAY + 50, {
		thread: {
			replyCount: 2,
			unreadCount: 0,
			lastReplyId: 4,
			lastReplyAt: ago(2 * DAY + 40),
			participants: [person(ME), person(CHIEF)],
		},
	})

// Replies: the first is the agent's. MK-10 and MK-11 look for its words; do not reword them
// without updating those tests.
const replies = () => [
	message(3, CHIEF, 'Clause 7. Auto-renewal needs 60 days notice, not 30.', 2 * DAY + 45, {
		threadRootId: ROOT_ID,
	}),
	message(4, ME, 'Thanks, I will raise it with Contoso.', 2 * DAY + 40, { threadRootId: ROOT_ID }),
]

function timeline() {
	return [
		message(1, CHIEF, 'Contoso asked for a 12-month term at the current rate.', 2 * DAY + 60),
		root(),
		...replies(),
		message(5, ME, 'Draft the counter offer for Contoso.', 2 * DAY + 30),
	].map((m) => ({
		...m,
		...(edited.get(m.id) ?? {}),
		reactions: reactions.get(m.id) ?? [],
		spawned_sessions: [],
		thread: m.thread ?? null,
	}))
}

/**
 * Answers the routes the must-keep rows MK-10 and up need, or returns null. Called before the
 * rest of `overrides`, which skips everything but GET and POST.
 */
export function mustKeepMore({ method, path, query, body, item }) {
	if (method === 'get' && path === '/api/conversations/threads') {
		return {
			body: {
				threads: [
					{
						conversationId: ROOM_ID,
						conversationTitle: CONTOSO_ROOM.title,
						root: root(),
						thread: root().thread,
						lastReply: replies()[1],
					},
				],
			},
		}
	}

	const messages = path.match(/^\/api\/conversations\/([^/]+)\/messages$/)
	if (messages?.[1] === ROOM_ID) {
		if (method === 'get') {
			const wanted = query.get('thread_root_id')
			const all = timeline().map((m) => ({ ...item, ...m }))
			return {
				body: {
					messages: wanted ? all.filter((m) => m.threadRootId === Number(wanted)) : all,
					has_more: false,
				},
			}
		}
		// The server refuses this send, so the app keeps it as an unsent message (MK-15c).
		if (method === 'post' && typeof body?.content === 'string' && body.content.includes('REJECT')) {
			return {
				status: 400,
				body: {
					error: { code: 'DEMO_REJECTED', message: 'The demo server refuses this message.' },
				},
			}
		}
		return null
	}

	const one = path.match(/^\/api\/conversations\/([^/]+)\/messages\/(\d+)$/)
	if (one?.[1] === ROOM_ID && method === 'patch' && typeof body?.content === 'string') {
		const id = Number(one[2])
		edited.set(id, { content: body.content, editedAt: new Date().toISOString() })
		const saved = timeline().find((m) => m.id === id)
		return saved ? { body: saved } : { status: 404, body: { error: { code: 'NOT_FOUND' } } }
	}

	// React: PUT adds the emoji for you, DELETE takes it back.
	const react = path.match(/^\/api\/conversations\/([^/]+)\/messages\/(\d+)\/reactions$/)
	if (react?.[1] === ROOM_ID && (method === 'put' || method === 'delete')) {
		const id = Number(react[2])
		const emoji = method === 'put' ? body?.emoji : query.get('emoji')
		const others = (reactions.get(id) ?? []).filter((r) => r.emoji !== emoji)
		reactions.set(
			id,
			method === 'put'
				? [
						...others,
						{
							emoji,
							count: 1,
							reactedByMe: true,
							actors: [{ actorId: ME.id, actorName: ME.name }],
						},
					]
				: others,
		)
		return { status: 204, body: {} }
	}

	// Connect a provider with a pasted key (PostHog).
	const connect = path.match(/^\/api\/integrations\/([^/]+)\/connect$/)
	if (method === 'post' && connect && typeof body?.api_key === 'string') {
		if (!connectedKeyProviders.includes(connect[1])) connectedKeyProviders.push(connect[1])
		return { body: {} }
	}
	return null
}
