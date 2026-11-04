import type { Database } from '@maskin/db'
import { workspaceSkills } from '@maskin/db/schema'
import { DRAFT_APPROVAL_TASKS_SKILL } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	DRAFT_APPROVAL_SKILL_BACKFILL_ENV,
	DRAFT_APPROVAL_SKILL_BACKFILL_MARKER,
	runDraftApprovalSkillBackfillOnBoot,
} from '../../lib/draft-approval-skill-boot'
import { AgentStorageManager } from '../../services/agent-storage'
import { bootstrapDefaultAgents } from '../../services/workspace-bootstrap'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const ON = { [DRAFT_APPROVAL_SKILL_BACKFILL_ENV]: '1' } as NodeJS.ProcessEnv
const DRY = { [DRAFT_APPROVAL_SKILL_BACKFILL_ENV]: 'dry' } as NodeJS.ProcessEnv

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
	return db.execute(
		sql`SELECT 1 FROM "_migrations" WHERE "name" = ${DRAFT_APPROVAL_SKILL_BACKFILL_MARKER}`,
	)
}

async function skillRows(workspaceId: string) {
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

describe('Draft approval skill boot backfill', () => {
	let agentStorage: AgentStorageManager
	let workspaceId: string

	beforeEach(async () => {
		await db.execute(
			sql`DELETE FROM "_migrations" WHERE "name" = ${DRAFT_APPROVAL_SKILL_BACKFILL_MARKER}`,
		)
		agentStorage = new AgentStorageManager(createMemoryStorage(), db)
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		await bootstrapDefaultAgents(db, agentStorage, workspaceId, getTestActorId())
		// An old workspace: default agents, no draft-approval-tasks skill.
		await db
			.delete(workspaceSkills)
			.where(
				and(
					eq(workspaceSkills.workspaceId, workspaceId),
					eq(workspaceSkills.name, DRAFT_APPROVAL_TASKS_SKILL.name),
				),
			)
	})

	it('does nothing when the env var is off', async () => {
		const offValues = [{}, { [DRAFT_APPROVAL_SKILL_BACKFILL_ENV]: '0' }] as NodeJS.ProcessEnv[]
		for (const env of offValues) {
			const outcome = await runDraftApprovalSkillBackfillOnBoot(db, agentStorage, env)
			expect(outcome).toEqual({ status: 'disabled' })
		}
		expect(await skillRows(workspaceId)).toHaveLength(0)
		expect(await markerRows()).toHaveLength(0)
	})

	it('writes nothing and no marker in a dry run, so the real run still happens after it', async () => {
		const dry = await runDraftApprovalSkillBackfillOnBoot(db, agentStorage, DRY)

		expect(dry.status).toBe('dry_run')
		expect(await skillRows(workspaceId)).toHaveLength(0)
		expect(await markerRows()).toHaveLength(0)

		const real = await runDraftApprovalSkillBackfillOnBoot(db, agentStorage, ON)
		expect(real.status).toBe('done')
		expect(await skillRows(workspaceId)).toHaveLength(1)
	})

	it('runs once, writes the marker, and a second boot changes nothing', async () => {
		const first = await runDraftApprovalSkillBackfillOnBoot(db, agentStorage, ON)

		expect(first.status).toBe('done')
		if (first.status !== 'done') throw new Error('unreachable')
		expect(first.result.failed).toBe(0)
		expect(first.result.seededWorkspaceIds).toContain(workspaceId)
		expect(await markerRows()).toHaveLength(1)

		// Deleted on purpose after the backfill: a later boot must not bring it back.
		await db
			.delete(workspaceSkills)
			.where(
				and(
					eq(workspaceSkills.workspaceId, workspaceId),
					eq(workspaceSkills.name, DRAFT_APPROVAL_TASKS_SKILL.name),
				),
			)
		const second = await runDraftApprovalSkillBackfillOnBoot(db, agentStorage, ON)
		expect(second).toEqual({ status: 'already_done' })
		expect(await skillRows(workspaceId)).toHaveLength(0)
	})

	it('leaves no marker when a workspace fails, so the next boot retries', async () => {
		const realPut = agentStorage.putWorkspaceSkill.bind(agentStorage)
		let down = true
		agentStorage.putWorkspaceSkill = async (wsId, ...rest) => {
			if (down && wsId === workspaceId) throw new Error('storage down')
			return realPut(wsId, ...rest)
		}

		const first = await runDraftApprovalSkillBackfillOnBoot(db, agentStorage, ON)
		expect(first.status).toBe('incomplete')
		expect(await markerRows()).toHaveLength(0)

		down = false
		const retry = await runDraftApprovalSkillBackfillOnBoot(db, agentStorage, ON)
		expect(retry.status).toBe('done')
		expect(await skillRows(workspaceId)).toHaveLength(1)
	})

	it('does not throw when the database itself is unreachable', async () => {
		const brokenDb = {
			transaction: async () => {
				throw new Error('connection refused')
			},
		} as unknown as Database

		const outcome = await runDraftApprovalSkillBackfillOnBoot(brokenDb, agentStorage, ON)

		expect(outcome).toEqual({ status: 'failed' })
	})
})
