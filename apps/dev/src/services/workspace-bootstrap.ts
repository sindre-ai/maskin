import { randomUUID } from 'node:crypto'
import { generateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { actors, agentSkills, triggers, workspaceMembers, workspaceSkills } from '@maskin/db/schema'
import {
	CHIEF_OF_STAFF_DEFAULT,
	DEVELOPMENT_AGENTS,
	DEVELOPMENT_TRIGGERS,
	WORKSPACE_COACH_DEFAULT,
	parseSkillMd,
	skillNameSchema,
} from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { logger } from '../lib/logger'
import { type AgentStorageManager, workspaceSkillKey } from './agent-storage'

export const DEFAULT_AGENT_IDS = [
	'workspace_coach',
	'chief_of_staff',
	'workspace_driver',
	'strategist',
	'insights_triage',
	'research_agent',
] as const

type DefaultAgentId = (typeof DEFAULT_AGENT_IDS)[number]

const defaultAgents = DEVELOPMENT_AGENTS.filter((a) =>
	DEFAULT_AGENT_IDS.includes(a.$id as DefaultAgentId),
)

// A caller can pass either the top-level Database or a Drizzle tx handle —
// both expose the query-builder surface this file uses.
type Tx = Pick<Database, 'select' | 'insert' | 'update'>

/**
 * Thrown when a per-agent actor/member insert fails inside the workspace
 * transaction. The route inspects `agentId` and the wrapped `cause` to shape a
 * 5xx that names what actually broke, rather than a generic 500.
 */
export class SeedAgentError extends Error {
	readonly agentId: string
	readonly cause: unknown

	constructor(agentId: string, cause: unknown) {
		const causeMsg = cause instanceof Error ? cause.message : String(cause)
		super(`Failed to seed default agent "${agentId}": ${causeMsg}`)
		this.name = 'SeedAgentError'
		this.agentId = agentId
		this.cause = cause
	}

	get errorClass(): string {
		if (this.cause instanceof Error) return this.cause.name
		return typeof this.cause
	}
}

type ActorSpec = {
	type: string
	name: string
	isSystem: boolean
	systemPrompt: string
	llmProvider: string | null
	llmConfig: Record<string, unknown> | null
	tools: Record<string, unknown> | null
}

function resolveActorSpec(agentId: DefaultAgentId): ActorSpec {
	if (agentId === 'workspace_coach') {
		return {
			type: WORKSPACE_COACH_DEFAULT.type,
			name: WORKSPACE_COACH_DEFAULT.name,
			isSystem: WORKSPACE_COACH_DEFAULT.isSystem,
			systemPrompt: WORKSPACE_COACH_DEFAULT.systemPrompt,
			llmProvider: WORKSPACE_COACH_DEFAULT.llmProvider,
			llmConfig: WORKSPACE_COACH_DEFAULT.llmConfig as Record<string, unknown>,
			tools: WORKSPACE_COACH_DEFAULT.tools as Record<string, unknown>,
		}
	}
	if (agentId === 'chief_of_staff') {
		return {
			type: CHIEF_OF_STAFF_DEFAULT.type,
			name: CHIEF_OF_STAFF_DEFAULT.name,
			isSystem: CHIEF_OF_STAFF_DEFAULT.isSystem,
			systemPrompt: CHIEF_OF_STAFF_DEFAULT.systemPrompt,
			llmProvider: CHIEF_OF_STAFF_DEFAULT.llmProvider,
			llmConfig: CHIEF_OF_STAFF_DEFAULT.llmConfig as Record<string, unknown>,
			tools: CHIEF_OF_STAFF_DEFAULT.tools as Record<string, unknown>,
		}
	}
	const agent = DEVELOPMENT_AGENTS.find((a) => a.$id === agentId)
	if (!agent) throw new Error(`agent "${agentId}" missing from DEVELOPMENT_AGENTS`)
	return {
		type: 'agent',
		name: agent.name,
		isSystem: false,
		systemPrompt: agent.systemPrompt,
		llmProvider: null,
		llmConfig: (agent.llmConfig ?? null) as Record<string, unknown> | null,
		tools: (agent.tools ?? null) as Record<string, unknown> | null,
	}
}

/**
 * Seed the five default agent actor rows + workspace_members inside the
 * caller's transaction. Skills, workspace_skill files, and triggers are NOT
 * seeded here — those hit S3 and must live post-commit (see
 * bootstrapDefaultAgents).
 *
 * Idempotent per workspace: an agent whose `name` already has a
 * workspace_members row is skipped. On any per-agent failure throws
 * SeedAgentError so the caller's tx rolls back cleanly.
 */
export async function seedDefaultAgentActors(
	tx: Tx,
	workspaceId: string,
	createdBy: string,
): Promise<void> {
	for (const agentId of DEFAULT_AGENT_IDS) {
		try {
			const spec = resolveActorSpec(agentId)

			const [existing] = await tx
				.select({ actorId: workspaceMembers.actorId })
				.from(workspaceMembers)
				.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
				.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.name, spec.name)))
				.limit(1)

			if (existing) continue

			const [created] = await tx
				.insert(actors)
				.values({
					type: spec.type,
					name: spec.name,
					isSystem: spec.isSystem,
					systemPrompt: spec.systemPrompt.replaceAll('{{self_id}}', ''),
					llmProvider: spec.llmProvider,
					llmConfig: spec.llmConfig,
					tools: spec.tools,
					apiKey: generateApiKey().key,
					createdBy,
				})
				.returning()

			if (!created) throw new Error('insert into actors returned no row')

			if (spec.systemPrompt.includes('{{self_id}}')) {
				await tx
					.update(actors)
					.set({ systemPrompt: spec.systemPrompt.replaceAll('{{self_id}}', created.id) })
					.where(eq(actors.id, created.id))
			}

			await tx.insert(workspaceMembers).values({
				workspaceId,
				actorId: created.id,
				role: 'member',
			})
		} catch (err) {
			if (err instanceof SeedAgentError) throw err
			throw new SeedAgentError(agentId, err)
		}
	}
}

