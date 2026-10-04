import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpenAPIHono } from '@hono/zod-openapi'
import { LocalFileKmsProvider } from '@maskin/auth/kms'
import {
	conversationParticipants,
	integrations,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, count, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { createApiError } from '../../lib/errors'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import integrationsKeychainRoutes from '../../routes/integrations-keychain'
import {
	RELAUNCH_POLL_MS,
	RELAUNCH_TERMINAL_CAP_MS,
	relaunchChatSession,
} from '../../services/chat-relaunch'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertConversation, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'
import { fakeSessionControl } from './session-control-fake'

// Obviously fake, built at runtime so no token-shaped literal sits in the repo.
const FAKE_KEY = `cfut_${'RELAUNCH01'.repeat(5)}`

let dir: string
let kms: LocalFileKmsProvider
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'keychain-relaunch-kek-'))
	kms = new LocalFileKmsProvider(join(dir, 'kek'))
	setKmsProviderForTests(kms)
})
afterAll(() => {
	setKmsProviderForTests(undefined)
	rmSync(dir, { recursive: true, force: true })
})

type Control = ReturnType<typeof fakeSessionControl>

function appFor(actorId: string, control: Control) {
	const app = new OpenAPIHono<{
		Variables: { db: typeof db; actorId: string; actorType: string; sessionManager: unknown }
	}>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('sessionManager', control)
		await next()
	})
	app.onError((_err, c) =>
		c.json(createApiError('INTERNAL_ERROR', 'Internal server error'), { status: 500 }),
	)
	app.route('/api/integrations', integrationsKeychainRoutes)
	return app
}

