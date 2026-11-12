import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	conversationParticipants,
	conversations,
	messages,
	workspaceMembers,
} from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { directPairKey } from '../../services/direct-chat'
import { insertActor, insertConversation, insertWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: conversationsRoutes } = await import('../../routes/conversations')

/**
 * GET /api/conversations?hide_quiet=true leaves out empty direct messages with agents, chats with
 * retired agents and topic chats quiet for about 14 days. Pinned chats, unread chats, group chats
 * and people-only chats are never left out, and without the flag nothing is.
 */

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

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
	return app
}

const DAY = 86_400_000

describe('GET /api/conversations hide_quiet', () => {
	let workspaceId: string
	let humanId: string
	let agentId: string
	let retiredId: string

	beforeEach(async () => {
		humanId = getTestActorId()
		workspaceId = (await insertWorkspace(db, humanId)).id
		agentId = (await insertActor(db, { type: 'agent', description: 'Builds things' })).id
		retiredId = (await insertActor(db, { type: 'agent', description: 'RETIRED, merged away' })).id
		for (const actorId of [agentId, retiredId]) {
			await db.insert(workspaceMembers).values({ workspaceId, actorId, role: 'member' })
		}
	})

	/**
	 * A chat the caller is in with `others`, with an optional message. A message from the caller
	 * leaves the chat read; one from anybody else leaves it unread.
	 */
	async function seedChat(
		label: string,
		others: string[],
		opts: {
			direct?: boolean
			messageFrom?: string
			daysAgo?: number
			pinned?: boolean
			subject?: boolean
		} = {},
	) {
		const chat = await insertConversation(db, workspaceId, humanId, {
			title: label,
			directPairKey: opts.direct ? directPairKey(humanId, others[0]) : null,
			lastMessageAt: new Date(Date.now() - (opts.daysAgo ?? 0) * DAY),
			...(opts.subject ? { subjectType: 'object', subjectId: crypto.randomUUID() } : {}),
		})
		await db
			.insert(conversationParticipants)
			.values([
				{ conversationId: chat.id, actorId: humanId, pinned: opts.pinned ?? false },
				...others.map((actorId) => ({ conversationId: chat.id, actorId })),
			])
		if (opts.messageFrom) {
			await db
				.insert(messages)
				.values({ conversationId: chat.id, actorId: opts.messageFrom, content: `${label} hello` })
		}
		return chat.id
	}

	async function titles(query: string) {
		const res = await createApp(humanId).request(
			jsonGet(`/api/conversations?limit=100&${query}`, { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as { conversations: Array<{ title: string }> }
		return body.conversations.map((c) => c.title).sort()
	}

	it('leaves out an empty DM with an agent, and shows it once it has a message', async () => {
		const empty = await seedChat('empty dm', [agentId], { direct: true })
		await seedChat('written dm', [agentId], { direct: true, messageFrom: humanId })
		expect(await titles('hide_quiet=true')).not.toContain('empty dm')
		expect(await titles('hide_quiet=true')).toContain('written dm')

		await db.insert(messages).values({ conversationId: empty, actorId: humanId, content: 'hi' })
		expect(await titles('hide_quiet=true')).toContain('empty dm')
	})

	it('leaves out a DM and a topic chat with a retired agent, even a recent one', async () => {
		await seedChat('retired dm', [retiredId], { direct: true, messageFrom: humanId })
		await seedChat('retired topic', [retiredId], { messageFrom: humanId })
		const shown = await titles('hide_quiet=true')
		expect(shown).not.toContain('retired dm')
		expect(shown).not.toContain('retired topic')
	})

	it('leaves out a topic chat quiet for 14 days, and brings it back on a new message', async () => {
		const quiet = await seedChat('quiet topic', [agentId], { messageFrom: humanId, daysAgo: 20 })
		await seedChat('recent topic', [agentId], { messageFrom: humanId, daysAgo: 13 })
		const shown = await titles('hide_quiet=true')
		expect(shown).not.toContain('quiet topic')
		expect(shown).toContain('recent topic')

		await db.insert(messages).values({ conversationId: quiet, actorId: humanId, content: 'back' })
		await db
			.update(conversations)
			.set({ lastMessageAt: new Date() })
			.where(eq(conversations.id, quiet))
		expect(await titles('hide_quiet=true')).toContain('quiet topic')
	})

	it('never leaves out pinned, unread, group, subject or people-only chats', async () => {
		const otherHuman = (await insertActor(db, { type: 'human' })).id
		await seedChat('pinned quiet', [agentId], { messageFrom: humanId, daysAgo: 30, pinned: true })
		await seedChat('pinned retired', [retiredId], { messageFrom: humanId, pinned: true })
		await seedChat('unread quiet', [agentId], { messageFrom: agentId, daysAgo: 30 })
		await seedChat('group quiet', [agentId, retiredId], { messageFrom: humanId, daysAgo: 30 })
		await seedChat('subject quiet', [agentId], {
			messageFrom: humanId,
			daysAgo: 30,
			subject: true,
		})
		await seedChat('people quiet', [otherHuman], { messageFrom: humanId, daysAgo: 30 })
		await seedChat('people empty dm', [otherHuman], { direct: true })
		const shown = await titles('hide_quiet=true')
		for (const t of [
			'pinned quiet',
			'pinned retired',
			'unread quiet',
			'group quiet',
			'subject quiet',
			'people quiet',
			'people empty dm',
		]) {
			expect(shown).toContain(t)
		}
	})

	it('hides nothing when the flag is not sent', async () => {
		await seedChat('empty dm', [agentId], { direct: true })
		await seedChat('retired topic', [retiredId], { messageFrom: humanId })
		await seedChat('quiet topic', [agentId], { messageFrom: humanId, daysAgo: 30 })
		const shown = await titles('')
		expect(shown).toEqual(expect.arrayContaining(['empty dm', 'retired topic', 'quiet topic']))
	})
})
