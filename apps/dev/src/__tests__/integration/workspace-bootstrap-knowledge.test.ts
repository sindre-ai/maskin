import type { Database } from '@maskin/db'
import { actors, objects, workspaceMembers } from '@maskin/db/schema'
import {
	CHIEF_OF_STAFF_DEFAULT,
	DEFAULT_WORKSPACE_KNOWLEDGE,
	ONBOARDING_CHECKLIST_SEED_SLUG,
} from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	VAERKSTED_CHECKLIST_OBJECT_ID,
	VAERKSTED_WORKSPACE_ID,
	backfillOnboardingChecklist,
} from '../../../scripts/backfill-onboarding-checklist'
import { AgentStorageManager } from '../../services/agent-storage'
import { bootstrapDefaultAgents } from '../../services/workspace-bootstrap'
import { insertWorkspace } from '../factories'
import { db, sql as rawSql } from './global-setup'

function createMemoryStorage(): StorageProvider {
	const store = new Map<string, Buffer>()
	return {
		async put(key, data) {
			store.set(key, Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array))
		},
		async get(key) {
			const buf = store.get(key)
			if (!buf) throw new Error(`Not found: ${key}`)
			return buf
		},
		async list(prefix) {
			return [...store.keys()].filter((k) => k.startsWith(prefix))
		},
		async listWithMetadata(prefix) {
			return [...store.entries()]
				.filter(([k]) => k.startsWith(prefix))
				.map(([key, buf]) => ({ key, size: buf.length }))
		},
		async delete(key) {
			store.delete(key)
		},
		async exists(key) {
			return store.has(key)
		},
		async ensureBucket() {
			// no-op
		},
	}
}

async function resolveChiefActorId(dbInstance: Database, workspaceId: string) {
	const [row] = await dbInstance
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(actors.name, CHIEF_OF_STAFF_DEFAULT.name),
			),
		)
		.limit(1)
	return row?.actorId
}