/** A chat: one human, one agent, a conversation and the agent's live interactive session. */
async function setupChat() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human, {
		enterpriseGranted: true,
		settings: { llm_keys: { anthropic: 'sk-ant-test' } },
	})
	const agent = await insertActor(db, { type: 'agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
	const conversation = await insertConversation(db, ws.id, human)
	await db
		.insert(conversationParticipants)
		.values({ conversationId: conversation.id, actorId: human })
	const session = await insertSession(db, ws.id, agent.id, human, {
		conversationId: conversation.id,
		interactive: true,
		status: 'running',
	})
	return { human, ws, agent, conversation, session }
}
type Chat = Awaited<ReturnType<typeof setupChat>>

const capture = (app: OpenAPIHono<never>, chat: Chat, displayName = 'Relaunch key') =>
	app.request('/api/integrations/chat-capture', {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-workspace-id': chat.ws.id },
		body: JSON.stringify({
			sessionId: chat.session.id,
			providerMode: 'byo_apikey',
			detectedProvider: 'cloudflare',
			displayName,
			rawSecret: FAKE_KEY,
		}),
	})
const post = (app: OpenAPIHono<never>, chat: Chat, path: string) =>
	app.request(`/api/integrations/${path}`, {
		method: 'POST',
		headers: { 'x-workspace-id': chat.ws.id },
	})

const statusOf = async (id: string) =>
	(await db.select({ status: sessions.status }).from(sessions).where(eq(sessions.id, id)))[0]
		?.status

async function openSessions(chat: Chat) {
	const rows = await db
		.select({ id: sessions.id, status: sessions.status })
		.from(sessions)
		.where(
			and(eq(sessions.conversationId, chat.conversation.id), eq(sessions.actorId, chat.agent.id)),
		)
	return rows
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

describe('chat capture relaunch: stop, wait for terminal (Integration)', () => {
	it('stops the live session and has it terminal before the vault response returns', async () => {
		const chat = await setupChat()
		const control = fakeSessionControl()
		const pauseSession = vi.fn()
		const resumeSession = vi.fn()
		const app = appFor(chat.human, Object.assign(control, { pauseSession, resumeSession }))

		const res = await capture(app as never, chat)
		expect(res.status).toBe(201)
		const out = (await res.json()) as { integrationId: string; relaunch: string }
		expect(out.relaunch).toBe('stopped')

		expect(control.stopSession).toHaveBeenCalledTimes(1)
		expect(control.stopSession).toHaveBeenCalledWith(chat.session.id)
		expect(await statusOf(chat.session.id)).toBe('user_stopped')
		// The credential was committed first and is unaffected.
		const [row] = await db.select().from(integrations).where(eq(integrations.id, out.integrationId))
		expect(row?.status).toBe('pending_undo')
		// Pause and resume are never the relaunch path: on a remote session pauseSession
		// marks the live one failed.
		expect(pauseSession).not.toHaveBeenCalled()
		expect(resumeSession).not.toHaveBeenCalled()
	})

	it('leaves no active session, so the next interactive session for the pair raises no unique violation', async () => {
		const chat = await setupChat()
		const control = fakeSessionControl()
		expect((await capture(appFor(chat.human, control) as never, chat)).status).toBe(201)

		expect(
			await control.findConversationSessionAnyActive(chat.conversation.id, chat.agent.id),
		).toBeNull()
		// What the responder does next. sessions_conversation_actor_active_uniq would raise
		// 23505 here if the old row were still pending, starting or running.
		const respawned = await insertSession(db, chat.ws.id, chat.agent.id, chat.human, {
			conversationId: chat.conversation.id,
			interactive: true,
			status: 'starting',
			containerId: null,
		})

		// A late /complete report from the agent server only ever touches the old session id.
		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.markRemoteSessionComplete(chat.session.id, 0)
		} finally {
			await manager.stop()
		}
		expect(await statusOf(respawned.id)).toBe('starting')
		const [{ n }] = await db
			.select({ n: count() })
			.from(sessions)
			.where(
				and(eq(sessions.conversationId, chat.conversation.id), eq(sessions.status, 'starting')),
			)
		expect(n).toBe(1)
	})

	it('keeps the credential and the old session when the stop call fails, and says failed', async () => {
		const chat = await setupChat()
		const control = fakeSessionControl({
			stopSession: async () => {
				throw new Error('Failed to stop session: agent-server returned HTTP 502')
			},
		})
		const res = await capture(appFor(chat.human, control) as never, chat)
		expect(res.status).toBe(201)
		const out = (await res.json()) as { integrationId: string; relaunch: string }
		expect(out.relaunch).toBe('failed')
		const [row] = await db.select().from(integrations).where(eq(integrations.id, out.integrationId))
		expect(row?.status).toBe('pending_undo')
		expect(row?.credentials).toBeTruthy()
		expect(await statusOf(chat.session.id)).toBe('running')
	})

	it('says failed when the old session is not terminal after 10 seconds', async () => {
		const chat = await setupChat()
		let clock = 0
		const sleeps: number[] = []
		const control = fakeSessionControl({ stopSession: async () => {} }) // returns, row stays running
		const outcome = await relaunchChatSession(
			{
				db,
				sessionManager: control,
				now: () => clock,
				sleep: async (ms) => {
					sleeps.push(ms)
					clock += ms
				},
			},
			{ workspaceId: chat.ws.id, originSessionId: chat.session.id },
		)
		expect(outcome).toBe('failed')
		expect(sleeps.every((ms) => ms === RELAUNCH_POLL_MS)).toBe(true)
		expect(sleeps.length).toBe(RELAUNCH_TERMINAL_CAP_MS / RELAUNCH_POLL_MS)
		expect(await statusOf(chat.session.id)).toBe('running')
	})

	it('waits for a slow stop to settle, then says stopped', async () => {
		const chat = await setupChat()
		let polls = 0
		const control = fakeSessionControl({ stopSession: async () => {} })
		const outcome = await relaunchChatSession(
			{
				db,
				sessionManager: control,
				sleep: async () => {
					polls++
					if (polls === 3) {
						await db
							.update(sessions)
							.set({ status: 'user_stopped' })
							.where(eq(sessions.id, chat.session.id))
					}
				},
			},
			{ workspaceId: chat.ws.id, originSessionId: chat.session.id },
		)
		expect(outcome).toBe('stopped')
		expect(polls).toBe(3)
	})

	it('stops the old session once when two vaults land together', async () => {
		const chat = await setupChat()
		const gate = deferred()
		const control = fakeSessionControl({
			stopSession: async (id) => {
				await gate.promise
				await db.update(sessions).set({ status: 'user_stopped' }).where(eq(sessions.id, id))
			},
		})
		const app = appFor(chat.human, control)
		const first = capture(app as never, chat, 'First key')
		const second = capture(app as never, chat, 'Second key')
		await vi.waitFor(() => expect(control.stopSession).toHaveBeenCalled())
		await new Promise((r) => setTimeout(r, 300))
		gate.resolve()
		const [a, b] = await Promise.all([first, second])
		expect(a.status).toBe(201)
		expect(b.status).toBe(201)
		expect(((await a.json()) as { relaunch: string }).relaunch).toBe('stopped')
		expect(((await b.json()) as { relaunch: string }).relaunch).toBe('stopped')
		expect(control.stopSession).toHaveBeenCalledTimes(1)
	})

	it('does not stop a session that has not been dispatched yet: it reads the key when it is', async () => {
		const chat = await setupChat()
		await db.update(sessions).set({ status: 'queued' }).where(eq(sessions.id, chat.session.id))
		const control = fakeSessionControl()
		const res = await capture(appFor(chat.human, control) as never, chat)
		expect(((await res.json()) as { relaunch: string }).relaunch).toBe('stopped')
		expect(control.stopSession).not.toHaveBeenCalled()
	})
})

describe('undo ends the session and does not respawn it (Integration)', () => {
	it('stops the session that now holds the key and starts nothing', async () => {
		const chat = await setupChat()
		const control = fakeSessionControl()
		const app = appFor(chat.human, control)
		const { integrationId } = (await (await capture(app as never, chat)).json()) as {
			integrationId: string
		}
		// The responder respawned the chat after the vault: a new session holds the key.
		const respawned = await insertSession(db, chat.ws.id, chat.agent.id, chat.human, {
			conversationId: chat.conversation.id,
			interactive: true,
			status: 'running',
		})
		const before = (await openSessions(chat)).length

		const res = await post(app as never, chat, `${integrationId}/undo`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ id: integrationId, status: 'undone', sessionEnded: true })
		expect(control.stopSession).toHaveBeenLastCalledWith(respawned.id)
		expect(await statusOf(respawned.id)).toBe('user_stopped')
		expect((await openSessions(chat)).length).toBe(before)
		const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId))
		expect(row).toMatchObject({ status: 'undone', credentials: null })
	})

	it('has nothing to stop when no session is running, and still undoes', async () => {
		const chat = await setupChat()
		const control = fakeSessionControl()
		const app = appFor(chat.human, control)
		const { integrationId } = (await (await capture(app as never, chat)).json()) as {
			integrationId: string
		}
		control.stopSession.mockClear()
		const res = await post(app as never, chat, `${integrationId}/undo`)
		expect(res.status).toBe(200)
		expect(((await res.json()) as { sessionEnded: boolean }).sessionEnded).toBe(true)
		expect(control.stopSession).not.toHaveBeenCalled()
	})

	it('still undoes when the session cannot be stopped, and reports it', async () => {
		const chat = await setupChat()
		const okControl = fakeSessionControl()
		const { integrationId } = (await (
			await capture(appFor(chat.human, okControl) as never, chat)
		).json()) as { integrationId: string }
		const stuck = await insertSession(db, chat.ws.id, chat.agent.id, chat.human, {
			conversationId: chat.conversation.id,
			interactive: true,
			status: 'running',
		})
		const failing = fakeSessionControl({
			stopSession: async () => {
				throw new Error('Failed to stop session: agent-server request failed')
			},
		})
		const res = await post(appFor(chat.human, failing) as never, chat, `${integrationId}/undo`)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ id: integrationId, status: 'undone', sessionEnded: false })
		expect(await statusOf(stuck.id)).toBe('running')
		const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId))
		expect(row?.status).toBe('undone')
	})

	it('waits for a relaunch in flight, then runs its own stop', async () => {
		const chat = await setupChat()
		const gate = deferred()
		const respawnedIds: string[] = []
		const control = fakeSessionControl({
			stopSession: async (id) => {
				if (id === chat.session.id) {
					await gate.promise
					await db.update(sessions).set({ status: 'user_stopped' }).where(eq(sessions.id, id))
					// The old session is gone and the chat has already been respawned.
					const next = await insertSession(db, chat.ws.id, chat.agent.id, chat.human, {
						conversationId: chat.conversation.id,
						interactive: true,
						status: 'running',
					})
					respawnedIds.push(next.id)
					return
				}
				await db.update(sessions).set({ status: 'user_stopped' }).where(eq(sessions.id, id))
			},
		})
		const app = appFor(chat.human, control)

		const vault = capture(app as never, chat)
		await vi.waitFor(() => expect(control.stopSession).toHaveBeenCalledTimes(1))
		const row = await vi.waitFor(async () => {
			const [r] = await db
				.select()
				.from(integrations)
				.where(eq(integrations.workspaceId, chat.ws.id))
			expect(r).toBeDefined()
			return r
		})
		let undoDone = false
		const undo = post(app as never, chat, `${row?.id}/undo`).then((r) => {
			undoDone = true
			return r
		})
		await new Promise((r) => setTimeout(r, 400))
		// Undo is held behind the relaunch: no second stop yet.
		expect(undoDone).toBe(false)
		expect(control.stopSession).toHaveBeenCalledTimes(1)

		gate.resolve()
		expect(((await (await vault).json()) as { relaunch: string }).relaunch).toBe('stopped')
		const undone = await undo
		expect(undone.status).toBe(200)
		expect(((await undone.json()) as { sessionEnded: boolean }).sessionEnded).toBe(true)
		expect(control.stopSession).toHaveBeenCalledTimes(2)
		expect(control.stopSession).toHaveBeenLastCalledWith(respawnedIds[0])
		expect(await statusOf(respawnedIds[0] as string)).toBe('user_stopped')
	})
})

