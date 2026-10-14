import { mintToken, sha256Hex, validateOAuthAccessToken } from '@maskin/auth'
import {
	events,
	actors,
	oauthAuthorizationCodes,
	oauthGrants,
	oauthTokens,
	workspaces,
} from '@maskin/db/schema'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

// Slice 1 of the MCP OAuth bet: the tables and the token primitives. Nothing mints a
// token through an endpoint yet, so every row here is inserted directly, and the
// consume / rotate / revoke statements below are the ones the token endpoint will run.

const CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
const RESOURCE = 'https://maskin.io/mcp'
const HOUR_MS = 3_600_000

async function insertGrant(
	actorId: string,
	workspaceId: string,
	overrides: Partial<typeof oauthGrants.$inferInsert> = {},
) {
	const [grant] = await db
		.insert(oauthGrants)
		.values({
			actorId,
			workspaceId,
			clientId: CLIENT_ID,
			clientName: 'Claude',
			resource: RESOURCE,
			...overrides,
		})
		.returning()
	return grant
}

async function insertToken(
	grantId: string,
	kind: 'access' | 'refresh',
	overrides: Partial<typeof oauthTokens.$inferInsert> = {},
) {
	const { raw, hash } = mintToken(kind === 'access' ? 'mat_' : 'mrt_')
	const [row] = await db
		.insert(oauthTokens)
		.values({
			grantId,
			kind,
			tokenHash: hash,
			expiresAt: new Date(Date.now() + HOUR_MS),
			...overrides,
		})
		.returning()
	return { raw, row }
}

async function insertCode(grantId: string, overrides: { expiresAt?: Date } = {}) {
	const { raw, hash } = mintToken('')
	await db.insert(oauthAuthorizationCodes).values({
		codeHash: hash,
		grantId,
		redirectUri: 'https://claude.ai/api/mcp/auth_callback',
		codeChallenge: mintToken('').raw,
		resource: RESOURCE,
		expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
	})
	return { raw, hash }
}

// The atomic consume from the token endpoint: one UPDATE, so exactly one caller gets the row.
async function consumeCode(codeHash: string) {
	return db
		.update(oauthAuthorizationCodes)
		.set({ consumedAt: new Date() })
		.where(
			and(
				eq(oauthAuthorizationCodes.codeHash, codeHash),
				isNull(oauthAuthorizationCodes.consumedAt),
				gt(oauthAuthorizationCodes.expiresAt, new Date()),
			),
		)
		.returning({ grantId: oauthAuthorizationCodes.grantId })
}

// Revoking a grant kills the grant and every token on it.
async function revokeGrant(grantId: string, reason: string, byActorId?: string) {
	const now = new Date()
	await db.transaction(async (tx) => {
		await tx
			.update(oauthGrants)
			.set({ revokedAt: now, revokeReason: reason, revokedByActorId: byActorId ?? null })
			.where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.revokedAt)))
		await tx
			.update(oauthTokens)
			.set({ revokedAt: now })
			.where(and(eq(oauthTokens.grantId, grantId), isNull(oauthTokens.revokedAt)))
	})
}

async function count(table: 'oauth_grants' | 'oauth_authorization_codes' | 'oauth_tokens') {
	const rows = await sql.unsafe(`SELECT count(*)::int AS n FROM "${table}"`)
	return rows[0].n as number
}

