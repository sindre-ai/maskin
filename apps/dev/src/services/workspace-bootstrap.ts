import { randomUUID } from 'node:crypto'
import { generateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { actors, agentSkills, triggers, workspaceMembers, workspaceSkills } from '@maskin/db/schema'
import {
	DEVELOPMENT_AGENTS,
	DEVELOPMENT_TRIGGERS,
	parseSkillMd,
	skillNameSchema,
} from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { type AgentStorageManager, workspaceSkillKey } from './agent-storage'

const DEFAULT_AGENT_IDS = ['workspace_coach', 'workspace_driver', 'strategist']

const defaultAgents = DEVELOPMENT_AGENTS.filter((a) => DEFAULT_AGENT_IDS.includes(a.$id))

export async function bootstrapDefaultAgents(
	db: Database,
	agentStorage: AgentStorageManager,
	workspaceId: string,
	createdBy: string,
): Promise<void> {
	// Map from $id → created actor UUID — used to wire triggers after all agents are seeded.
	const actorIdMap: Record<string, string> = {}

	for (const agent of defaultAgents) {
		// Idempotent: skip if an actor with this name already exists in the workspace.
		const [existing] = await db
			.select({ actorId: workspaceMembers.actorId })
			.from(workspaceMembers)
			.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
			.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.name, agent.name)))
			.limit(1)

		if (existing) {
			actorIdMap[agent.$id] = existing.actorId
			continue
		}

		const systemPrompt = agent.systemPrompt.replaceAll('{{self_id}}', '')

		const [created] = await db
			.insert(actors)
			.values({
				type: 'agent',
				name: agent.name,
				systemPrompt,
				tools: (agent.tools ?? null) as Record<string, unknown> | null,
				llmConfig: (agent.llmConfig ?? null) as Record<string, unknown> | null,
				apiKey: generateApiKey().key,
				createdBy,
			})
			.returning()

		if (!created) {
			logger.error('Failed to create agent during workspace bootstrap', {
				workspaceId,
				agentName: agent.name,
			})
			continue
		}

		actorIdMap[agent.$id] = created.id

		// Patch own ID into the system prompt now that we have it.
		if (agent.systemPrompt.includes('{{self_id}}')) {
			await db
				.update(actors)
				.set({ systemPrompt: agent.systemPrompt.replaceAll('{{self_id}}', created.id) })
				.where(eq(actors.id, created.id))
		}

		await db.insert(workspaceMembers).values({ workspaceId, actorId: created.id, role: 'member' })

		// Create and attach each seed skill (DB row + S3 upload in one transaction).
		for (const skill of agent.skills ?? []) {
			try {
				let parsed: ReturnType<typeof parseSkillMd> | null = null
				try {
					parsed = parseSkillMd(skill.content)
				} catch {
					parsed = null
				}
				const description = parsed?.description ?? null
				const isValid = parsed !== null && skillNameSchema.safeParse(parsed.name).success

				const skillId = randomUUID()
				const storageKey = workspaceSkillKey(workspaceId, skillId)
				const sizeBytes = Buffer.byteLength(skill.content, 'utf-8')

				const createdSkill = await db.transaction(async (tx) => {
					const [row] = await tx
						.insert(workspaceSkills)
						.values({
							id: skillId,
							workspaceId,
							name: skill.name,
							description,
							content: skill.content,
							storageKey,
							sizeBytes,
							isValid,
							createdBy,
						})
						.onConflictDoNothing()
						.returning()

					if (!row) return null
					await agentStorage.putWorkspaceSkill(workspaceId, skillId, skill.content)
					return row
				})

				if (createdSkill) {
					await db
						.insert(agentSkills)
						.values({ actorId: created.id, workspaceSkillId: createdSkill.id })
						.onConflictDoNothing()
				}
			} catch (err) {
				logger.error('Failed to create/attach skill during workspace bootstrap', {
					workspaceId,
					skill: skill.name,
					err,
				})
			}
		}
	}

	// Create triggers for all seeded agents.
	for (const trigger of DEVELOPMENT_TRIGGERS) {
		const targetActorId = actorIdMap[trigger.targetActor$id]
		if (!targetActorId) continue

		try {
			await db.insert(triggers).values({
				workspaceId,
				name: trigger.name,
				type: trigger.type,
				config: trigger.config as Record<string, unknown>,
				actionPrompt: trigger.actionPrompt,
				targetActorId,
				enabled: trigger.enabled,
				createdBy,
			})
		} catch (err) {
			logger.error('Failed to create trigger during workspace bootstrap', {
				workspaceId,
				triggerName: trigger.name,
				err,
			})
		}
	}
}