describe('POST /api/integrations/:id/relaunch, the Retry button (Integration)', () => {
	it('repeats the stop after a failure and reports stopped once it works', async () => {
		const chat = await setupChat()
		let fail = true
		const control = fakeSessionControl({
			stopSession: async (id) => {
				if (fail) throw new Error('Failed to stop session: agent-server returned HTTP 502')
				await db.update(sessions).set({ status: 'user_stopped' }).where(eq(sessions.id, id))
			},
		})
		const app = appFor(chat.human, control)
		const { integrationId, relaunch } = (await (await capture(app as never, chat)).json()) as {
			integrationId: string
			relaunch: string
		}
		expect(relaunch).toBe('failed')

		// Retry fails again: still failed, no counter, nothing auto-retried.
		const again = await post(app as never, chat, `${integrationId}/relaunch`)
		expect(await again.json()).toEqual({ relaunch: 'failed' })
		expect(control.stopSession).toHaveBeenCalledTimes(2)

		fail = false
		const retry = await post(app as never, chat, `${integrationId}/relaunch`)
		expect(retry.status).toBe(200)
		expect(await retry.json()).toEqual({ relaunch: 'stopped' })
		expect(await statusOf(chat.session.id)).toBe('user_stopped')
	})

	it('409s once the key is undone, 403s a stranger, 404s an unknown id', async () => {
		const chat = await setupChat()
		const control = fakeSessionControl()
		const app = appFor(chat.human, control)
		const { integrationId } = (await (await capture(app as never, chat)).json()) as {
			integrationId: string
		}

		const stranger = await insertActor(db)
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: chat.ws.id, actorId: stranger.id, role: 'member' })
		expect(
			(await post(appFor(stranger.id, control) as never, chat, `${integrationId}/relaunch`)).status,
		).toBe(403)
		expect((await post(app as never, chat, `${crypto.randomUUID()}/relaunch`)).status).toBe(404)

		await post(app as never, chat, `${integrationId}/undo`)
		control.stopSession.mockClear()
		expect((await post(app as never, chat, `${integrationId}/relaunch`)).status).toBe(409)
		expect(control.stopSession).not.toHaveBeenCalled()
	})
})

