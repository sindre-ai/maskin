import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	LOGIN_KEY_CAP,
	hashApiKey,
	hashPassword,
	issueApiKey,
	revokeSessionKeys,
	validateApiKey,
} from '@maskin/auth'
import { splitStatements } from '@maskin/db/migrate-utils'
import { type ApiKeyKind, actors, apiKeys } from '@maskin/db/schema'
import { and, eq, isNull } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId, sql } from './global-setup'

const { default: authRoutes } = await import('../../routes/auth')

const __dirname = dirname(fileURLToPath(import.meta.url))
const MIGRATION = join(
	__dirname,
	'..',
	'..',
	'..',
	'..',
	'..',
	'packages',
	'db',
	'drizzle',
	'0111_api_keys.sql',
)

const PASSWORD = 'correct horse battery'

async function liveKeys(actorId: string, kind: ApiKeyKind) {
	return db
		.select({ id: apiKeys.id })
		.from(apiKeys)
		.where(and(eq(apiKeys.actorId, actorId), eq(apiKeys.kind, kind), isNull(apiKeys.revokedAt)))
}

describe('API keys stored hashed (real Postgres)', () => {
	describe('migration 0111 backfill', () => {
		const backfill = splitStatements(readFileSync(MIGRATION, 'utf-8')).find((s) =>
			s.startsWith('INSERT INTO "api_keys"'),
		)

		it('turns each legacy ank_ key into a primary key row that still authenticates', async () => {
			expect(backfill).toBeTruthy()
			const legacyKey = 'ank_0123456789abcdef0123456789abcdef'
			const [legacy] = await sql`
				INSERT INTO actors (type, name, api_key) VALUES ('agent', 'Legacy agent', ${legacyKey})
				RETURNING id
			`
			// Placeholder values that can never authenticate must not be copied over.
			const [tombstone] = await sql`
				INSERT INTO actors (type, name, api_key)
				VALUES ('human', 'Deleted user', 'deleted_0123456789abcdef')
				RETURNING id
			`

			await sql.unsafe(backfill as string)

			expect(await validateApiKey(db, legacyKey)).toEqual({ actorId: legacy.id, type: 'agent' })
			const rows = await db.select().from(apiKeys).where(eq(apiKeys.actorId, legacy.id))
			expect(rows).toHaveLength(1)
			// Postgres' built-in sha256 and the app's hash agree, which is what lets old keys keep working.
			expect(rows[0].keyHash).toBe(hashApiKey(legacyKey))
			expect(rows[0].last4).toBe('cdef')
			expect(rows[0].kind).toBe('primary')
			expect(await db.select().from(apiKeys).where(eq(apiKeys.actorId, tombstone.id))).toEqual([])
		})

		it('is safe to run twice', async () => {
			const legacyKey = 'ank_fedcba9876543210fedcba9876543210'
			const [legacy] = await sql`
				INSERT INTO actors (type, name, api_key) VALUES ('human', 'Twice', ${legacyKey})
				RETURNING id
			`

			await sql.unsafe(backfill as string)
			await sql.unsafe(backfill as string)

			expect(await db.select().from(apiKeys).where(eq(apiKeys.actorId, legacy.id))).toHaveLength(1)
		})
	})

	describe('validateApiKey', () => {
		it('refuses revoked and expired keys', async () => {
			const agent = await insertActor(db, { type: 'agent', apiKey: null })
			const live = await issueApiKey(db, { actorId: agent.id, kind: 'primary' })
			const revoked = await issueApiKey(db, { actorId: agent.id, kind: 'primary' })
			await db
				.update(apiKeys)
				.set({ revokedAt: new Date() })
				.where(eq(apiKeys.keyHash, revoked.keyHash))
			const expired = await issueApiKey(db, {
				actorId: agent.id,
				kind: 'session',
				expiresAt: new Date(Date.now() - 1_000),
			})

			expect(await validateApiKey(db, live.key)).toEqual({ actorId: agent.id, type: 'agent' })
			expect(await validateApiKey(db, revoked.key)).toBeNull()
			expect(await validateApiKey(db, expired.key)).toBeNull()
			expect(await validateApiKey(db, 'ank_unknown')).toBeNull()
		})

		it('stamps last_used_at on the key that authenticated, and only that one', async () => {
			const agent = await insertActor(db, { type: 'agent', apiKey: null })
			const used = await issueApiKey(db, { actorId: agent.id, kind: 'primary' })
			const idle = await issueApiKey(db, { actorId: agent.id, kind: 'primary' })
			const lastUsed = async (keyHash: string) =>
				(await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)))[0].lastUsedAt

			expect(await lastUsed(used.keyHash)).toBeNull()
			await validateApiKey(db, used.key)
			await validateApiKey(db, 'ank_unknown')

			expect(await lastUsed(used.keyHash)).toBeInstanceOf(Date)
			expect(await lastUsed(idle.keyHash)).toBeNull()
		})

		it('does not store the plaintext key anywhere in api_keys', async () => {
			const agent = await insertActor(db, { type: 'agent', apiKey: null })
			const { key } = await issueApiKey(db, { actorId: agent.id, kind: 'primary' })

			const rows = await sql`SELECT * FROM api_keys WHERE actor_id = ${agent.id}`

			expect(JSON.stringify(rows)).not.toContain(key)
		})
	})

	describe('session keys', () => {
		it('minting a replacement revokes the previous key of the same session only', async () => {
			const ws = await insertWorkspace(db, getTestActorId())
			const agent = await insertActor(db, { type: 'agent', apiKey: null })
			const mine = await insertSession(db, ws.id, agent.id, getTestActorId(), {})
			const other = await insertSession(db, ws.id, agent.id, getTestActorId(), {})
			const first = await issueApiKey(db, {
				actorId: agent.id,
				kind: 'session',
				sessionId: mine.id,
			})
			const bystander = await issueApiKey(db, {
				actorId: agent.id,
				kind: 'session',
				sessionId: other.id,
			})
			const second = await issueApiKey(db, {
				actorId: agent.id,
				kind: 'session',
				sessionId: mine.id,
			})

			await revokeSessionKeys(db, mine.id, second.keyHash)

			expect(await validateApiKey(db, first.key)).toBeNull()
			expect(await validateApiKey(db, second.key)).not.toBeNull()
			expect(await validateApiKey(db, bystander.key)).not.toBeNull()
		})

		it('dies with its session row', async () => {
			const ws = await insertWorkspace(db, getTestActorId())
			const agent = await insertActor(db, { type: 'agent', apiKey: null })
			const session = await insertSession(db, ws.id, agent.id, getTestActorId(), {})
			const { key } = await issueApiKey(db, {
				actorId: agent.id,
				kind: 'session',
				sessionId: session.id,
			})

			await sql`DELETE FROM sessions WHERE id = ${session.id}`

			expect(await validateApiKey(db, key)).toBeNull()
		})
	})

	describe('POST /api/auth/login', () => {
		const app = () => createIntegrationApp({ path: '/api/auth', module: authRoutes as never })

		async function login(email: string, headers: Record<string, string> = {}) {
			const res = await app().request(
				jsonRequest('POST', '/api/auth/login', { email, password: PASSWORD }, headers),
			)
			expect(res.status).toBe(200)
			return ((await res.json()) as { api_key: string }).api_key
		}

		async function human() {
			return insertActor(db, {
				type: 'human',
				email: `login-${Math.random().toString(36).slice(2)}@example.com`,
				passwordHash: await hashPassword(PASSWORD),
				apiKey: null,
			})
		}

		it('mints a fresh key per login, stored hashed, and never the legacy column', async () => {
			const person = await human()

			const first = await login(person.email as string)
			const second = await login(person.email as string)

			expect(first).toMatch(/^ank_/)
			expect(second).not.toBe(first)
			expect(await validateApiKey(db, first)).toEqual({ actorId: person.id, type: 'human' })
			expect(await validateApiKey(db, second)).toEqual({ actorId: person.id, type: 'human' })
			const [row] = await db.select().from(actors).where(eq(actors.id, person.id))
			expect(row.apiKey).toBeNull()
		})

		it('keeps ten live web logins and revokes the oldest beyond that', async () => {
			const person = await human()
			const keys: string[] = []
			for (let i = 0; i < LOGIN_KEY_CAP + 1; i++) keys.push(await login(person.email as string))

			expect(await liveKeys(person.id, 'login')).toHaveLength(LOGIN_KEY_CAP)
			expect(await validateApiKey(db, keys[0])).toBeNull()
			expect(await validateApiKey(db, keys[1])).not.toBeNull()
			expect(await validateApiKey(db, keys[LOGIN_KEY_CAP])).not.toBeNull()
		})

		it('never lets web logins revoke the phone app key', async () => {
			const person = await human()
			const phone = await login(person.email as string, { 'X-Client-Source': 'ios' })
			for (let i = 0; i < LOGIN_KEY_CAP + 1; i++) await login(person.email as string)

			expect(await validateApiKey(db, phone)).toEqual({ actorId: person.id, type: 'human' })
			expect(await liveKeys(person.id, 'login_ios')).toHaveLength(1)
		})
	})
})
