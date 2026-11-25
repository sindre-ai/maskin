import type { Database } from '@maskin/db'
import { actors, agentSkills, workspaceMembers, workspaceSkills } from '@maskin/db/schema'
import { INTEGRATION_CONNECT_CHECKLIST_SKILL } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	SEEDED_SKILL_BACKFILL_MARKER_PREFIX,
	runSeededSkillSyncOnBoot,
} from '../../lib/seeded-skill-boot'
import { SEEDED_SKILL_HASH_KEY, seededSkillHash } from '../../lib/seeded-skill-hash'
import { AgentStorageManager } from '../../services/agent-storage'
import { bootstrapDefaultAgents } from '../../services/workspace-bootstrap'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const SKILL = INTEGRATION_CONNECT_CHECKLIST_SKILL
const MARKER = `${SEEDED_SKILL_BACKFILL_MARKER_PREFIX}${SKILL.name}`
const OLD_SEED =
	'---\nname: integration-connect-checklist\ndescription: Older seeded text.\n---\n\nOld.'

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

async function markerRows() {
	return db.execute(sql`SELECT 1 FROM "_migrations" WHERE "name" = ${MARKER}`)
}

async function skillRows(workspaceId: string) {
	return db
		.select()
		.from(workspaceSkills)
		.where(and(eq(workspaceSkills.workspaceId, workspaceId), eq(workspaceSkills.name, SKILL.name)))
}

async function chiefSkillLinks(workspaceId: string) {
	return db
		.select({ actorId: agentSkills.actorId })
		.from(agentSkills)
		.innerJoin(workspaceSkills, eq(workspaceSkills.id, agentSkills.workspaceSkillId))
		.innerJoin(actors, eq(actors.id, agentSkills.actorId))
		.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(workspaceSkills.workspaceId, workspaceId),
				eq(workspaceSkills.name, SKILL.name),
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(actors.name, 'Chief of Staff'),
			),
		)
}

