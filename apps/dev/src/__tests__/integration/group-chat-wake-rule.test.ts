import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { messages, workspaceMembers } from '@maskin/db/schema'
import { afterEach, vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { insertActor, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { track, chat, createAdapter } = vi.hoisted(() => ({
	track: vi.fn(),
	chat: vi.fn(),
	createAdapter: vi.fn(),
}))

vi.mock('../../lib/analytics/group-chat-routing-events', () => ({
	trackGroupChatMessageRouted: track,
}))
vi.mock('../../lib/llm/index', () => ({
	createLLMAdapter: (...args: unknown[]) => {
		createAdapter(...args)
		return { chat }
	},
}))

import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { logger } from '../../lib/logger'
import { evaluateAndRespond } from '../../services/conversation-responder'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'

const { default: conversationsRoutes } = await import('../../routes/conversations')

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; sessionManager: unknown }
}
type Outcome = { agentId: string; decision: string; reason: string; delivery: string }
type Routed = Record<string, unknown> & {
	flagOn: boolean
	rule: string
	trigger: string
	outcomes: Outcome[]
}

function makeSessionManager() {
	return {
		createSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
		findActiveConversationSession: vi.fn().mockResolvedValue(null),
		findConversationSessionAnyActive: vi.fn().mockResolvedValue(null),
		drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
		writeInput: vi.fn().mockResolvedValue(undefined),
		markSessionFailedAfterContainerLoss: vi.fn().mockResolvedValue(undefined),
	}
}

const lastRouted = () => track.mock.calls[track.mock.calls.length - 1]?.[0] as Routed
const flush = () => new Promise((resolve) => setTimeout(resolve, 150))

