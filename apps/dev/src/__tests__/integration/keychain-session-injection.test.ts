import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MasterKeyProvider } from '@maskin/auth/kms'
import {
	events,
	conversationParticipants,
	credentialAccessLog,
	integrations,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { createByoApiKey } from '../../lib/integrations/byo-apikey'
import { captureChatSecret } from '../../lib/integrations/chat-capture'
import { TokenManager } from '../../lib/integrations/oauth/token-manager'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import { logger } from '../../lib/logger'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertConversation, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Obviously fake, built at runtime so no token-shaped literal sits in the repo.
const fake = (label: string) => `fake-${label}-${'0123456789'.repeat(3)}`

let dir: string
let kms: MasterKeyProvider
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), 'keychain-injection-kek-'))
	kms = new MasterKeyProvider(randomBytes(32))
	setKmsProviderForTests(kms)
})
afterAll(() => {
	setKmsProviderForTests(undefined)
	rmSync(dir, { recursive: true, force: true })
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

async function setup() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human, {
		enterpriseGranted: true,
		settings: { llm_keys: { anthropic: 'sk-ant-test' } },
	})
	const agentA = await insertActor(db, { type: 'agent', systemPrompt: 'Agent A' })
	const agentB = await insertActor(db, { type: 'agent', systemPrompt: 'Agent B' })
	await db.insert(workspaceMembers).values([
		{ workspaceId: ws.id, actorId: agentA.id, role: 'member' },
		{ workspaceId: ws.id, actorId: agentB.id, role: 'member' },
	])
	// A chat capture needs a conversation the human is in; without one only the driver may vault.
	const conversation = await insertConversation(db, ws.id, human)
	await db
		.insert(conversationParticipants)
		.values({ conversationId: conversation.id, actorId: human })
	const sessionFor = async (actorId: string) => {
		const s = await insertSession(db, ws.id, actorId, human, {
			status: 'pending',
			containerId: null,
			conversationId: conversation.id,
		})
		const [row] = await db.select().from(sessions).where(eq(sessions.id, s.id))
		return row as typeof sessions.$inferSelect
	}
	return {
		human,
		ws,
		agentA,
		agentB,
		sessionA: await sessionFor(agentA.id),
		sessionB: await sessionFor(agentB.id),
	}
}

/** A key vaulted the way the Keychain paste form does, then given exact grants. */
async function vaultKey(
	s: Awaited<ReturnType<typeof setup>>,
	name: string,
	value: string,
	agentIds: string[],
) {
	const { integrationId } = await createByoApiKey(db, kms, {
		workspaceId: s.ws.id,
		actorId: s.human,
		displayName: name,
		rawSecret: value,
		agentIds,
	})
	return integrationId
}

async function launchEnv(session: typeof sessions.$inferSelect) {
	const manager = new SessionManager(db, stubStorage())
	try {
		return (await manager.buildLaunchSpec(session)).env
	} finally {
		await manager.stop()
	}
}

