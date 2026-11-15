import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	chatSectionItems,
	chatSections,
	conversationParticipants,
	conversations,
	messages,
	notifications,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { OPEN_CARD_MAX_AGE_DAYS } from '../../services/chat-unread'
import { directPairKey } from '../../services/direct-chat'
import {
	ensureWorkspaceMember,
	insertActor,
	insertConversation,
	insertNotification,
	insertSession,
	insertWorkspace,
} from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: conversationsRoutes } = await import('../../routes/conversations')
const { default: workspacesRoutes } = await import('../../routes/workspaces')

/**
 * What waits on a person in their chats, and the automatic views built on it: Waiting on you,
 * Running and Quiet. A chat is unread only for an unread mention of the caller or an open card for
 * them (an agent's question, or an unanswered request card, newer than 14 days); a plain new message
 * does not count, except in a direct chat with an agent. The same rule sits behind the row badge,
 * the unread filter, the per-workspace count and the quiet rules, so these tests run them together.
 */

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

type Row = {
	id: string
	title: string
	unread_count: number
	mentions_unread: number
	open_cards: number
	card_text: string | null
	agent_running: boolean
	sectionId: string | null
	lastMessageAt: string | null
}

function createApp(actorId: string) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		await next()
	})
	app.route('/api/conversations', conversationsRoutes)
	app.route('/api/workspaces', workspacesRoutes)
	return app
}

const DAY = 86_400_000