describe('group chat wake rule (flag group-chat-wake-rule)', () => {
	let ownerId: string
	let workspaceId: string

	function setFlag(on: boolean) {
		process.env.FF_WORKSPACE_FEATURES = on ? `${workspaceId}:group-chat-wake-rule` : ''
		// The tester list must never carry this flag: it would not switch the rule on.
		process.env.FF_TESTER_ACTOR_IDS = ownerId
		process.env.FF_TESTER_FEATURES = on ? 'group-chat-wake-rule' : ''
		_resetFeatureFlagConfig()
	}

	beforeEach(async () => {
		vi.clearAllMocks()
		ownerId = getTestActorId()
		workspaceId = (await insertWorkspace(db, ownerId)).id
		setFlag(true)
	})

	afterEach(() => {
		process.env.FF_WORKSPACE_FEATURES = ''
		process.env.FF_TESTER_ACTOR_IDS = ''
		process.env.FF_TESTER_FEATURES = ''
		_resetFeatureFlagConfig()
	})

	async function actor(type: 'agent' | 'human', overrides: Record<string, unknown> = {}) {
		const row = await insertActor(db, { type, ...overrides })
		if (!row) throw new Error('actor insert failed')
		await db.insert(workspaceMembers).values({ workspaceId, actorId: row.id, role: 'member' })
		return row
	}

	/** The owner (H1) plus the given actors, created through the real route. */
	async function chatWith(others: Array<{ id: string }>, sessionManager = makeSessionManager()) {
		const app = new OpenAPIHono<Env>({
			defaultHook: (result, c) =>
				result.success
					? undefined
					: c.json(
							createApiError('VALIDATION_ERROR', 'invalid', formatZodError(result.error)),
							400,
						),
		})
		configureSessionLifecycle({ db, sessionManager: sessionManager as unknown as SessionManager })
		app.use('*', async (c, next) => {
			c.set('db', db)
			c.set('actorId', ownerId)
			c.set('actorType', 'human')
			c.set('sessionManager', sessionManager)
			await next()
		})
		app.route('/api/conversations', conversationsRoutes)
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/conversations',
				{ title: 'Wake rule', participant_actor_ids: others.map((o) => o.id) },
				{ 'x-workspace-id': workspaceId },
			),
		)
		const conversationId = ((await res.json()) as { id: string }).id
		return { app, sessionManager, conversationId }
	}

	async function post(
		conversationId: string,
		actorId: string,
		content: string,
		metadata: Record<string, unknown> | null = null,
	) {
		const [row] = await db
			.insert(messages)
			.values({ conversationId, actorId, content, metadata })
			.returning()
		if (!row) throw new Error('failed to insert message')
		return row.id
	}

	async function respond(
		sessionManager: ReturnType<typeof makeSessionManager>,
		conversationId: string,
		messageId: number,
		database: Database = db,
	) {
		const before = track.mock.calls.length
		await evaluateAndRespond({
			db: database,
			// biome-ignore lint/suspicious/noExplicitAny: test double, real type lives in session-manager.ts
			sessionManager: sessionManager as any,
			workspaceId,
			conversationId,
			messageId,
		})
		await vi.waitFor(() => expect(track.mock.calls.length).toBe(before + 1))
		return lastRouted()
	}

	const wokenIds = (e: Routed) =>
		e.outcomes
			.filter((o) => o.decision === 'wake')
			.map((o) => o.agentId)
			.sort()

	const api = (
		app: { request: (r: Request) => Promise<Response> },
		method: string,
		path: string,
		body?: unknown,
	) => app.request(jsonRequest(method, path, body, { 'x-workspace-id': workspaceId }))

	describe('the scripted chat: H1 (owner), H2, agents A and B', () => {
		async function scripted(agentOverrides: Record<string, unknown> = {}) {
			const [a, b] = [await actor('agent', agentOverrides), await actor('agent', agentOverrides)]
			const h2 = await actor('human')
			const chatInfo = await chatWith([a, b, h2])
			return { a, b, h2, ...chatInfo }
		}

		// Both credential modes: no key (the Claude-sign-in shape that used to default open) and
		// a chat-callable key. The rule must give the same answers, and never touch the model.
		describe.each([
			['agents with no chat-callable key', {}],
			['agents with a chat-callable key', { llmProvider: 'anthropic', llmConfig: { api_key: 'sk-test' } }],
		])('with %s', (_mode, agentOverrides) => {
			it('answers every row of the scripted chat and never calls the model', async () => {
				const { a, b, h2, sessionManager, conversationId } = await scripted(agentOverrides)
				const asH1 = (content: string, mentions?: string[]) =>
					post(conversationId, ownerId, content, mentions ? { mentions } : null)
				const check = async (messageId: number, woken: string[], rule: string) => {
					const e = await respond(sessionManager, conversationId, messageId)
					expect(wokenIds(e), `${rule}: who woke`).toEqual(woken.sort())
					expect(e).toMatchObject({ flagOn: true, rule })
					return e
				}

				// First message, untagged, two agents: nobody, and the reason is logged.
				const first = await check(await asH1('anyone here?'), [], 'no_target')
				expect(first.outcomes.map((o) => o.reason)).toEqual(['skip_no_target', 'skip_no_target'])

				// A speaks. H1 untagged after A: A only.
				await post(conversationId, a.id, 'A answers')
				await check(await asH1('and then?'), [a.id], 'last_speaker')
				// H1 tags A, B, A and B, a person, a person and A.
				await check(await asH1('hey A', [a.id]), [a.id], 'tagged')
				await check(await asH1('hey B', [b.id]), [b.id], 'tagged')
				await check(await asH1('both', [a.id, b.id]), [a.id, b.id], 'tagged')
				await check(await asH1('hey H2', [h2.id]), [], 'human_tag_only')
				await check(await asH1('H2 and A', [h2.id, a.id]), [a.id], 'tagged')

				// B speaks. H1 untagged after B: B only.
				await post(conversationId, b.id, 'B answers')
				await check(await asH1('thanks'), [b.id], 'last_speaker')

				// A second person answers right after A: A only, since A is still the latest other writer.
				await post(conversationId, a.id, 'A again')
				const h2Reply = await post(conversationId, h2.id, 'agreed')
				const e = await respond(sessionManager, conversationId, h2Reply)
				expect(wokenIds(e)).toEqual([a.id])

				// H2 spoke after A, so an untagged H1 message wakes nobody.
				const afterPerson = await respond(sessionManager, conversationId, await asH1('so?'))
				expect(wokenIds(afterPerson)).toEqual([])
				expect(afterPerson.outcomes.map((o) => o.reason)).toEqual([
					'skip_last_writer_person',
					'skip_last_writer_person',
				])

				// Agents: untagged wakes nobody, tagging wakes the tagged one.
				const untagged = await post(conversationId, a.id, 'thinking aloud')
				expect(wokenIds(await respond(sessionManager, conversationId, untagged))).toEqual([])
				const tagging = await post(conversationId, a.id, 'over to you B', { mentions: [b.id] })
				expect(wokenIds(await respond(sessionManager, conversationId, tagging))).toEqual([b.id])

				// An attachment-only message that tags an agent wakes that agent.
				const attachmentOnly = await post(conversationId, ownerId, '', {
					mentions: [a.id],
					attachments: [{ file_id: '11111111-1111-1111-1111-111111111111', name: 'report.pdf' }],
				})
				expect(wokenIds(await respond(sessionManager, conversationId, attachmentOnly))).toEqual([
					a.id,
				])

				expect(chat).not.toHaveBeenCalled()
				expect(createAdapter).not.toHaveBeenCalled()
			})
		})

		it('retry with no agent chosen wakes the same set as the original post, never the whole room', async () => {
			const { a, b, app, conversationId } = await scripted()
			await post(conversationId, b.id, 'B spoke')
			const messageId = await post(conversationId, ownerId, 'hey A', { mentions: [a.id] })
			const path = `/api/conversations/${conversationId}/messages/${messageId}`

			await api(app, 'POST', `${path}/retry`)
			await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1))

			expect(lastRouted()).toMatchObject({ trigger: 'retry', flagOn: true, rule: 'tagged' })
			expect(wokenIds(lastRouted())).toEqual([a.id])
		})

		it('retry with no agent chosen on an untagged message wakes nobody when the rule says nobody', async () => {
			const { app, conversationId } = await scripted()
			const messageId = await post(conversationId, ownerId, 'anyone?')

			await api(app, 'POST', `/api/conversations/${conversationId}/messages/${messageId}/retry`)
			await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1))

			expect(lastRouted()).toMatchObject({ trigger: 'retry', rule: 'no_target' })
			expect(wokenIds(lastRouted())).toEqual([])
		})

		it('redo with an agent chosen wakes exactly that agent', async () => {
			const { a, b, app, conversationId } = await scripted()
			await post(conversationId, b.id, 'B spoke last')
			const messageId = await post(conversationId, ownerId, 'untagged')

			await api(
				app,
				'POST',
				`/api/conversations/${conversationId}/messages/${messageId}/retry?agent_id=${a.id}`,
			)
			await vi.waitFor(() => expect(track).toHaveBeenCalledTimes(1))

			expect(lastRouted()).toMatchObject({ trigger: 'redo', rule: 'retry_target' })
			expect(lastRouted().outcomes).toEqual([
				expect.objectContaining({ agentId: a.id, decision: 'wake', reason: 'rule_retry_target' }),
			])
		})

		it('names the reason in the prompt it hands the agent: follow-up for the last speaker', async () => {
			const { a, sessionManager, conversationId } = await scripted()
			await post(conversationId, a.id, 'A answers')
			await respond(sessionManager, conversationId, await post(conversationId, ownerId, 'and?'))

			const [, params] = sessionManager.createSession.mock.calls[0] as [
				string,
				{ actionPrompt: string },
			]
			expect(params.actionPrompt).toContain('This looks like a follow-up to your last reply')
			expect(params.actionPrompt).not.toContain('touched on something within your area')
			expect(params.actionPrompt).toContain('tagging in your final reply wakes nobody')
		})

		it('fails closed when an input query fails: nobody is woken and the event says why', async () => {
			const { a, sessionManager, conversationId } = await scripted()
			await post(conversationId, a.id, 'A answers')
			const messageId = await post(conversationId, ownerId, 'untagged follow-up')
			const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
			// Fail the "is this the first message" lookup, the only query that selects just an id.
			const failing = new Proxy(db, {
				get(target, prop, receiver) {
					if (prop !== 'select') return Reflect.get(target, prop, receiver)
					return (fields?: Record<string, unknown>) => {
						if (fields && Object.keys(fields).join() === 'id') throw new Error('db down')
						return Reflect.apply(target.select, target, fields === undefined ? [] : [fields])
					}
				},
			}) as Database

			const e = await respond(sessionManager, conversationId, messageId, failing)

			expect(e).toMatchObject({ flagOn: true, rule: 'resolver_error' })
			expect(e.outcomes.map((o) => o.reason)).toEqual(['skip_resolver_error', 'skip_resolver_error'])
			expect(sessionManager.createSession).not.toHaveBeenCalled()
			expect(errorLog).toHaveBeenCalledWith(
				expect.stringContaining('waking nobody'),
				expect.objectContaining({ conversationId }),
			)
			errorLog.mockRestore()
		})

		it('records agent_cap with the flag on and wakes nobody', async () => {
			const { a, b, sessionManager, conversationId } = await scripted()
			for (let i = 0; i < 5; i++) await post(conversationId, a.id, `agent turn ${i}`)
			const messageId = await post(conversationId, b.id, 'tagging A', { mentions: [a.id] })

			const e = await respond(sessionManager, conversationId, messageId)

			expect(e).toMatchObject({ flagOn: true, rule: 'agent_cap', capHit: true })
			expect(sessionManager.createSession).not.toHaveBeenCalled()
		})
	})

	it('one agent and two people: the first untagged message wakes the agent, a later person-to-person one wakes nobody', async () => {
		const [agent, h2] = [await actor('agent'), await actor('human')]
		const { sessionManager, conversationId } = await chatWith([agent, h2])

		const first = await respond(
			sessionManager,
			conversationId,
			await post(conversationId, ownerId, 'hello'),
		)
		expect(first).toMatchObject({ rule: 'first_message_lone_agent' })
		expect(first.outcomes).toEqual([
			expect.objectContaining({ agentId: agent.id, reason: 'rule_first_message_lone_agent' }),
		])
		const [, params] = sessionManager.createSession.mock.calls[0] as [
			string,
			{ actionPrompt: string },
		]
		expect(params.actionPrompt).toContain('You are the only agent in this chat')

		await post(conversationId, agent.id, 'hi both')
		await post(conversationId, h2.id, 'H2 replies')
		const personToPerson = await respond(
			sessionManager,
			conversationId,
			await post(conversationId, ownerId, 'H2, thoughts?', { mentions: [h2.id] }),
		)
		expect(personToPerson).toMatchObject({ rule: 'human_tag_only' })
		expect(wokenIds(personToPerson)).toEqual([])
	})

	describe('what the flag leaves alone', () => {
		it('flag off: the legacy path runs and the event says legacy', async () => {
			setFlag(false)
			const [a, b] = [await actor('agent'), await actor('agent')]
			const person = await actor('human')
			const { sessionManager, conversationId } = await chatWith([a, b, person])
			await post(conversationId, a.id, 'A spoke')

			// Untagged, no chat-callable key: the old check fails open and wakes both.
			const e = await respond(
				sessionManager,
				conversationId,
				await post(conversationId, ownerId, 'who else?'),
			)

			expect(e).toMatchObject({ flagOn: false, rule: 'legacy' })
			expect(e.outcomes.map((o) => o.reason)).toEqual([
				'default_yes_no_credentials',
				'default_yes_no_credentials',
			])
		})

		it('flag off: the model is still asked in a group chat', async () => {
			setFlag(false)
			const keyed = { llmProvider: 'anthropic', llmConfig: { api_key: 'sk-test' } }
			const [a, b] = [await actor('agent', keyed), await actor('agent', keyed)]
			const person = await actor('human')
			chat.mockResolvedValue({
				tool_calls: [{ name: 'decide_response', arguments: { should_respond: false } }],
			})
			const { sessionManager, conversationId } = await chatWith([a, b, person])

			await respond(sessionManager, conversationId, await post(conversationId, ownerId, 'hm'))

			expect(chat).toHaveBeenCalledTimes(2)
		})

		it('flag on: a 1-1 chat still replies without the rule and emits nothing', async () => {
			const agent = await actor('agent')
			const { sessionManager, conversationId } = await chatWith([agent])
			await post(conversationId, agent.id, 'earlier')

			await evaluateAndRespond({
				db,
				// biome-ignore lint/suspicious/noExplicitAny: test double, real type lives in session-manager.ts
				sessionManager: sessionManager as any,
				workspaceId,
				conversationId,
				messageId: await post(conversationId, ownerId, 'hi'),
			})
			await flush()

			expect(sessionManager.createSession).toHaveBeenCalledTimes(1)
			expect(track).not.toHaveBeenCalled()
			expect(chat).not.toHaveBeenCalled()
		})

		it('flag on for another workspace: this workspace keeps the legacy path', async () => {
			process.env.FF_WORKSPACE_FEATURES = `${crypto.randomUUID()}:group-chat-wake-rule`
			_resetFeatureFlagConfig()
			const [a, b] = [await actor('agent'), await actor('agent')]
			const person = await actor('human')
			const { sessionManager, conversationId } = await chatWith([a, b, person])

			const e = await respond(
				sessionManager,
				conversationId,
				await post(conversationId, ownerId, 'hello'),
			)

			expect(e).toMatchObject({ flagOn: false, rule: 'legacy' })
		})
	})
})