describe('SessionManager.buildLaunchSpec — Keychain env injection (Integration)', () => {
	it('gives a granted actor KEYCHAIN_BYO_APIKEY_<SLUG> and an ungranted actor nothing', async () => {
		const s = await setup()
		const value = fake('coolify')
		await vaultKey(s, 'Coolify', value, [s.agentA.id])

		const envA = await launchEnv(s.sessionA)
		const envB = await launchEnv(s.sessionB)

		expect(envA.KEYCHAIN_BYO_APIKEY_COOLIFY).toBe(value)
		expect(Object.keys(envB).filter((k) => k.startsWith('KEYCHAIN_'))).toEqual([])
		expect(JSON.stringify(envB)).not.toContain(value)
	})

	it('names a key from its display name, as the paste form and a chat capture both store it', async () => {
		const s = await setup()
		const pasted = fake('pasted')
		await vaultKey(s, 'Notion team', pasted, [s.agentA.id])
		const captured = fake('captured')
		const { integrationId } = await captureChatSecret(db, kms, {
			workspaceId: s.ws.id,
			actorId: s.human,
			sessionId: s.sessionA.id,
			detectedProvider: 'cloudflare',
			displayName: 'Cloudflare deploy',
			rawSecret: captured,
			agentIds: [s.agentA.id],
		})

		const env = await launchEnv(s.sessionA)
		expect(env.KEYCHAIN_BYO_APIKEY_NOTION_TEAM).toBe(pasted)
		// A key still inside its undo window is injected: the session that triggered the
		// capture is the one that resumes with it.
		const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId))
		expect(row?.status).toBe('pending_undo')
		expect(env.KEYCHAIN_BYO_APIKEY_CLOUDFLARE_DEPLOY).toBe(captured)
	})

	it('leaves out undone keys, keys with no grants and keys in other workspaces', async () => {
		const s = await setup()
		const other = await setup()
		const undone = await vaultKey(s, 'Undone key', fake('undone'), [s.agentA.id])
		await db
			.update(integrations)
			.set({ status: 'undone', credentials: null, dekCiphertext: null })
			.where(eq(integrations.id, undone))
		await vaultKey(s, 'Unscoped key', fake('unscoped'), [])
		await vaultKey(other, 'Elsewhere', fake('elsewhere'), [other.agentA.id])
		await vaultKey(s, 'Visible key', fake('visible'), [s.agentA.id])

		const env = await launchEnv(s.sessionA)
		expect(Object.keys(env).filter((k) => k.startsWith('KEYCHAIN_'))).toEqual([
			'KEYCHAIN_BYO_APIKEY_VISIBLE_KEY',
		])
	})

	it('leaves out a key whose config switches off agent sessions, and does not read it', async () => {
		const s = await setup()
		const off = await vaultKey(s, 'Switched off', fake('off'), [s.agentA.id, s.agentB.id])
		await db
			.update(integrations)
			.set({ config: { expose_to_agent_sessions: false } })
			.where(eq(integrations.id, off))
		await vaultKey(s, 'Switched on', fake('on'), [s.agentA.id, s.agentB.id])

		const env = await launchEnv(s.sessionA)
		expect(Object.keys(env).filter((k) => k.startsWith('KEYCHAIN_'))).toEqual([
			'KEYCHAIN_BYO_APIKEY_SWITCHED_ON',
		])
		const reads = await db
			.select()
			.from(credentialAccessLog)
			.where(
				and(eq(credentialAccessLog.integrationId, off), eq(credentialAccessLog.action, 'read')),
			)
		expect(reads).toEqual([])
	})

	it('reaches every agent the key is granted to, and nobody when it is granted to no one', async () => {
		const s = await setup()
		await vaultKey(s, 'Shared', fake('shared'), [s.agentA.id, s.agentB.id])
		await vaultKey(s, 'Nobody', fake('nobody'), [])

		for (const session of [s.sessionA, s.sessionB]) {
			const env = await launchEnv(session)
			expect(Object.keys(env).filter((k) => k.startsWith('KEYCHAIN_'))).toEqual([
				'KEYCHAIN_BYO_APIKEY_SHARED',
			])
		}
	})

	it('never hands a bring-your-own key to the whole workspace under its provider env var', async () => {
		const s = await setup()
		// A captured slack key, active, granted to B only. The registered-provider loop
		// used to read every active row for the workspace and would have set SLACK_TOKEN.
		const value = fake('slack')
		const { integrationId } = await captureChatSecret(db, kms, {
			workspaceId: s.ws.id,
			actorId: s.human,
			sessionId: s.sessionB.id,
			detectedProvider: 'slack',
			displayName: 'Slack ops',
			rawSecret: value,
			agentIds: [s.agentB.id],
		})
		await db
			.update(integrations)
			.set({ status: 'active', undoExpiresAt: null })
			.where(eq(integrations.id, integrationId))

		// The registered-provider loop must never even try to read the row.
		const tokenRead = vi.spyOn(TokenManager.prototype, 'getValidToken')
		try {
			const envA = await launchEnv(s.sessionA)
			const envB = await launchEnv(s.sessionB)
			expect(tokenRead.mock.calls.map(([, id]) => id)).not.toContain(integrationId)
			expect(JSON.stringify(envA)).not.toContain(value)
			expect(envA.SLACK_TOKEN).toBeUndefined()
			expect(envB.SLACK_TOKEN).toBeUndefined()
			expect(envB.KEYCHAIN_BYO_APIKEY_SLACK_OPS).toBe(value)
		} finally {
			tokenRead.mockRestore()
		}
	})

	it('writes one read audit row for the granted session, and no denied-read event for anyone else', async () => {
		const s = await setup()
		const id = await vaultKey(s, 'Audited', fake('audited'), [s.agentA.id])

		await launchEnv(s.sessionA)
		await launchEnv(s.sessionB)

		const reads = await db
			.select()
			.from(credentialAccessLog)
			.where(and(eq(credentialAccessLog.integrationId, id), eq(credentialAccessLog.action, 'read')))
		expect(reads).toHaveLength(1)
		expect(reads[0]).toMatchObject({ actorId: s.agentA.id, sessionId: s.sessionA.id })
		const denied = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, id), eq(events.action, 'credential_scope_denied')))
		expect(denied).toHaveLength(0)
	})

	it('skips a name that has no usable characters, and a later key that takes a slug already used', async () => {
		const s = await setup()
		const first = fake('first')
		// The name rule now refuses an emoji-only name at the door, so rename a stored row.
		const emoji = await vaultKey(s, 'Emoji key', fake('emoji'), [s.agentA.id, s.agentB.id])
		await db.update(integrations).set({ displayName: '🔑🔑' }).where(eq(integrations.id, emoji))
		await vaultKey(s, 'My key', first, [s.agentA.id, s.agentB.id])
		// The slug check refuses a second 'my-KEY' at the door too, so rename a stored row.
		const second = await vaultKey(s, 'Second key', fake('second'), [s.agentA.id, s.agentB.id])
		await db.update(integrations).set({ displayName: 'my-KEY' }).where(eq(integrations.id, second))

		const env = await launchEnv(s.sessionA)
		expect(Object.keys(env).filter((k) => k.startsWith('KEYCHAIN_'))).toEqual([
			'KEYCHAIN_BYO_APIKEY_MY_KEY',
		])
		// Oldest wins, so the name an agent was told about keeps pointing at the same key.
		expect(env.KEYCHAIN_BYO_APIKEY_MY_KEY).toBe(first)
	})

	it('starts without a key it cannot read and logs it, rather than failing the launch', async () => {
		const s = await setup()
		const id = await vaultKey(s, 'Broken', fake('broken'), [s.agentA.id, s.agentB.id])
		await vaultKey(s, 'Fine', fake('fine'), [s.agentA.id, s.agentB.id])
		await db
			.update(integrations)
			.set({ dekCiphertext: 'not-a-wrapped-key' })
			.where(eq(integrations.id, id))
		const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
		try {
			const env = await launchEnv(s.sessionA)
			expect(env.KEYCHAIN_BYO_APIKEY_BROKEN).toBeUndefined()
			expect(env.KEYCHAIN_BYO_APIKEY_FINE).toBeDefined()
			expect(errorSpy).toHaveBeenCalledWith(
				'Keychain credential could not be read at launch; not injected',
				expect.objectContaining({ integrationId: id }),
			)
		} finally {
			errorSpy.mockRestore()
		}
	})

	it('puts only redacted names in the container-start log, never a value', async () => {
		const s = await setup()
		const value = fake('logged')
		await vaultKey(s, 'Logged', value, [s.agentA.id])
		const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
		try {
			await launchEnv(s.sessionA)
			const start = infoSpy.mock.calls.find(([msg]) => msg === 'Session launch env built')
			expect(start).toBeDefined()
			const logged = JSON.stringify(start)
			expect(logged).toContain('KEYCHAIN_BYO_APIKEY_LOGGED')
			expect(logged).not.toContain(value)
			expect((start?.[1] as { env: Record<string, string> }).env.KEYCHAIN_BYO_APIKEY_LOGGED).toBe(
				'[redacted]',
			)
			expect(JSON.stringify(infoSpy.mock.calls)).not.toContain(value)
		} finally {
			infoSpy.mockRestore()
		}
	})
})
