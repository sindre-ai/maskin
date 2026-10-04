import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { type ScopeGrant, integrations } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

const here = dirname(fileURLToPath(import.meta.url))
const drizzleDir = join(here, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')
const BACKFILL = readFileSync(join(drizzleDir, '0088_keychain_scope_grant_backfill.sql'), 'utf-8')
const BACKFILL_DOWN = readFileSync(
	join(drizzleDir, 'down', '0088_keychain_scope_grant_backfill_down.sql'),
	'utf-8',
)

// Obviously fake blob: the backfill never reads credentials.
const FAKE = 'fake-credential-blob-not-real'

async function runSql(content: string) {
	for (const statement of splitStatements(content)) await sql.unsafe(statement)
}

async function insertRow(
	workspaceId: string,
	provider: string,
	opts: { grants?: ScopeGrant[]; status?: string; actorId?: string | null } = {},
) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider,
			status: (opts.status ?? 'active') as 'active',
			credentials: FAKE,
			actorId: opts.actorId ?? null,
			...(opts.grants ? { scopeGrants: opts.grants } : {}),
			createdBy: getTestActorId(),
		})
		.returning()
	return row
}

const grantsOf = async (id: string) =>
	(
		await db
			.select({ g: integrations.scopeGrants })
			.from(integrations)
			.where(eq(integrations.id, id))
	)[0].g

describe('0088 scope-grant backfill', () => {
	async function seed() {
		const ws = await insertWorkspace(db, getTestActorId())
		const human = await insertActor(db)
		const human2 = await insertActor(db)
		const ws2 = await insertWorkspace(db, getTestActorId())
		const actorGrant: ScopeGrant[] = [{ kind: 'actor', actorId: human.id }]
		return {
			ws,
			human,
			actorGrant,
			meet: await insertRow(ws.id, 'google-meet'),
			linkedin: await insertRow(ws.id, 'linkedin-unipile', { actorId: human.id }),
			revokedLinkedin: await insertRow(ws.id, 'linkedin-unipile', {
				status: 'revoked',
				actorId: human2.id,
			}),
			other: await insertRow(ws.id, 'slack'),
			meetGranted: await insertRow(ws2.id, 'google-meet', { grants: actorGrant }),
		}
	}

	it('gives empty-grants google-meet and linkedin-unipile rows exactly one workspace grant', async () => {
		const s = await seed()
		await runSql(BACKFILL)
		expect(await grantsOf(s.meet.id)).toEqual([{ kind: 'workspace' }])
		expect(await grantsOf(s.linkedin.id)).toEqual([{ kind: 'workspace' }])
		expect(await grantsOf(s.revokedLinkedin.id)).toEqual([{ kind: 'workspace' }])
	})

	it('leaves other providers and rows that already have grants untouched', async () => {
		const s = await seed()
		await runSql(BACKFILL)
		expect(await grantsOf(s.other.id)).toEqual([])
		expect(await grantsOf(s.meetGranted.id)).toEqual(s.actorGrant)
	})

	it('is idempotent: a second run leaves scope_grants unchanged', async () => {
		const s = await seed()
		await runSql(BACKFILL)
		const ids = [s.meet, s.linkedin, s.revokedLinkedin, s.other, s.meetGranted].map((r) => r.id)
		const afterFirst = await Promise.all(ids.map(grantsOf))
		await runSql(BACKFILL)
		expect(await Promise.all(ids.map(grantsOf))).toEqual(afterFirst)
		expect(afterFirst[0]).toHaveLength(1)
	})

	it('the down file resets only lone workspace grants on these two providers', async () => {
		const s = await seed()
		const ws3 = await insertWorkspace(db, getTestActorId())
		const slackWorkspaceGrant = await insertRow(ws3.id, 'slack', {
			grants: [{ kind: 'workspace' }],
		})
		await runSql(BACKFILL)
		await runSql(BACKFILL_DOWN)
		expect(await grantsOf(s.meet.id)).toEqual([])
		expect(await grantsOf(s.linkedin.id)).toEqual([])
		expect(await grantsOf(s.meetGranted.id)).toEqual(s.actorGrant)
		expect(await grantsOf(slackWorkspaceGrant.id)).toEqual([{ kind: 'workspace' }])
	})
})
