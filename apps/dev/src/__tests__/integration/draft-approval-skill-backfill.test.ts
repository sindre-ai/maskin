import { agentSkills, workspaceSkills } from '@maskin/db/schema'
import { DRAFT_APPROVAL_TASKS_SKILL } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentStorageManager } from '../../services/agent-storage'
import { backfillDraftApprovalSkill } from '../../services/draft-approval-skill-backfill'
import { bootstrapDefaultAgents } from '../../services/workspace-bootstrap'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

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

async function draftSkillRows(workspaceId: string) {
	return db
		.select()
		.from(workspaceSkills)
		.where(
			and(
				eq(workspaceSkills.workspaceId, workspaceId),
				eq(workspaceSkills.name, DRAFT_APPROVAL_TASKS_SKILL.name),
			),
		)
}

async function removeSkill(workspaceId: string) {
	await db
		.delete(workspaceSkills)
		.where(
			and(
				eq(workspaceSkills.workspaceId, workspaceId),
				eq(workspaceSkills.name, DRAFT_APPROVAL_TASKS_SKILL.name),
			),
		)
}

describe('draft-approval-tasks skill', () => {
	let agentStorage: AgentStorageManager
	let workspaceId: string

	beforeEach(async () => {
		agentStorage = new AgentStorageManager(createMemoryStorage(), db)
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		await bootstrapDefaultAgents(db, agentStorage, workspaceId, getTestActorId())
	})

	it('is seeded into a fresh workspace and attached to the default agents', async () => {
		const [skill] = await draftSkillRows(workspaceId)
		expect(skill?.isValid).toBe(true)

		const attached = await db
			.select()
			.from(agentSkills)
			.where(eq(agentSkills.workspaceSkillId, skill?.id as string))
		expect(attached).toHaveLength(7)
	})

	it('is backfilled into a workspace that predates it', async () => {
		// Simulate an old workspace: default agents, but no draft-approval-tasks skill.
		await db
			.delete(workspaceSkills)
			.where(
				and(
					eq(workspaceSkills.workspaceId, workspaceId),
					eq(workspaceSkills.name, DRAFT_APPROVAL_TASKS_SKILL.name),
				),
			)
		expect(await draftSkillRows(workspaceId)).toHaveLength(0)

		const result = await backfillDraftApprovalSkill(db, agentStorage)
		expect(result.failed).toBe(0)
		expect(result.seeded).toBeGreaterThanOrEqual(1)

		const [skill] = await draftSkillRows(workspaceId)
		expect(skill?.content).toBe(DRAFT_APPROVAL_TASKS_SKILL.content)
		const attached = await db
			.select()
			.from(agentSkills)
			.where(eq(agentSkills.workspaceSkillId, skill?.id as string))
		expect(attached).toHaveLength(7)

		// A second run changes nothing.
		const again = await backfillDraftApprovalSkill(db, agentStorage)
		expect(again.seeded).toBe(0)
		expect(await draftSkillRows(workspaceId)).toHaveLength(1)
	})

	it("never overwrites a workspace's own edited copy", async () => {
		await db
			.update(workspaceSkills)
			.set({ content: 'my own version' })
			.where(
				and(
					eq(workspaceSkills.workspaceId, workspaceId),
					eq(workspaceSkills.name, DRAFT_APPROVAL_TASKS_SKILL.name),
				),
			)

		await backfillDraftApprovalSkill(db, agentStorage)

		const [skill] = await draftSkillRows(workspaceId)
		expect(skill?.content).toBe('my own version')
	})

	it('counts a workspace that already has the skill as skipped', async () => {
		const result = await backfillDraftApprovalSkill(db, agentStorage)

		expect(result.skipped).toBeGreaterThanOrEqual(1)
		expect(result.seededWorkspaceIds).not.toContain(workspaceId)
		expect(await draftSkillRows(workspaceId)).toHaveLength(1)
	})

	it('writes nothing in a dry run, and says which workspaces it would add to', async () => {
		await removeSkill(workspaceId)

		const result = await backfillDraftApprovalSkill(db, agentStorage, { dryRun: true })

		expect(result.seededWorkspaceIds).toContain(workspaceId)
		expect(result.seeded).toBe(result.seededWorkspaceIds.length)
		expect(await draftSkillRows(workspaceId)).toHaveLength(0)
	})

	it('logs a failing workspace and still seeds the others', async () => {
		const other = await insertWorkspace(db, getTestActorId())
		await bootstrapDefaultAgents(db, agentStorage, other.id, getTestActorId())
		await removeSkill(workspaceId)
		await removeSkill(other.id)

		const realPut = agentStorage.putWorkspaceSkill.bind(agentStorage)
		vi.spyOn(agentStorage, 'putWorkspaceSkill').mockImplementation(async (wsId, ...rest) => {
			if (wsId === workspaceId) throw new Error('storage down')
			return realPut(wsId, ...rest)
		})

		const result = await backfillDraftApprovalSkill(db, agentStorage)

		expect(result.failed).toBe(1)
		expect(result.seededWorkspaceIds).toContain(other.id)
		expect(result.seededWorkspaceIds).not.toContain(workspaceId)
		expect(await draftSkillRows(other.id)).toHaveLength(1)
		expect(await draftSkillRows(workspaceId)).toHaveLength(0)
	})
})
