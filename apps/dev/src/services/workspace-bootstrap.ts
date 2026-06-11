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

const OBSERVER = DEVELOPMENT_AGENTS.find((a) => a.$id === 'workspace_observer')
const ONBOARDING_TRIGGER = DEVELOPMENT_TRIGGERS.find((t) => t.name === 'New Workspace Onboarding')

export async function bootstrapWorkspaceObserver(
	db: Database,
	agentStorage: AgentStorageManager,
	workspaceId: string,
	createdBy: string,
): Promise<void> {
	if (!OBSERVER || !ONBOARDING_TRIGGER) return

	// Idempotent: bail out if the Workspace Observer is already a member.
	const [existing] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.name, OBSERVER.name)))
		.limit(1)

	if (existing) return

	// Create the Workspace Observer actor.
	const [observer] = await db
		.insert(actors)
		.values({
			type: 'agent',
			name: OBSERVER.name,
			systemPrompt: OBSERVER.systemPrompt,
			tools: (OBSERVER.tools ?? null) as Record<string, unknown> | null,
			apiKey: generateApiKey().key,
			createdBy,
		})
		.returning()

	if (!observer) throw new Error('Failed to create Workspace Observer actor')

	await db.insert(workspaceMembers).values({ workspaceId, actorId: observer.id, role: 'member' })

	// Create and attach each seed skill (DB row + S3 upload in one transaction).
	for (const skill of OBSERVER.skills ?? []) {
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
					.values({ actorId: observer.id, workspaceSkillId: createdSkill.id })
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

	// Create the onboarding trigger pointing at the new observer.
	await db.insert(triggers).values({
		workspaceId,
		name: ONBOARDING_TRIGGER.name,
		type: ONBOARDING_TRIGGER.type,
		config: ONBOARDING_TRIGGER.config as Record<string, unknown>,
		actionPrompt: ONBOARDING_TRIGGER.actionPrompt,
		targetActorId: observer.id,
		enabled: ONBOARDING_TRIGGER.enabled,
		createdBy,
	})
}