describe('after a vault, the relaunched session has the key; after undo, the next one does not (Integration)', () => {
	it('shows the new KEYCHAIN_ variable in the next launch env, and drops it after undo', async () => {
		const chat = await setupChat()
		const control = fakeSessionControl()
		const app = appFor(chat.human, control)
		const { integrationId } = (await (await capture(app as never, chat, 'Coolify')).json()) as {
			integrationId: string
		}

		const manager = new SessionManager(db, stubStorage())
		const launch = async () => {
			const s = await insertSession(db, chat.ws.id, chat.agent.id, chat.human, {
				status: 'pending',
				containerId: null,
			})
			const [row] = await db.select().from(sessions).where(eq(sessions.id, s.id))
			return (await manager.buildLaunchSpec(row as typeof sessions.$inferSelect)).env
		}
		try {
			// Default grant is the session driver, so the respawned agent is granted.
			expect((await launch()).KEYCHAIN_BYO_APIKEY_COOLIFY).toBe(FAKE_KEY)
			expect((await post(app as never, chat, `${integrationId}/undo`)).status).toBe(200)
			expect((await launch()).KEYCHAIN_BYO_APIKEY_COOLIFY).toBeUndefined()
		} finally {
			await manager.stop()
		}
	})
})

function stubStorage(): StorageProvider {
	return {
		put: async () => {},
		get: async () => Buffer.from(''),
		list: async () => [],
		delete: async () => {},
		exists: async () => false,
		ensureBucket: async () => {},
	}
}