describe('chat list: what waits on you, and the automatic views', () => {
	let workspaceId: string
	let me: string
	let agentId: string
	let retiredId: string
	let headers: Record<string, string>

	beforeEach(async () => {
		me = getTestActorId()
		workspaceId = (await insertWorkspace(db, me)).id
		agentId = (await insertActor(db, { type: 'agent', description: 'Builds things' })).id
		retiredId = (await insertActor(db, { type: 'agent', description: 'RETIRED, merged away' })).id
		for (const actorId of [agentId, retiredId])
			await ensureWorkspaceMember(db, workspaceId, actorId)
		headers = { 'x-workspace-id': workspaceId }
	})

	/**
	 * A chat the caller is in with `others`. `messages` are written in order; a message from the
	 * caller leaves the read marker behind it, one from anybody else does not.
	 */
	async function seedChat(
		title: string,
		others: string[],
		opts: {
			direct?: boolean
			daysAgo?: number
			pinned?: boolean
			room?: boolean
			subject?: boolean
			posts?: Array<{ from: string; mentionsMe?: boolean; metadata?: Record<string, unknown> }>
		} = {},
	) {
		const chat = await insertConversation(db, workspaceId, me, {
			title,
			directPairKey: opts.direct ? directPairKey(me, others[0] as string) : null,
			lastMessageAt: new Date(Date.now() - (opts.daysAgo ?? 0) * DAY),
			isRoom: opts.room ?? false,
			...(opts.subject ? { subjectType: 'object', subjectId: crypto.randomUUID() } : {}),
		})
		await db
			.insert(conversationParticipants)
			.values([
				{ conversationId: chat.id, actorId: me, pinned: opts.pinned ?? false },
				...others.map((actorId) => ({ conversationId: chat.id, actorId })),
			])
		let lastMine: number | null = null
		for (const [i, post] of (opts.posts ?? []).entries()) {
			const [row] = await db
				.insert(messages)
				.values({
					conversationId: chat.id,
					actorId: post.from,
					content: `${title} message ${i}`,
					metadata: post.mentionsMe
						? { ...post.metadata, mentions: [me] }
						: (post.metadata ?? null),
				})
				.returning()
			if (post.from === me) lastMine = row?.id ?? lastMine
		}
		if (lastMine !== null) {
			await db
				.update(conversationParticipants)
				.set({ lastReadMessageId: lastMine })
				.where(
					and(
						eq(conversationParticipants.conversationId, chat.id),
						eq(conversationParticipants.actorId, me),
					),
				)
		}
		return chat.id
	}

	/** An agent's question to the caller in a chat: the notification the ask route makes. */
	const askQuestion = (
		chatId: string,
		over: { text?: string; status?: string; daysOld?: number; target?: string } = {},
	) =>
		insertNotification(db, workspaceId, agentId, {
			type: 'needs_input',
			status: over.status ?? 'pending',
			targetActorId: over.target ?? me,
			content: over.text ?? 'Which colour do you want?',
			createdAt: new Date(Date.now() - (over.daysOld ?? 0) * DAY),
			metadata: { push_category: 'needs_you', conversation_id: chatId, message_id: 1 },
		})

	/** A keychain request card in a chat, from the agent. */
	const requestCard = async (
		chatId: string,
		over: { daysOld?: number; answered?: boolean } = {},
	) => {
		const [row] = await db
			.insert(messages)
			.values({
				conversationId: chatId,
				actorId: agentId,
				content: 'Please add an API key',
				createdAt: new Date(Date.now() - (over.daysOld ?? 0) * DAY),
				metadata: {
					keychain_request: { session_id: crypto.randomUUID(), kind: 'api_key' },
					...(over.answered
						? { card_resolved: { at: new Date().toISOString(), by_actor_id: me, outcome: 'done' } }
						: {}),
				},
			})
			.returning()
		return row
	}

	async function rows(query = '', as = me) {
		const res = await createApp(as).request(
			jsonGet(`/api/conversations?limit=100&${query}`, headers),
		)
		expect(res.status).toBe(200)
		return ((await res.json()) as { conversations: Row[] }).conversations
	}
	const titles = async (query = '') => (await rows(query)).map((c) => c.title).sort()
	const byTitle = async (title: string) => (await rows()).find((c) => c.title === title) as Row

	async function workspaceUnreadChats() {
		const res = await createApp(me).request(jsonGet('/api/workspaces/counts'))
		const counts = (await res.json()) as Array<{ workspaceId: string; unreadChats: number }>
		return counts.find((r) => r.workspaceId === workspaceId)?.unreadChats ?? 0
	}

	describe('unread', () => {
		it('counts an unread mention, not a plain new message, in a chat with other people', async () => {
			await seedChat('plain', [agentId], { posts: [{ from: agentId }, { from: agentId }] })
			await seedChat('mention', [agentId], {
				posts: [{ from: agentId }, { from: agentId, mentionsMe: true }],
			})

			expect(await byTitle('plain')).toMatchObject({ unread_count: 0, mentions_unread: 0 })
			expect(await byTitle('mention')).toMatchObject({ unread_count: 1, mentions_unread: 1 })
			expect(await titles('unread_only=true')).toEqual(['mention'])
		})

		it('stops counting a mention once the caller has read past it', async () => {
			await seedChat('read mention', [agentId], {
				posts: [{ from: agentId, mentionsMe: true }, { from: me }],
			})
			expect(await byTitle('read mention')).toMatchObject({ unread_count: 0, mentions_unread: 0 })
		})

		it('ignores the caller’s own mention of themselves', async () => {
			await seedChat('self', [agentId], { posts: [{ from: me, mentionsMe: true }] })
			expect((await byTitle('self')).mentions_unread).toBe(0)
		})

		it('counts every new message in a direct chat with an agent', async () => {
			await seedChat('agent dm', [agentId], {
				direct: true,
				posts: [{ from: agentId }, { from: agentId }, { from: agentId }],
			})
			expect(await byTitle('agent dm')).toMatchObject({ unread_count: 3, mentions_unread: 0 })
			expect(await titles('unread_only=true')).toEqual(['agent dm'])
		})

		it('does not count a plain message in a direct chat between two people', async () => {
			// A direct chat between two people is titled with the other person's name.
			const colleague = (await insertActor(db, { type: 'human', name: 'people dm' })).id
			await ensureWorkspaceMember(db, workspaceId, colleague)
			await seedChat('people dm', [colleague], { direct: true, posts: [{ from: colleague }] })
			expect((await byTitle('people dm')).unread_count).toBe(0)
		})

		it('counts an open question from an agent as a card with its text, until it is answered', async () => {
			const chat = await seedChat('question', [agentId], { posts: [{ from: agentId }] })
			const question = await askQuestion(chat, { text: 'Which colour do you want?' })

			expect(await byTitle('question')).toMatchObject({
				unread_count: 1,
				open_cards: 1,
				card_text: 'Which colour do you want?',
			})

			await db
				.update(notifications)
				.set({ status: 'resolved', resolvedAt: new Date() })
				.where(eq(notifications.id, question?.id as string))
			expect(await byTitle('question')).toMatchObject({
				unread_count: 0,
				open_cards: 0,
				card_text: null,
			})
		})

		it('counts an unanswered request card, and stops when it is answered', async () => {
			const chat = await seedChat('request', [agentId], { posts: [{ from: agentId }] })
			const card = await requestCard(chat)
			expect(await byTitle('request')).toMatchObject({
				unread_count: 1,
				open_cards: 1,
				card_text: 'Please add an API key',
			})

			await db
				.update(messages)
				.set({
					metadata: {
						...(card?.metadata as object),
						card_resolved: { at: new Date().toISOString(), by_actor_id: me, outcome: 'done' },
					},
				})
				.where(eq(messages.id, card?.id as number))
			expect(await byTitle('request')).toMatchObject({ unread_count: 0, open_cards: 0 })
		})

		it('does not count cards older than 14 days', async () => {
			const chat = await seedChat('old cards', [agentId], { posts: [{ from: agentId }] })
			await askQuestion(chat, { daysOld: OPEN_CARD_MAX_AGE_DAYS + 1 })
			await requestCard(chat, { daysOld: OPEN_CARD_MAX_AGE_DAYS + 1 })
			expect(await byTitle('old cards')).toMatchObject({ unread_count: 0, open_cards: 0 })

			const fresh = await seedChat('fresh cards', [agentId], { posts: [{ from: agentId }] })
			await askQuestion(fresh, { daysOld: OPEN_CARD_MAX_AGE_DAYS - 1 })
			expect((await byTitle('fresh cards')).open_cards).toBe(1)
		})

		it('leaves out cards that are not the caller’s or did not come from this chat', async () => {
			const colleague = (await insertActor(db, { type: 'human', name: 'Colleague' })).id
			await ensureWorkspaceMember(db, workspaceId, colleague)
			const chat = await seedChat('someone else’s question', [agentId, colleague], {
				posts: [{ from: agentId }],
			})
			await askQuestion(chat, { target: colleague })
			// A card from a scheduled or flow session carries no chat id, so it stays in For You only.
			await insertNotification(db, workspaceId, agentId, {
				type: 'needs_input',
				status: 'pending',
				targetActorId: me,
				metadata: { kind: 'for_you' },
			})
			expect(await byTitle('someone else’s question')).toMatchObject({
				unread_count: 0,
				open_cards: 0,
			})
			expect(await workspaceUnreadChats()).toBe(0)
		})

		it('adds mentions and open cards into the one badge number', async () => {
			const chat = await seedChat('both', [agentId], {
				posts: [
					{ from: agentId, mentionsMe: true },
					{ from: agentId, mentionsMe: true },
				],
			})
			await askQuestion(chat)
			await requestCard(chat)
			expect(await byTitle('both')).toMatchObject({
				unread_count: 4,
				mentions_unread: 2,
				open_cards: 2,
			})
		})

		it('uses one rule for the badge, the unread filter, the workspace count and search', async () => {
			await seedChat('mention', [agentId], { posts: [{ from: agentId, mentionsMe: true }] })
			const withCard = await seedChat('card', [agentId], { posts: [{ from: agentId }] })
			await askQuestion(withCard)
			await seedChat('plain', [agentId], { posts: [{ from: agentId }] })
			await seedChat('agent dm', [retiredId], { direct: true, posts: [{ from: retiredId }] })

			const badge = (await rows())
				.filter((c) => c.unread_count > 0)
				.map((c) => c.title)
				.sort()
			expect(badge).toEqual(['agent dm', 'card', 'mention'])
			expect(await titles('unread_only=true')).toEqual(badge)
			expect(await workspaceUnreadChats()).toBe(badge.length)
		})
	})

	describe('views', () => {
		it('Waiting on you lists chats with an unread mention or an open card, and nothing else', async () => {
			await seedChat('mention', [agentId], { posts: [{ from: agentId, mentionsMe: true }] })
			const withCard = await seedChat('card', [agentId], { posts: [{ from: agentId }] })
			await askQuestion(withCard)
			await seedChat('plain', [agentId], { posts: [{ from: agentId }] })
			// Every message counts in a direct chat with an agent, but it is not waiting on the person.
			await seedChat('agent dm', [retiredId], { direct: true, posts: [{ from: retiredId }] })

			expect(await titles('view=waiting')).toEqual(['card', 'mention'])
		})

		it('Running lists chats where an agent has an open turn, and no others', async () => {
			const running = await seedChat('running', [agentId], { posts: [{ from: me }] })
			await seedChat('idle', [agentId], { posts: [{ from: me }] })
			await insertSession(db, workspaceId, agentId, me, {
				conversationId: running,
				status: 'running',
				interactive: false,
			})

			expect(await titles('view=running')).toEqual(['running'])
			expect((await byTitle('running')).agent_running).toBe(true)
			expect((await byTitle('idle')).agent_running).toBe(false)
		})

		it('Quiet lists topic chats with an agent that nobody wrote in for 7 days, and chats with a retired agent', async () => {
			await seedChat('quiet', [agentId], { daysAgo: 8, posts: [{ from: me }] })
			await seedChat('recent', [agentId], { daysAgo: 6, posts: [{ from: me }] })
			await seedChat('retired', [retiredId], { posts: [{ from: me }] })

			expect(await titles('view=quiet')).toEqual(['quiet', 'retired'])
			expect(await titles('hide_quiet=true')).toEqual(['recent'])
		})

		it('keeps a lasting chat out of Quiet: pinned, a room, in a section, running, or waiting on you', async () => {
			await seedChat('pinned', [agentId], { daysAgo: 30, pinned: true, posts: [{ from: me }] })
			await seedChat('room', [agentId], { daysAgo: 30, room: true, posts: [{ from: me }] })
			const filed = await seedChat('filed', [agentId], { daysAgo: 30, posts: [{ from: me }] })
			const running = await seedChat('running', [agentId], { daysAgo: 30, posts: [{ from: me }] })
			const asked = await seedChat('asked', [agentId], { daysAgo: 30, posts: [{ from: agentId }] })
			await seedChat('mentioned', [agentId], {
				daysAgo: 30,
				posts: [{ from: agentId, mentionsMe: true }],
			})
			await seedChat('really quiet', [agentId], { daysAgo: 30, posts: [{ from: me }] })

			const [section] = await db
				.insert(chatSections)
				.values({ workspaceId, actorId: me, name: 'Keep', position: 0 })
				.returning()
			await db
				.insert(chatSectionItems)
				.values({ sectionId: section?.id as string, conversationId: filed, actorId: me })
			await insertSession(db, workspaceId, agentId, me, {
				conversationId: running,
				status: 'running',
				interactive: false,
			})
			await askQuestion(asked)

			expect(await titles('view=quiet')).toEqual(['really quiet'])
			const shown = await titles('hide_quiet=true')
			for (const t of ['pinned', 'room', 'filed', 'running', 'asked', 'mentioned']) {
				expect(shown).toContain(t)
			}
			expect(shown).not.toContain('really quiet')
		})

		it('another person’s section does not keep a chat out of Quiet for the caller', async () => {
			const colleague = (await insertActor(db, { type: 'human', name: 'Colleague' })).id
			await ensureWorkspaceMember(db, workspaceId, colleague)
			const chat = await seedChat('shared quiet', [agentId], { daysAgo: 30, posts: [{ from: me }] })
			const [theirs] = await db
				.insert(chatSections)
				.values({ workspaceId, actorId: colleague, name: 'Theirs', position: 0 })
				.returning()
			await db
				.insert(chatSectionItems)
				.values({ sectionId: theirs?.id as string, conversationId: chat, actorId: colleague })

			expect(await titles('view=quiet')).toEqual(['shared quiet'])
		})

		it('Quiet rows carry the time of their last message', async () => {
			await seedChat('quiet', [agentId], { daysAgo: 9, posts: [{ from: me }] })
			const [row] = await rows('view=quiet')
			expect(row?.lastMessageAt).toBeTruthy()
			expect(Date.now() - new Date(row?.lastMessageAt as string).getTime()).toBeGreaterThan(8 * DAY)
		})

		it('combines a view with the other filters', async () => {
			await seedChat('pinned mention', [agentId], {
				pinned: true,
				posts: [{ from: agentId, mentionsMe: true }],
			})
			await seedChat('mention', [agentId], { posts: [{ from: agentId, mentionsMe: true }] })
			expect(await titles('view=waiting&pinned=true')).toEqual(['pinned mention'])
		})

		it('leaves archived chats out of every view unless archived is asked for', async () => {
			const chat = await seedChat('archived mention', [agentId], {
				posts: [{ from: agentId, mentionsMe: true }],
			})
			await db
				.update(conversationParticipants)
				.set({ archived: true })
				.where(
					and(
						eq(conversationParticipants.conversationId, chat),
						eq(conversationParticipants.actorId, me),
					),
				)
			expect(await titles('view=waiting')).toEqual([])
			expect(await titles('view=waiting&archived=true')).toEqual(['archived mention'])
		})
	})

	describe('no chat is missing from every view', () => {
		it('every chat with a message is in the default list or in Quiet, and never in both', async () => {
			const colleague = (await insertActor(db, { type: 'human', name: 'people dm' })).id
			await ensureWorkspaceMember(db, workspaceId, colleague)
			const mine = [
				[
					'agent dm',
					await seedChat('agent dm', [agentId], { direct: true, posts: [{ from: agentId }] }),
				],
				[
					'retired dm',
					await seedChat('retired dm', [retiredId], { direct: true, posts: [{ from: me }] }),
				],
				[
					'people dm',
					await seedChat('people dm', [colleague], { direct: true, posts: [{ from: colleague }] }),
				],
				[
					'recent topic',
					await seedChat('recent topic', [agentId], { daysAgo: 2, posts: [{ from: me }] }),
				],
				[
					'old topic',
					await seedChat('old topic', [agentId], { daysAgo: 40, posts: [{ from: me }] }),
				],
				['retired topic', await seedChat('retired topic', [retiredId], { posts: [{ from: me }] })],
				[
					'old pinned',
					await seedChat('old pinned', [agentId], {
						daysAgo: 40,
						pinned: true,
						posts: [{ from: me }],
					}),
				],
				[
					'old room',
					await seedChat('old room', [agentId], { daysAgo: 40, room: true, posts: [{ from: me }] }),
				],
				[
					'old subject',
					await seedChat('old subject', [agentId], {
						daysAgo: 40,
						subject: true,
						posts: [{ from: me }],
					}),
				],
				[
					'old group',
					await seedChat('old group', [agentId, retiredId], { daysAgo: 40, posts: [{ from: me }] }),
				],
				[
					'old people',
					await seedChat('old people', [colleague], { daysAgo: 40, posts: [{ from: me }] }),
				],
				[
					'old mention',
					await seedChat('old mention', [agentId], {
						daysAgo: 40,
						posts: [{ from: agentId, mentionsMe: true }],
					}),
				],
			] as const

			const everything = await titles()
			const defaultList = await titles('hide_quiet=true')
			const quiet = await titles('view=quiet')

			// Every chat the caller made is listed at all ...
			expect(everything).toEqual(expect.arrayContaining(mine.map(([title]) => title)))
			// ... and every listed chat is in the default list or in Quiet, never both. The direct
			// messages between people the list adds on its own have no message and are never hidden.
			const missing = everything.filter((t) => !defaultList.includes(t) && !quiet.includes(t))
			expect(missing).toEqual([])
			expect(defaultList.filter((t) => quiet.includes(t))).toEqual([])
			// Quiet is only what is old or retired and not kept by anything.
			expect(quiet).toEqual(['old topic', 'retired dm', 'retired topic'])
		})

		it('the only chat in no view is a direct chat with an agent that has no message yet', async () => {
			await seedChat('empty agent dm', [agentId], { direct: true })
			await seedChat('written agent dm', [retiredId], { direct: true, posts: [{ from: me }] })

			const everything = await titles()
			const placed = new Set([
				...(await titles('hide_quiet=true')),
				...(await titles('view=quiet')),
			])
			expect(everything.filter((t) => !placed.has(t))).toEqual(['empty agent dm'])
		})
	})

	it('reads the caller’s own mentions and cards only', async () => {
		const colleague = (await insertActor(db, { type: 'human', name: 'Colleague' })).id
		await ensureWorkspaceMember(db, workspaceId, colleague)
		await seedChat('mine', [agentId], { posts: [{ from: agentId, mentionsMe: true }] })
		const theirs = await insertConversation(db, workspaceId, colleague, { title: 'theirs' })
		await db.insert(conversationParticipants).values([
			{ conversationId: theirs.id, actorId: colleague },
			{ conversationId: theirs.id, actorId: agentId },
		])
		await db.insert(messages).values({
			conversationId: theirs.id,
			actorId: agentId,
			content: 'for you',
			metadata: { mentions: [colleague] },
		})

		expect(await titles('view=waiting')).toEqual(['mine'])
		expect(await titles('unread_only=true')).toEqual(['mine'])
		expect((await rows('view=waiting', colleague)).map((c) => c.title)).toEqual(['theirs'])
	})
})
