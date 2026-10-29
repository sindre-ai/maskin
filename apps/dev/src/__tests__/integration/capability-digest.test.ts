import {
	events,
	actors,
	agentGrants,
	conversationParticipants,
	integrations,
	messages,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, asc, desc, eq, gt, inArray, ne } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProbeFn, ProbeResult } from '../../lib/capabilities/probe'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { runCapabilityDigest } from '../../services/capability-digest'
import { CapabilityScanner } from '../../services/capability-scanner'
import { buildIntegration, insertActor, insertConversation, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// The digest is a server job: no model, no session. These spies stand in for
// the only two doors a model call or a session start could go through.
const spies = vi.hoisted(() => ({ createLLMAdapter: vi.fn(), startSession: vi.fn() }))
vi.mock('../../lib/llm', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/llm')>()),
	createLLMAdapter: spies.createLLMAdapter,
}))
vi.mock('../../services/session-lifecycle', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../services/session-lifecycle')>()),
	startSession: spies.startSession,
}))

const BUILTIN = 'maskin:builtin'
const DAY_MS = 24 * 60 * 60 * 1000
const FLAG = 'agent-proactive-1-1'

describe('capability digest (integration)', () => {
	let workspaceId: string
	let cosId: string
	let salesRepId: string
	let researcherId: string
	let ownerId: string
	let adminId: string
	let memberId: string
	let slackId: string
	let answers: Map<string, ProbeResult>
	let probe: ProbeFn
	let previousWorkspaceFeatures: string | undefined

	const slackKey = () => `integration:slack:${slackId}`

	function tools(map: Record<string, string>): ProbeResult {
		return { tools: map, specHash: null }
	}

	function scanner() {
		return new CapabilityScanner(db, { probe })
	}

	async function join(actorId: string, role = 'member') {
		await db.insert(workspaceMembers).values({ workspaceId, actorId, role })
	}

	/** A 1-1 with Chief of Staff in which the person wrote and has read everything so far. */
	async function chatFor(humanId: string, opts: { wroteDaysAgo?: number } = {}) {
		const chat = await insertConversation(db, workspaceId, humanId)
		const [theirs] = await db
			.insert(messages)
			.values({
				conversationId: chat.id,
				actorId: humanId,
				content: 'Hi',
				createdAt: new Date(Date.now() - (opts.wroteDaysAgo ?? 0) * DAY_MS),
			})
			.returning()
		await db.insert(conversationParticipants).values([
			{ conversationId: chat.id, actorId: humanId, lastReadMessageId: theirs?.id },
			{ conversationId: chat.id, actorId: cosId },
		])
		return chat.id
	}

	async function eventsFor(action: string) {
		return db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, workspaceId), eq(events.action, action)))
			.orderBy(asc(events.id))
	}

	/** capability_note_skipped events for one person: entity is the recipient. */
	async function skippedFor(humanId: string) {
		return (await eventsFor('capability_note_skipped')).filter((e) => e.entityId === humanId)
	}

	async function notesIn(chatId: string) {
		return db
			.select()
			.from(messages)
			.where(and(eq(messages.conversationId, chatId), eq(messages.actorId, cosId)))
			.orderBy(asc(messages.id))
	}

	async function unreadCount(chatId: string, humanId: string) {
		const [state] = await db
			.select()
			.from(conversationParticipants)
			.where(
				and(
					eq(conversationParticipants.conversationId, chatId),
					eq(conversationParticipants.actorId, humanId),
				),
			)
		const rows = await db
			.select({ id: messages.id })
			.from(messages)
			.where(
				and(
					eq(messages.conversationId, chatId),
					gt(messages.id, state?.lastReadMessageId ?? 0),
					ne(messages.actorId, humanId),
				),
			)
		return rows.length
	}

	async function markRead(chatId: string, humanId: string) {
		const [latest] = await db
			.select({ id: messages.id })
			.from(messages)
			.where(eq(messages.conversationId, chatId))
			.orderBy(desc(messages.id))
			.limit(1)
		await db
			.update(conversationParticipants)
			.set({ lastReadMessageId: latest?.id })
			.where(
				and(
					eq(conversationParticipants.conversationId, chatId),
					eq(conversationParticipants.actorId, humanId),
				),
			)
	}

	/** Findings the way the scanner and Slice 3 write them. */
	async function writeFinding(p: {
		entityId: string
		source: string
		kind: string
		tools?: string[]
		extra?: Record<string, unknown>
	}) {
		await db.insert(events).values({
			workspaceId,
			actorId: cosId,
			action: 'capability_changed',
			entityType: 'capability_source',
			entityId: p.entityId,
			data: {
				source: p.source,
				kind: p.kind,
				tools: p.tools ?? [],
				holders: [],
				dedupe_key: `dk-${Math.random()}`,
				snapshot_event_id: null,
				...p.extra,
			},
		})
	}

	async function configSnapshot() {
		return JSON.stringify({
			actorTools: await db
				.select({ id: actors.id, tools: actors.tools })
				.from(actors)
				.where(inArray(actors.id, [cosId, salesRepId, researcherId]))
				.orderBy(asc(actors.id)),
			integrations: await db
				.select()
				.from(integrations)
				.where(eq(integrations.workspaceId, workspaceId))
				.orderBy(asc(integrations.id)),
			grants: await db
				.select()
				.from(agentGrants)
				.where(eq(agentGrants.workspaceId, workspaceId))
				.orderBy(asc(agentGrants.id)),
		})
	}

	/** The notes are behind agent-proactive-1-1, so every test but the flag ones turns it on here. */
	function setWorkspaceFlags(entries: string[]) {
		process.env.FF_WORKSPACE_FEATURES = entries.join(',')
		_resetFeatureFlagConfig()
	}

	beforeEach(async () => {
		spies.createLLMAdapter.mockClear()
		spies.startSession.mockClear()
		previousWorkspaceFeatures = process.env.FF_WORKSPACE_FEATURES

		ownerId = getTestActorId()
		const ws = await insertWorkspace(db, ownerId)
		workspaceId = ws.id
		setWorkspaceFlags([`${workspaceId}:${FLAG}`])
		cosId = (await insertActor(db, { type: 'agent', name: 'Chief of Staff' })).id
		salesRepId = (await insertActor(db, { type: 'agent', name: 'Sales Rep' })).id
		researcherId = (await insertActor(db, { type: 'agent', name: 'Researcher' })).id
		adminId = (await insertActor(db, { type: 'human', name: 'Alex Admin' })).id
		memberId = (await insertActor(db, { type: 'human', name: 'Max Member' })).id
		for (const id of [cosId, salesRepId, researcherId]) await join(id)
		await join(adminId, 'admin')
		await join(memberId, 'member')
		const [slack] = await db
			.insert(integrations)
			.values(
				buildIntegration({
					workspaceId,
					provider: 'slack',
					status: 'active',
					createdBy: ownerId,
					config: { token: 'xoxb-1234-do-not-show', note: '#secret-channel' },
				}) as never,
			)
			.returning()
		slackId = (slack as { id: string }).id

		answers = new Map<string, ProbeResult>([
			[BUILTIN, tools({ create_objects: 'h-create', get_objects: 'h-get' })],
			[slackKey(), tools({ slack_send_message: 'h-send' })],
		])
		probe = vi.fn(async (_db, _ws, source) => {
			const answer = answers.get(source.key)
			if (!answer) throw new Error(`no stub for ${source.key}`)
			return answer
		})
	})

	afterEach(() => {
		if (previousWorkspaceFeatures === undefined) {
			Reflect.deleteProperty(process.env, 'FF_WORKSPACE_FEATURES')
		} else {
			process.env.FF_WORKSPACE_FEATURES = previousWorkspaceFeatures
		}
		_resetFeatureFlagConfig()
	})

	describe('agent-proactive-1-1 flag', () => {
		async function newToolFound() {
			await scanner().tick() // baseline
			answers.set(
				BUILTIN,
				tools({ create_objects: 'h-create', get_objects: 'h-get', send_chat: 'h-c' }),
			)
			await scanner().tick()
		}

		it('with no entry for the flag, nothing is sent; the finding waits and goes out once it is on', async () => {
			setWorkspaceFlags([])
			const chatId = await chatFor(ownerId)

			await newToolFound()
			expect(await eventsFor('capability_changed')).toHaveLength(1)
			expect(await notesIn(chatId)).toHaveLength(0)
			expect(await eventsFor('capability_digest_sent')).toHaveLength(0)
			expect(await eventsFor('capability_note_skipped')).toHaveLength(0)
			expect(await runCapabilityDigest(db, workspaceId)).toEqual({
				sent: 0,
				skipped: { flag_off: 1 },
			})

			setWorkspaceFlags([`${workspaceId}:${FLAG}`])
			const summary = await runCapabilityDigest(db, workspaceId)
			expect(summary.sent).toBe(1)
			const notes = await notesIn(chatId)
			expect(notes).toHaveLength(1)
			expect(notes[0]?.content).toContain('send_chat')
		})

		it('an entry for another workspace does not turn it on here', async () => {
			const other = await insertWorkspace(db, ownerId)
			setWorkspaceFlags([`${other.id}:${FLAG}`])
			const chatId = await chatFor(ownerId)

			await newToolFound()
			expect(await notesIn(chatId)).toHaveLength(0)
			expect(await runCapabilityDigest(db, workspaceId)).toEqual({
				sent: 0,
				skipped: { flag_off: 1 },
			})
		})

		it('an entry for this workspace sends here and leaves a neighbour without the entry off', async () => {
			const neighbour = await insertWorkspace(db, ownerId)
			const chatId = await chatFor(ownerId)

			await newToolFound()
			expect(await notesIn(chatId)).toHaveLength(1)
			expect(await runCapabilityDigest(db, neighbour.id)).toEqual({
				sent: 0,
				skipped: { flag_off: 1 },
			})
		})
	})

	describe('end to end', () => {
		it('a new tool on a held source becomes one note from Chief of Staff, unread, and moves the cursor', async () => {
			const chatId = await chatFor(ownerId)
			const before = await configSnapshot()

			await scanner().tick() // baseline: nothing to say
			expect(await notesIn(chatId)).toHaveLength(0)
			expect(await eventsFor('capability_digest_sent')).toHaveLength(0)

			answers.set(
				BUILTIN,
				tools({ create_objects: 'h-create', get_objects: 'h-get', send_chat: 'h-c' }),
			)
			await scanner().tick()

			const notes = await notesIn(chatId)
			expect(notes).toHaveLength(1)
			expect(notes[0]?.content).toContain(
				'Hey Integration, quick check on what your agents can do.',
			)
			expect(notes[0]?.content).toContain('New this week: Maskin has 1 new tool (send_chat), and ')
			expect(notes[0]?.metadata).toMatchObject({
				delivery: { kind: 'proactive', reason: 'capability_note', version: 1 },
			})
			expect(await unreadCount(chatId, ownerId)).toBe(1)

			const [finding] = await eventsFor('capability_changed')
			const [sent] = await eventsFor('capability_digest_sent')
			expect(sent?.actorId).toBe(cosId)
			expect(sent?.entityId).toBe(chatId)
			expect(sent?.data).toMatchObject({
				recipient_id: ownerId,
				up_to_event_id: finding?.id,
				finding_ids: [finding?.id],
				message_id: notes[0]?.id,
			})

			// The cursor moved: another tick with nothing new sends nothing.
			await scanner().tick()
			expect(await notesIn(chatId)).toHaveLength(1)
			expect(await eventsFor('capability_digest_sent')).toHaveLength(1)

			// No wake: no session, no model, and no agent or integration changed.
			expect(spies.createLLMAdapter).not.toHaveBeenCalled()
			expect(spies.startSession).not.toHaveBeenCalled()
			const rows = await db
				.select({ id: sessions.id })
				.from(sessions)
				.where(eq(sessions.workspaceId, workspaceId))
			expect(rows).toHaveLength(0)
			expect(await configSnapshot()).toBe(before)
		})

		it('a quiet week sends nothing and records nothing', async () => {
			const chatId = await chatFor(ownerId)
			await scanner().tick()
			await scanner().tick()
			expect(await notesIn(chatId)).toHaveLength(0)
			expect(await eventsFor('capability_digest_sent')).toHaveLength(0)
			expect(await eventsFor('capability_note_skipped')).toHaveLength(0)
		})

		it('a refusal leaves the cursor and the next tick retries', async () => {
			const chatId = await chatFor(ownerId)
			await scanner().tick()
			answers.set(
				BUILTIN,
				tools({ create_objects: 'h-create', get_objects: 'h-get', send_chat: 'h-c' }),
			)
			await db.update(actors).set({ agentState: 'paused' }).where(eq(actors.id, cosId))

			await scanner().tick()
			expect(await notesIn(chatId)).toHaveLength(0)
			expect(await eventsFor('capability_digest_sent')).toHaveLength(0)
			const skipped = await skippedFor(ownerId)
			expect(skipped).toHaveLength(1)
			expect(skipped[0]?.data).toMatchObject({ reason: 'sender_paused', conversation_id: chatId })

			await db.update(actors).set({ agentState: 'idle' }).where(eq(actors.id, cosId))
			await scanner().tick()
			expect(await notesIn(chatId)).toHaveLength(1)
			expect(await eventsFor('capability_digest_sent')).toHaveLength(1)
		})

		it('does not send while the previous note is unread, then merges the findings into the next note', async () => {
			const chatId = await chatFor(ownerId)
			await scanner().tick()
			answers.set(
				BUILTIN,
				tools({ create_objects: 'h-create', get_objects: 'h-get', tool_one: 'h1' }),
			)
			await scanner().tick()
			expect(await notesIn(chatId)).toHaveLength(1)

			answers.set(
				BUILTIN,
				tools({ create_objects: 'h-create', get_objects: 'h-get', tool_one: 'h1', tool_two: 'h2' }),
			)
			await scanner().tick()
			expect(await notesIn(chatId)).toHaveLength(1)
			const skipped = await skippedFor(ownerId)
			expect(skipped.map((e) => (e.data as { reason: string }).reason)).toEqual([
				'unread_previous_note',
			])
			expect(await eventsFor('capability_digest_sent')).toHaveLength(1)

			// Read, and a week later: the pending finding goes out.
			await markRead(chatId, ownerId)
			await db
				.update(messages)
				.set({ createdAt: new Date(Date.now() - 8 * DAY_MS) })
				.where(eq(messages.id, (await notesIn(chatId))[0]?.id as number))
			await scanner().tick()
			const notes = await notesIn(chatId)
			expect(notes).toHaveLength(2)
			expect(notes[1]?.content).toContain('tool_two')
			expect(notes[1]?.content).not.toContain('tool_one')
			expect(await eventsFor('capability_digest_sent')).toHaveLength(2)
		})

		it('skips a person who has no 1-1 with Chief of Staff and never creates one', async () => {
			await scanner().tick()
			answers.set(
				BUILTIN,
				tools({ create_objects: 'h-create', get_objects: 'h-get', send_chat: 'h-c' }),
			)
			await scanner().tick()
			const skipped = await eventsFor('capability_note_skipped')
			expect(skipped.length).toBeGreaterThan(0)
			expect(skipped.every((e) => (e.data as { reason: string }).reason === 'no_direct_chat')).toBe(
				true,
			)
			const chats = await db
				.select()
				.from(conversationParticipants)
				.where(eq(conversationParticipants.actorId, ownerId))
			expect(chats).toHaveLength(0)
		})

		it('skips a person who has not written or read in 30 days', async () => {
			const chatId = await chatFor(ownerId, { wroteDaysAgo: 40 })
			await scanner().tick()
			answers.set(
				BUILTIN,
				tools({ create_objects: 'h-create', get_objects: 'h-get', send_chat: 'h-c' }),
			)
			await scanner().tick()
			expect(await notesIn(chatId)).toHaveLength(0)
			const skipped = await skippedFor(ownerId)
			expect(skipped[0]?.data).toMatchObject({ reason: 'inactive_chat' })
		})
	})

	describe('reply stop', () => {
		/** What the person typed into the 1-1, after everything already there. */
		async function say(chatId: string, humanId: string, content: string) {
			await db.insert(messages).values({ conversationId: chatId, actorId: humanId, content })
		}

		/** The first note goes out, is read, and is a week old: only a stop can block the next. */
		async function firstNoteSentAndRead(chats: Array<{ chatId: string; humanId: string }>) {
			await scanner().tick()
			answers.set(
				BUILTIN,
				tools({ create_objects: 'h-create', get_objects: 'h-get', tool_one: 'h1' }),
			)
			await scanner().tick()
			for (const { chatId, humanId } of chats) {
				const [note] = await notesIn(chatId)
				expect(note).toBeDefined()
				await markRead(chatId, humanId)
				await db
					.update(messages)
					.set({ createdAt: new Date(Date.now() - 8 * DAY_MS) })
					.where(eq(messages.id, note?.id as number))
			}
		}

		function addSecondTool() {
			answers.set(
				BUILTIN,
				tools({ create_objects: 'h-create', get_objects: 'h-get', tool_one: 'h1', tool_two: 'h2' }),
			)
		}

		it('a stop reply skips every tick with opted_out and leaves the cursor alone', async () => {
			const chatId = await chatFor(ownerId)
			await firstNoteSentAndRead([{ chatId, humanId: ownerId }])
			await say(chatId, ownerId, 'stop')
			addSecondTool()

			await scanner().tick()
			await scanner().tick()

			expect(await notesIn(chatId)).toHaveLength(1)
			expect(await eventsFor('capability_digest_sent')).toHaveLength(1)
			const reasons = (await skippedFor(ownerId)).map((e) => (e.data as { reason: string }).reason)
			expect(reasons).toEqual(['opted_out', 'opted_out'])
			expect(spies.startSession).not.toHaveBeenCalled()
		})

		it('start brings it back and the findings that waited go out in the next note', async () => {
			const chatId = await chatFor(ownerId)
			await firstNoteSentAndRead([{ chatId, humanId: ownerId }])
			await say(chatId, ownerId, 'stop')
			addSecondTool()
			await scanner().tick()
			expect(await notesIn(chatId)).toHaveLength(1)

			await say(chatId, ownerId, 'start')
			await scanner().tick()
			const notes = await notesIn(chatId)
			expect(notes).toHaveLength(2)
			expect(notes[1]?.content).toContain('tool_two')
			expect(await eventsFor('capability_digest_sent')).toHaveLength(2)
		})

		it('skips only the person who said stop; another person still gets a note', async () => {
			const ownerChat = await chatFor(ownerId)
			const adminChat = await chatFor(adminId)
			await firstNoteSentAndRead([
				{ chatId: ownerChat, humanId: ownerId },
				{ chatId: adminChat, humanId: adminId },
			])
			await say(ownerChat, ownerId, 'Stop.')
			addSecondTool()

			await scanner().tick()

			expect(await notesIn(ownerChat)).toHaveLength(1)
			const adminNotes = await notesIn(adminChat)
			expect(adminNotes).toHaveLength(2)
			expect(adminNotes[1]?.content).toContain('tool_two')
			const reasons = (await skippedFor(ownerId)).map((e) => (e.data as { reason: string }).reason)
			expect(reasons).toEqual(['opted_out'])
		})

		it('a normal reply does not opt the person out', async () => {
			const chatId = await chatFor(ownerId)
			await firstNoteSentAndRead([{ chatId, humanId: ownerId }])
			await say(chatId, ownerId, 'I will stop by later')
			await say(chatId, ownerId, 'tell me more')
			addSecondTool()

			await scanner().tick()

			expect(await notesIn(chatId)).toHaveLength(2)
			expect(await skippedFor(ownerId)).toHaveLength(0)
		})
	})

	describe('shared integrations and governance', () => {
		/** A held tool finding written by a real scan, with delivery held back until the test says so. */
		async function pendingToolFinding() {
			await scanner().scanWorkspace(workspaceId)
			answers.set(
				BUILTIN,
				tools({ create_objects: 'h-create', get_objects: 'h-get', send_chat: 'h-c' }),
			)
			await scanner().scanWorkspace(workspaceId)
			expect(await eventsFor('capability_changed')).toHaveLength(1)
		}

		it('re-resolves holders at send time: an agent whose access was removed is not named', async () => {
			const chatId = await chatFor(ownerId)
			await pendingToolFinding()
			await db
				.delete(workspaceMembers)
				.where(
					and(
						eq(workspaceMembers.workspaceId, workspaceId),
						eq(workspaceMembers.actorId, salesRepId),
					),
				)

			await runCapabilityDigest(db, workspaceId)
			const [note] = await notesIn(chatId)
			expect(note?.content).toContain('Researcher')
			expect(note?.content).not.toContain('Sales Rep')
		})

		it('drops an item whose only holders lost access, sends nothing, and does not use the weekly cap', async () => {
			const chatId = await chatFor(ownerId)
			await scanner().scanWorkspace(workspaceId)
			answers.set(slackKey(), tools({ slack_send_message: 'h-send', slack_react: 'h-react' }))
			await scanner().scanWorkspace(workspaceId)
			expect(await eventsFor('capability_changed')).toHaveLength(1)

			// Slack is no longer exposed to any agent session since the scan.
			await db
				.update(integrations)
				.set({ config: { expose_to_agent_sessions: false } })
				.where(eq(integrations.id, slackId))

			const summary = await runCapabilityDigest(db, workspaceId)
			expect(summary.sent).toBe(0)
			expect(await notesIn(chatId)).toHaveLength(0)
			expect(await eventsFor('proactive_message_sent')).toHaveLength(0)
			const skipped = await skippedFor(ownerId)
			expect(skipped[0]?.data).toMatchObject({ reason: 'nothing_to_say' })

			// The weekly cap was not used: once access returns, the same finding goes out.
			await db.update(integrations).set({ config: {} }).where(eq(integrations.id, slackId))
			await runCapabilityDigest(db, workspaceId)
			const [note] = await notesIn(chatId)
			expect(note?.content).toContain('Slack has 1 new tool (slack_react)')
		})

		it('reconnect and not-attached items go to owners and admins only, and carry no secrets', async () => {
			const [meet] = await db
				.insert(integrations)
				.values(
					buildIntegration({
						workspaceId,
						provider: 'google-meet',
						status: 'active',
						createdBy: ownerId,
						defaultAgentAccess: 'none',
						config: { token: 'ya29.token-like-string', note: '#channel-name' },
					}) as never,
				)
				.returning()
			const meetId = (meet as { id: string }).id
			const ownerChat = await chatFor(ownerId)
			const adminChat = await chatFor(adminId)
			const memberChat = await chatFor(memberId)

			await writeFinding({
				entityId: workspaceId,
				source: BUILTIN,
				kind: 'tool_added',
				tools: ['send_chat'],
			})
			await writeFinding({
				entityId: slackId,
				source: slackKey(),
				kind: 'needs_reconnect',
				extra: {
					missing_scopes: ['chat:write'],
					description: '#secret-channel',
					token: 'xoxb-1234-do-not-show',
				},
			})
			await writeFinding({
				entityId: meetId,
				source: `integration:google-meet:${meetId}`,
				kind: 'available_not_attached',
				extra: { description: '#secret-channel', url: 'https://example.com/hook' },
			})
			const before = await configSnapshot()

			await runCapabilityDigest(db, workspaceId)

			for (const chat of [ownerChat, adminChat]) {
				const [note] = await notesIn(chat)
				expect(note?.content).toContain(
					'Needs you: Slack wants a reconnect before the new write scope works.',
				)
				expect(note?.content).toContain(
					'Also: Google Meet is connected but none of your agents can use it yet. An admin decides whether any agent gets it.',
				)
			}
			const [memberNote] = await notesIn(memberChat)
			expect(memberNote?.content).toContain('Maskin has 1 new tool (send_chat)')
			expect(memberNote?.content).not.toContain('Needs you')
			expect(memberNote?.content).not.toContain('Google Meet')
			expect(memberNote?.content).not.toContain('Slack')

			for (const chat of [ownerChat, adminChat, memberChat]) {
				const [note] = await notesIn(chat)
				expect(note?.content).not.toMatch(/xoxb|ya29|secret-channel|channel-name|example\.com/)
				expect(note?.content).not.toMatch(/grant|attach/i)
			}
			expect(await configSnapshot()).toBe(before)
		})

		it('a not-attached item is dropped once an agent can use the integration', async () => {
			const [meet] = await db
				.insert(integrations)
				.values(
					buildIntegration({
						workspaceId,
						provider: 'google-meet',
						status: 'active',
						createdBy: ownerId,
						defaultAgentAccess: 'none',
					}) as never,
				)
				.returning()
			const meetId = (meet as { id: string }).id
			const chatId = await chatFor(ownerId)
			await writeFinding({
				entityId: meetId,
				source: `integration:google-meet:${meetId}`,
				kind: 'available_not_attached',
			})
			await db.insert(agentGrants).values({
				workspaceId,
				integrationId: meetId,
				actorId: salesRepId,
				access: 'read',
			})

			const summary = await runCapabilityDigest(db, workspaceId)
			expect(summary.sent).toBe(0)
			expect(await notesIn(chatId)).toHaveLength(0)
		})

		it('a tool added to a source nobody holds produces no note', async () => {
			const chatId = await chatFor(ownerId)
			await db
				.update(integrations)
				.set({ config: { expose_to_agent_sessions: false } })
				.where(eq(integrations.id, slackId))
			await scanner().tick()
			answers.set(slackKey(), tools({ slack_send_message: 'h-send', slack_react: 'h-react' }))
			await scanner().tick()
			expect(await eventsFor('capability_changed')).toHaveLength(0)
			expect(await notesIn(chatId)).toHaveLength(0)
		})
	})
})