describe('bootstrapDefaultAgents — DEFAULT_WORKSPACE_KNOWLEDGE seeding', () => {
	beforeEach(async () => {
		// global-setup's beforeEach TRUNCATE clears objects/workspaces but not
		// actors — clear here so each test gets a clean Chief-of-Staff seeding.
		await rawSql`TRUNCATE actors CASCADE`
	})

	it('inserts one knowledge object per DEFAULT_WORKSPACE_KNOWLEDGE entry with the seeded title, type=knowledge, status=draft, createdBy=chiefId', async () => {
		const [ownerRow] = await rawSql`
			INSERT INTO actors (type, name, email, api_key)
			VALUES ('human', 'Bootstrap Owner', 'bootstrap-owner@test.com', 'ank_testbootstrap1')
			RETURNING id
		`
		const ownerId = ownerRow.id as string
		const ws = await insertWorkspace(db, ownerId)
		if (!ws) throw new Error('workspace insert returned no row')

		const agentStorage = new AgentStorageManager(createMemoryStorage(), db)
		await bootstrapDefaultAgents(db, agentStorage, ws.id, ownerId)

		const chiefId = await resolveChiefActorId(db, ws.id)
		expect(chiefId).toBeTruthy()

		const seeded = DEFAULT_WORKSPACE_KNOWLEDGE[0]
		if (!seeded) throw new Error('DEFAULT_WORKSPACE_KNOWLEDGE is empty')

		const rows = await db
			.select()
			.from(objects)
			.where(
				and(
					eq(objects.workspaceId, ws.id),
					eq(objects.type, 'knowledge'),
					eq(objects.title, seeded.title),
				),
			)

		expect(rows).toHaveLength(1)
		const row = rows[0]
		expect(row.type).toBe('knowledge')
		expect(row.status).toBe('draft')
		expect(row.createdBy).toBe(chiefId)
		expect(row.title).toBe(seeded.title)
		expect((row.metadata as Record<string, unknown>).seed_slug).toBe(seeded.seedSlug)
		expect(row.content).toBe(seeded.body)
	})

	it('is idempotent by metadata.seed_slug: running bootstrap twice leaves exactly one checklist row', async () => {
		const [ownerRow] = await rawSql`
			INSERT INTO actors (type, name, email, api_key)
			VALUES ('human', 'Bootstrap Owner Two', 'bootstrap-owner-2@test.com', 'ank_testbootstrap2')
			RETURNING id
		`
		const ownerId = ownerRow.id as string
		const ws = await insertWorkspace(db, ownerId)
		if (!ws) throw new Error('workspace insert returned no row')

		const agentStorage = new AgentStorageManager(createMemoryStorage(), db)

		await bootstrapDefaultAgents(db, agentStorage, ws.id, ownerId)
		await bootstrapDefaultAgents(db, agentStorage, ws.id, ownerId)

		const rows = await db
			.select()
			.from(objects)
			.where(
				and(
					eq(objects.workspaceId, ws.id),
					eq(objects.type, 'knowledge'),
					sql`${objects.metadata}->>'seed_slug' = ${ONBOARDING_CHECKLIST_SEED_SLUG}`,
				),
			)

		expect(rows).toHaveLength(1)
	})

	it('backfill script stamps the seed slug on a pre-existing Vaerksted checklist and preserves original content', async () => {
		const [ownerRow] = await rawSql`
			INSERT INTO actors (type, name, email, api_key)
			VALUES ('human', 'Vaerksted Owner', 'vaerksted-owner@test.com', 'ank_testvaerksted1')
			RETURNING id
		`
		const ownerId = ownerRow.id as string

		// Seed a Vaerksted-shaped row at the exact ids the backfill targets. The
		// row predates DEFAULT_WORKSPACE_KNOWLEDGE, so metadata carries other keys
		// but no seed_slug — the state the backfill was written to repair.
		await rawSql`
			INSERT INTO workspaces (id, name, settings, created_by, billing_owner_id)
			VALUES (
				${VAERKSTED_WORKSPACE_ID},
				'Vaerksted',
				'{}'::jsonb,
				${ownerId},
				${ownerId}
			)
		`
		const originalContent = 'Sebastian-confirmed content that must not be lost.'
		await rawSql`
			INSERT INTO objects (id, workspace_id, type, title, content, status, metadata, created_by)
			VALUES (
				${VAERKSTED_CHECKLIST_OBJECT_ID},
				${VAERKSTED_WORKSPACE_ID},
				'knowledge',
				'Onboarding checklist — workspace background state & progress',
				${originalContent},
				'draft',
				${JSON.stringify({ doc_type: 'reference', last_validated_at: '2026-08-20' })}::jsonb,
				${ownerId}
			)
		`

		const first = await backfillOnboardingChecklist(db)
		expect(first).toEqual({ kind: 'stamped', previous: null })

		const [after] = await db
			.select()
			.from(objects)
			.where(eq(objects.id, VAERKSTED_CHECKLIST_OBJECT_ID))
			.limit(1)
		expect(after).toBeTruthy()
		expect(after.content).toBe(originalContent)
		expect(after.title).toBe('Onboarding checklist — workspace background state & progress')
		expect(after.status).toBe('draft')
		const meta = after.metadata as Record<string, unknown>
		expect(meta.seed_slug).toBe(ONBOARDING_CHECKLIST_SEED_SLUG)
		// Preserves the pre-existing metadata keys instead of overwriting them.
		expect(meta.doc_type).toBe('reference')
		expect(meta.last_validated_at).toBe('2026-08-20')

		// Re-running is a no-op — the slug is already present.
		const second = await backfillOnboardingChecklist(db)
		expect(second).toEqual({ kind: 'no-op-already-set' })
	})

	it('is idempotent by slug, not title: renaming the seeded row does not cause a duplicate on re-bootstrap', async () => {
		const [ownerRow] = await rawSql`
			INSERT INTO actors (type, name, email, api_key)
			VALUES ('human', 'Bootstrap Owner Three', 'bootstrap-owner-3@test.com', 'ank_testbootstrap3')
			RETURNING id
		`
		const ownerId = ownerRow.id as string
		const ws = await insertWorkspace(db, ownerId)
		if (!ws) throw new Error('workspace insert returned no row')

		const agentStorage = new AgentStorageManager(createMemoryStorage(), db)
		await bootstrapDefaultAgents(db, agentStorage, ws.id, ownerId)

		// Simulate a human renaming the checklist in the UI — the slug is what
		// keeps the row identifiable to the bootstrapper across re-runs.
		await db
			.update(objects)
			.set({ title: 'Renamed by user' })
			.where(
				and(
					eq(objects.workspaceId, ws.id),
					sql`${objects.metadata}->>'seed_slug' = ${ONBOARDING_CHECKLIST_SEED_SLUG}`,
				),
			)

		await bootstrapDefaultAgents(db, agentStorage, ws.id, ownerId)

		const rows = await db
			.select()
			.from(objects)
			.where(
				and(
					eq(objects.workspaceId, ws.id),
					eq(objects.type, 'knowledge'),
					sql`${objects.metadata}->>'seed_slug' = ${ONBOARDING_CHECKLIST_SEED_SLUG}`,
				),
			)

		expect(rows).toHaveLength(1)
		expect(rows[0].title).toBe('Renamed by user')
	})
})