export async function bootstrapDefaultAgents(
	db: Database,
	agentStorage: AgentStorageManager,
	workspaceId: string,
	createdBy: string,
): Promise<void> {
	// Map from $id → created actor UUID — used to wire triggers after all agents are seeded.
	const actorIdMap: Record<string, string> = {}

	// Seed system agents that live outside DEVELOPMENT_AGENTS (Chief of Staff).
	// Workspace Coach is seeded synchronously by the workspace-create paths, so
	// its name-check would only ever hit "existing" here — Chief of Staff is the
	// one that actually needs post-commit seeding via this function. Idempotent
	// per workspace via the actors.name check.
	const chiefSpec = resolveActorSpec('chief_of_staff')
	const [existingChief] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.name, chiefSpec.name)))
		.limit(1)

	if (!existingChief) {
		const [createdChief] = await db
			.insert(actors)
			.values({
				type: chiefSpec.type,
				name: chiefSpec.name,
				isSystem: chiefSpec.isSystem,
				systemPrompt: chiefSpec.systemPrompt.replaceAll('{{self_id}}', ''),
				llmProvider: chiefSpec.llmProvider,
				llmConfig: chiefSpec.llmConfig,
				tools: chiefSpec.tools,
				apiKey: generateApiKey().key,
				createdBy,
			})
			.returning()

		if (createdChief) {
			await db.insert(workspaceMembers).values({
				workspaceId,
				actorId: createdChief.id,
				role: 'member',
			})
		} else {
			logger.error('Failed to create Chief of Staff during workspace bootstrap', {
				workspaceId,
			})
		}
	}

	for (const agent of defaultAgents) {
		// Idempotent: check if an actor with this name already exists in the workspace.
		const [existing] = await db
			.select({ actorId: workspaceMembers.actorId })
			.from(workspaceMembers)
			.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
			.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.name, agent.name)))
			.limit(1)

		let actorId: string

		if (existing) {
			actorId = existing.actorId
			actorIdMap[agent.$id] = actorId
		} else {
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

			actorId = created.id
			actorIdMap[agent.$id] = actorId

			// Patch own ID into the system prompt now that we have it.
			if (agent.systemPrompt.includes('{{self_id}}')) {
				await db
					.update(actors)
					.set({ systemPrompt: agent.systemPrompt.replaceAll('{{self_id}}', created.id) })
					.where(eq(actors.id, created.id))
			}

			await db.insert(workspaceMembers).values({ workspaceId, actorId, role: 'member' })
		}

		// Seed skills for this agent. Runs for both newly-created and pre-existing actors so
		// that Workspace Coach's skills (seeded synchronously in the workspace transaction)
		// are still attached here. Both inserts use onConflictDoNothing so this is idempotent.
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
						.values({ actorId, workspaceSkillId: createdSkill.id })
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

		// Idempotent: skip if a trigger with this name already exists in the workspace.
		const [existingTrigger] = await db
			.select({ id: triggers.id })
			.from(triggers)
			.where(and(eq(triggers.workspaceId, workspaceId), eq(triggers.name, trigger.name)))
			.limit(1)

		if (existingTrigger) continue

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