describe('migration 0092: oauth tables', () => {
	it('creates the three tables with the spec columns and no expires_at on grants', async () => {
		const cols = async (table: string) =>
			(
				await sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table} ORDER BY column_name`
			).map((r) => r.column_name as string)

		expect(await cols('oauth_grants')).toEqual(
			[
				'actor_id',
				'client_id',
				'client_name',
				'created_at',
				'id',
				'last_used_at',
				'resource',
				'revoke_reason',
				'revoked_at',
				'revoked_by_actor_id',
				'scope',
				'workspace_id',
			].sort(),
		)
		expect(await cols('oauth_authorization_codes')).toEqual(
			[
				'code_challenge',
				'code_hash',
				'consumed_at',
				'created_at',
				'expires_at',
				'grant_id',
				'redirect_uri',
				'resource',
			].sort(),
		)
		expect(await cols('oauth_tokens')).toEqual(
			[
				'created_at',
				'expires_at',
				'grant_id',
				'id',
				'kind',
				'replaced_by',
				'revoked_at',
				'token_hash',
				'used_at',
			].sort(),
		)
	})

	it('creates the indexes, including the partial unique live-grant index', async () => {
		const idx = (
			await sql`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename LIKE 'oauth_%'`
		).reduce<Record<string, string>>((acc, r) => {
			acc[r.indexname as string] = r.indexdef as string
			return acc
		}, {})

		expect(idx.oauth_grants_live_uniq).toMatch(
			/UNIQUE INDEX.*\(actor_id, workspace_id, client_id\)/,
		)
		expect(idx.oauth_grants_live_uniq).toMatch(/WHERE \(revoked_at IS NULL\)/)
		expect(idx.oauth_grants_workspace_live_idx).toMatch(
			/\(workspace_id\).*WHERE \(revoked_at IS NULL\)/,
		)
		expect(idx.oauth_authorization_codes_grant_idx).toBeDefined()
		expect(idx.oauth_authorization_codes_expires_at_idx).toBeDefined()
		expect(idx.oauth_tokens_grant_idx).toBeDefined()
		expect(idx.oauth_tokens_expires_at_idx).toBeDefined()
		expect(idx.oauth_tokens_token_hash_unique).toMatch(/UNIQUE INDEX/)
	})

	it('wires the cascades: delete rules on every foreign key', async () => {
		const rows = await sql`
			SELECT con.conname, con.confdeltype
			FROM pg_constraint con
			WHERE con.contype = 'f' AND con.conrelid::regclass::text LIKE 'oauth_%'
		`
		const rule = Object.fromEntries(rows.map((r) => [r.conname as string, r.confdeltype as string]))
		// c = cascade, n = set null
		expect(rule).toEqual({
			oauth_grants_actor_id_actors_id_fk: 'c',
			oauth_grants_workspace_id_workspaces_id_fk: 'c',
			oauth_grants_revoked_by_actor_id_actors_id_fk: 'n',
			oauth_authorization_codes_grant_id_oauth_grants_id_fk: 'c',
			oauth_tokens_grant_id_oauth_grants_id_fk: 'c',
			oauth_tokens_replaced_by_oauth_tokens_id_fk: 'n',
		})
	})

	it('rejects a token kind other than access or refresh', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const grant = await insertGrant(getTestActorId(), ws.id)
		await expect(
			sql`INSERT INTO oauth_tokens (grant_id, kind, token_hash, expires_at) VALUES (${grant.id}, 'bogus', ${sha256Hex('x')}, now())`,
		).rejects.toMatchObject({ code: '23514' })
	})
})

describe('mint grant, code and tokens', () => {
	it('stores the hash of a minted token and resolves the raw value to the person and workspace', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const grant = await insertGrant(actorId, ws.id)
		const access = await insertToken(grant.id, 'access')

		expect(access.row.tokenHash).toBe(sha256Hex(access.raw))
		expect(access.row.tokenHash).not.toBe(access.raw)

		const ctx = await validateOAuthAccessToken(db, access.raw)
		expect(ctx).toMatchObject({
			actorId,
			type: 'human',
			workspaceId: ws.id,
			grantId: grant.id,
			clientId: CLIENT_ID,
			scope: 'mcp',
			resource: RESOURCE,
		})
		expect(ctx?.expiresAt.getTime()).toBe(access.row.expiresAt.getTime())
	})

	it('defaults a grant to scope mcp with no last-used or revoked time', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const grant = await insertGrant(getTestActorId(), ws.id)
		expect(grant.scope).toBe('mcp')
		expect(grant.lastUsedAt).toBeNull()
		expect(grant.revokedAt).toBeNull()
	})
})

describe('validateOAuthAccessToken', () => {
	it('does not resolve a refresh token presented as a bearer', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const grant = await insertGrant(getTestActorId(), ws.id)
		const refresh = await insertToken(grant.id, 'refresh')
		expect(await validateOAuthAccessToken(db, refresh.raw)).toBeNull()
	})

	it('does not resolve an access-kind row whose raw value lacks the mat_ prefix', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const grant = await insertGrant(getTestActorId(), ws.id)
		const { raw, hash } = mintToken('xyz_')
		await db.insert(oauthTokens).values({
			grantId: grant.id,
			kind: 'access',
			tokenHash: hash,
			expiresAt: new Date(Date.now() + HOUR_MS),
		})
		expect(await validateOAuthAccessToken(db, raw)).toBeNull()
	})

	it('does not resolve an unknown token', async () => {
		expect(await validateOAuthAccessToken(db, mintToken('mat_').raw)).toBeNull()
	})

	it('does not resolve an expired token', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const grant = await insertGrant(getTestActorId(), ws.id)
		const access = await insertToken(grant.id, 'access', { expiresAt: new Date(Date.now() - 1000) })
		expect(await validateOAuthAccessToken(db, access.raw)).toBeNull()
	})

	it('does not resolve a revoked token', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const grant = await insertGrant(getTestActorId(), ws.id)
		const access = await insertToken(grant.id, 'access', { revokedAt: new Date() })
		expect(await validateOAuthAccessToken(db, access.raw)).toBeNull()
	})

	it('does not resolve a token whose grant is revoked, even if the token row is not', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const grant = await insertGrant(getTestActorId(), ws.id)
		const access = await insertToken(grant.id, 'access')
		expect(await validateOAuthAccessToken(db, access.raw)).not.toBeNull()

		await db
			.update(oauthGrants)
			.set({ revokedAt: new Date(), revokeReason: 'user' })
			.where(eq(oauthGrants.id, grant.id))

		expect(await validateOAuthAccessToken(db, access.raw)).toBeNull()
	})
})

describe('authorization code', () => {
	it('lets exactly one of two concurrent consumes win', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const grant = await insertGrant(getTestActorId(), ws.id)
		const code = await insertCode(grant.id)

		const results = await Promise.all([consumeCode(code.hash), consumeCode(code.hash)])

		expect(results.map((r) => r.length).sort()).toEqual([0, 1])
		const winner = results.find((r) => r.length === 1)
		expect(winner?.[0].grantId).toBe(grant.id)
	})

	it('lets exactly one of many concurrent consumes win', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const grant = await insertGrant(getTestActorId(), ws.id)
		const code = await insertCode(grant.id)

		const results = await Promise.all(Array.from({ length: 8 }, () => consumeCode(code.hash)))

		expect(results.filter((r) => r.length === 1)).toHaveLength(1)
	})

	it('does not consume an expired code', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const grant = await insertGrant(getTestActorId(), ws.id)
		const code = await insertCode(grant.id, { expiresAt: new Date(Date.now() - 1000) })
		expect(await consumeCode(code.hash)).toHaveLength(0)
	})

	it('leaves a consumed row behind so a replay can be told apart from an unknown code', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const grant = await insertGrant(getTestActorId(), ws.id)
		const code = await insertCode(grant.id)
		await consumeCode(code.hash)

		expect(await consumeCode(code.hash)).toHaveLength(0)
		const [row] = await db
			.select()
			.from(oauthAuthorizationCodes)
			.where(eq(oauthAuthorizationCodes.codeHash, code.hash))
		expect(row.consumedAt).not.toBeNull()
	})
})

describe('refresh rotation and reuse', () => {
	// The rotation transaction from the token endpoint: lock the old row, mark it used,
	// insert the replacement pair.
	async function rotate(oldRefreshHash: string) {
		return db.transaction(async (tx) => {
			const [old] = await tx
				.select()
				.from(oauthTokens)
				.where(and(eq(oauthTokens.tokenHash, oldRefreshHash), eq(oauthTokens.kind, 'refresh')))
				.for('update')
			if (!old || old.usedAt) return { reuse: true as const, grantId: old?.grantId }

			const next = mintToken('mrt_')
			const [newRefresh] = await tx
				.insert(oauthTokens)
				.values({
					grantId: old.grantId,
					kind: 'refresh',
					tokenHash: next.hash,
					expiresAt: new Date(Date.now() + 30 * 24 * HOUR_MS),
				})
				.returning()
			await tx
				.update(oauthTokens)
				.set({ usedAt: new Date(), replacedBy: newRefresh.id })
				.where(eq(oauthTokens.id, old.id))
			const access = mintToken('mat_')
			await tx.insert(oauthTokens).values({
				grantId: old.grantId,
				kind: 'access',
				tokenHash: access.hash,
				expiresAt: new Date(Date.now() + HOUR_MS),
			})
			return { reuse: false as const, grantId: old.grantId, newRefresh, access: access.raw }
		})
	}

	it('rotates: the old refresh is marked used and points at its replacement', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const grant = await insertGrant(getTestActorId(), ws.id)
		const refresh = await insertToken(grant.id, 'refresh')

		const result = await rotate(refresh.row.tokenHash)

		expect(result.reuse).toBe(false)
		if (result.reuse) return
		const [old] = await db.select().from(oauthTokens).where(eq(oauthTokens.id, refresh.row.id))
		expect(old.usedAt).not.toBeNull()
		expect(old.replacedBy).toBe(result.newRefresh.id)
		expect((await validateOAuthAccessToken(db, result.access))?.grantId).toBe(grant.id)
	})

	it('treats a second presentation as reuse, and revoking the grant kills every token', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const grant = await insertGrant(getTestActorId(), ws.id)
		const refresh = await insertToken(grant.id, 'refresh')
		const access = await insertToken(grant.id, 'access')

		const first = await rotate(refresh.row.tokenHash)
		expect(first.reuse).toBe(false)
		const second = await rotate(refresh.row.tokenHash)
		expect(second.reuse).toBe(true)

		await revokeGrant(grant.id, 'refresh_reuse')

		const [g] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, grant.id))
		expect(g.revokedAt).not.toBeNull()
		expect(g.revokeReason).toBe('refresh_reuse')
		expect(await validateOAuthAccessToken(db, access.raw)).toBeNull()
		if (!first.reuse) expect(await validateOAuthAccessToken(db, first.access)).toBeNull()
		const live = await db
			.select()
			.from(oauthTokens)
			.where(and(eq(oauthTokens.grantId, grant.id), isNull(oauthTokens.revokedAt)))
		expect(live).toHaveLength(0)
	})

	it('lets only one of two concurrent rotations of the same refresh token through', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const grant = await insertGrant(getTestActorId(), ws.id)
		const refresh = await insertToken(grant.id, 'refresh')

		const results = await Promise.all([
			rotate(refresh.row.tokenHash),
			rotate(refresh.row.tokenHash),
		])

		expect(results.filter((r) => !r.reuse)).toHaveLength(1)
		expect(results.filter((r) => r.reuse)).toHaveLength(1)
	})

	it('clears replaced_by when the replacement row is deleted', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const grant = await insertGrant(getTestActorId(), ws.id)
		const refresh = await insertToken(grant.id, 'refresh')
		const result = await rotate(refresh.row.tokenHash)
		if (result.reuse) throw new Error('expected a rotation')

		await db.delete(oauthTokens).where(eq(oauthTokens.id, result.newRefresh.id))

		const [old] = await db.select().from(oauthTokens).where(eq(oauthTokens.id, refresh.row.id))
		expect(old.replacedBy).toBeNull()
	})
})

describe('one live grant per person, workspace and client', () => {
	it('rejects a second live grant for the same triple', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const first = await insertGrant(getTestActorId(), ws.id)
		await expect(
			sql`INSERT INTO oauth_grants (actor_id, workspace_id, client_id, client_name, resource) VALUES (${first.actorId}, ${first.workspaceId}, ${first.clientId}, 'Claude', ${RESOURCE})`,
		).rejects.toMatchObject({ code: '23505', constraint_name: 'oauth_grants_live_uniq' })
	})

	it('allows a new grant once the old one is revoked', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const first = await insertGrant(getTestActorId(), ws.id)
		await revokeGrant(first.id, 'user', getTestActorId())

		const second = await insertGrant(getTestActorId(), ws.id)

		expect(second.id).not.toBe(first.id)
		const live = await db
			.select()
			.from(oauthGrants)
			.where(and(eq(oauthGrants.workspaceId, ws.id), isNull(oauthGrants.revokedAt)))
		expect(live.map((g) => g.id)).toEqual([second.id])
	})

	it('allows live grants for a different workspace, client or person', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const other = await insertWorkspace(db, getTestActorId())
		const person = await insertActor(db)
		await insertGrant(getTestActorId(), ws.id)

		await insertGrant(getTestActorId(), other.id)
		await insertGrant(getTestActorId(), ws.id, { clientId: 'https://example.com/other-client' })
		await insertGrant(person.id, ws.id)

		expect(await count('oauth_grants')).toBe(4)
	})
})

describe('cascades', () => {
	async function seed() {
		const person = await insertActor(db)
		// The workspace belongs to the shared test actor so deleting the person is not blocked.
		const ws = await insertWorkspace(db, getTestActorId())
		const grant = await insertGrant(person.id, ws.id)
		const access = await insertToken(grant.id, 'access')
		await insertToken(grant.id, 'refresh')
		await insertCode(grant.id)
		return { person, ws, grant, access }
	}

	it('deleting the actor removes the grant, its codes and its tokens', async () => {
		const { person, access } = await seed()
		expect(await count('oauth_grants')).toBe(1)

		await db.delete(actors).where(eq(actors.id, person.id))

		expect(await count('oauth_grants')).toBe(0)
		expect(await count('oauth_tokens')).toBe(0)
		expect(await count('oauth_authorization_codes')).toBe(0)
		expect(await validateOAuthAccessToken(db, access.raw)).toBeNull()
	})

	it('deleting the workspace removes the grant, its codes and its tokens', async () => {
		const { ws } = await seed()
		expect(await count('oauth_grants')).toBe(1)

		await db.delete(workspaces).where(eq(workspaces.id, ws.id))

		expect(await count('oauth_grants')).toBe(0)
		expect(await count('oauth_tokens')).toBe(0)
		expect(await count('oauth_authorization_codes')).toBe(0)
	})

	it('deleting the revoking actor keeps the revoked grant and clears the revoker', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const admin = await insertActor(db)
		const grant = await insertGrant(getTestActorId(), ws.id)
		await revokeGrant(grant.id, 'admin', admin.id)

		await db.delete(actors).where(eq(actors.id, admin.id))

		const [g] = await db.select().from(oauthGrants).where(eq(oauthGrants.id, grant.id))
		expect(g.revokedAt).not.toBeNull()
		expect(g.revokedByActorId).toBeNull()
		expect(g.revokeReason).toBe('admin')
	})
})

describe('no raw token or code is ever stored', () => {
	// Every row of every table, as text: catches a raw value in any column, including
	// jsonb such as events.data. The shape is the mint format, so unrelated text that
	// merely contains "mat_" does not trip it.
	async function rowsHoldingRawTokens() {
		const tables = await sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`
		const hits: Record<string, number> = {}
		for (const { tablename } of tables) {
			if (tablename === '_migrations') continue
			const rows = await sql.unsafe(
				`SELECT count(*)::int AS n FROM "${tablename}" t WHERE t::text ~ 'm(at|rt)_[A-Za-z0-9_-]{43}'`,
			)
			if (rows[0].n > 0) hits[tablename as string] = rows[0].n
		}
		return hits
	}

	it('finds nothing after minting a full grant, code, access token and rotated refresh token', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const grant = await insertGrant(getTestActorId(), ws.id)
		const minted = [
			await insertToken(grant.id, 'access'),
			await insertToken(grant.id, 'refresh'),
			await insertCode(grant.id),
		]
		await revokeGrant(grant.id, 'user', getTestActorId())

		expect(await rowsHoldingRawTokens()).toEqual({})

		// Belt and braces: none of the raw values appears anywhere in the grant tables.
		for (const { raw } of minted) {
			for (const table of ['oauth_grants', 'oauth_authorization_codes', 'oauth_tokens']) {
				const rows = await sql.unsafe(
					`SELECT count(*)::int AS n FROM "${table}" t WHERE position($1 in t::text) > 0`,
					[raw],
				)
				expect(rows[0].n).toBe(0)
			}
		}
	})

	it('is not vacuous: the scan does catch a raw token planted in events.data', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await db.insert(events).values({
			workspaceId: ws.id,
			actorId: getTestActorId(),
			action: 'oauth_token_issued',
			entityType: 'oauth_grant',
			entityId: ws.id,
			data: { leaked: mintToken('mat_').raw },
		})

		expect(await rowsHoldingRawTokens()).toEqual({ events: 1 })
	})
})