describe('Seeded skill sync', () => {
	let agentStorage: AgentStorageManager
	let workspaceId: string

	async function removeSkill() {
		await db
			.delete(workspaceSkills)
			.where(
				and(eq(workspaceSkills.workspaceId, workspaceId), eq(workspaceSkills.name, SKILL.name)),
			)
	}

	async function setCopy(content: string, metadata: Record<string, unknown> | null) {
		await db
			.update(workspaceSkills)
			.set({ content, metadata })
			.where(
				and(eq(workspaceSkills.workspaceId, workspaceId), eq(workspaceSkills.name, SKILL.name)),
			)
	}

	beforeEach(async () => {
		await db.execute(sql`DELETE FROM "_migrations" WHERE "name" = ${MARKER}`)
		agentStorage = new AgentStorageManager(createMemoryStorage(), db)
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		await bootstrapDefaultAgents(db, agentStorage, workspaceId, getTestActorId())
	})

	it('gives a freshly created workspace Chief of Staff the skill, stamped with its text', async () => {
		const rows = await skillRows(workspaceId)

		expect(rows).toHaveLength(1)
		expect(rows[0]?.content).toBe(SKILL.content)
		expect(rows[0]?.isValid).toBe(true)
		expect(rows[0]?.metadata).toEqual({ [SEEDED_SKILL_HASH_KEY]: seededSkillHash(SKILL.content) })
		expect(await chiefSkillLinks(workspaceId)).toHaveLength(1)
	})

	it('adds the skill to an existing workspace without it, once, and a second boot adds nothing', async () => {
		await removeSkill()

		const first = await runSeededSkillSyncOnBoot(db, agentStorage)
		expect(first.status).toBe('done')
		const rows = await skillRows(workspaceId)
		expect(rows).toHaveLength(1)
		expect(rows[0]?.content).toBe(SKILL.content)
		expect(await chiefSkillLinks(workspaceId)).toHaveLength(1)
		expect(await markerRows()).toHaveLength(1)
		const stored = await agentStorage.getWorkspaceSkill(workspaceId, rows[0]?.id as string)
		expect(stored).toBe(SKILL.content)

		const second = await runSeededSkillSyncOnBoot(db, agentStorage)
		expect(second.status).toBe('done')
		if (second.status !== 'done') throw new Error('unreachable')
		expect(second.results[0]?.backfill).toBe('already_done')
		expect(await skillRows(workspaceId)).toHaveLength(1)
	})

	it('does not bring the skill back after a workspace deleted it on purpose', async () => {
		await removeSkill()
		await runSeededSkillSyncOnBoot(db, agentStorage)
		await removeSkill()

		await runSeededSkillSyncOnBoot(db, agentStorage)

		expect(await skillRows(workspaceId)).toHaveLength(0)
	})

	it('updates a copy that still matches an earlier seeded text', async () => {
		await setCopy(OLD_SEED, { [SEEDED_SKILL_HASH_KEY]: seededSkillHash(OLD_SEED), other: 'kept' })

		await runSeededSkillSyncOnBoot(db, agentStorage)

		const [row] = await skillRows(workspaceId)
		expect(row?.content).toBe(SKILL.content)
		expect(row?.sizeBytes).toBe(Buffer.byteLength(SKILL.content, 'utf-8'))
		expect(row?.metadata).toEqual({
			[SEEDED_SKILL_HASH_KEY]: seededSkillHash(SKILL.content),
			other: 'kept',
		})
		const stored = await agentStorage.getWorkspaceSkill(workspaceId, row?.id as string)
		expect(stored).toBe(SKILL.content)
	})

	it('never overwrites a copy someone edited', async () => {
		const edited = `${OLD_SEED}\n\nOur own rule.`
		await setCopy(edited, { [SEEDED_SKILL_HASH_KEY]: seededSkillHash(OLD_SEED) })

		await runSeededSkillSyncOnBoot(db, agentStorage)
		await runSeededSkillSyncOnBoot(db, agentStorage)

		const [row] = await skillRows(workspaceId)
		expect(row?.content).toBe(edited)
		expect(row?.metadata).toEqual({ [SEEDED_SKILL_HASH_KEY]: seededSkillHash(OLD_SEED) })
	})

	it('leaves a hand-made copy with other text alone, and only stamps one that holds the current text', async () => {
		await setCopy(
			'---\nname: integration-connect-checklist\ndescription: Hand made.\n---\n\nMine.',
			null,
		)
		await runSeededSkillSyncOnBoot(db, agentStorage)
		const [handMade] = await skillRows(workspaceId)
		expect(handMade?.content).toContain('Mine.')
		expect(handMade?.metadata).toBeNull()

		await setCopy(SKILL.content, null)
		await runSeededSkillSyncOnBoot(db, agentStorage)
		const [same] = await skillRows(workspaceId)
		expect(same?.content).toBe(SKILL.content)
		expect(same?.metadata).toEqual({ [SEEDED_SKILL_HASH_KEY]: seededSkillHash(SKILL.content) })
	})

	it('leaves no marker when a workspace fails, so the next boot retries', async () => {
		await removeSkill()
		const realPut = agentStorage.putWorkspaceSkill.bind(agentStorage)
		let down = true
		agentStorage.putWorkspaceSkill = async (wsId, ...rest) => {
			if (down && wsId === workspaceId) throw new Error('storage down')
			return realPut(wsId, ...rest)
		}

		const first = await runSeededSkillSyncOnBoot(db, agentStorage)
		expect(first.status).toBe('incomplete')
		expect(await markerRows()).toHaveLength(0)

		down = false
		const retry = await runSeededSkillSyncOnBoot(db, agentStorage)
		expect(retry.status).toBe('done')
		expect(await skillRows(workspaceId)).toHaveLength(1)
	})

	it('does not throw when the database itself is unreachable', async () => {
		const brokenDb = {
			transaction: async () => {
				throw new Error('connection refused')
			},
		} as unknown as Database

		const outcome = await runSeededSkillSyncOnBoot(brokenDb, agentStorage)

		expect(outcome).toEqual({ status: 'failed' })
	})
})
