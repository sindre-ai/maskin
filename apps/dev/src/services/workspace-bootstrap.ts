import { randomUUID } from 'node:crypto'
import { generateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	agentSkills,
	objects,
	triggers,
	workspaceMembers,
	workspaceSkills,
	workspaces,
} from '@maskin/db/schema'
import { applyModuleDefaults } from '@maskin/module-sdk'
import {
	CHIEF_OF_STAFF_DEFAULT,
	DEFAULT_WORKSPACE_AGENTS,
	DEFAULT_WORKSPACE_LOOPS,
	DEFAULT_WORKSPACE_TRIGGERS,
	type SeedSkill,
	WORKSPACE_COACH_DEFAULT,
	parseSkillMd,
	skillNameSchema,
	workspaceSettingsSchema,
} from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { isEnterpriseActor } from '../lib/enterprise'
import { logger } from '../lib/logger'
import { buildChiefOfStaffKickoffPrompt } from '../lib/onboarding/chief-of-staff-kickoff'
import {
	OwnershipCapExceededError,
	computeEffectiveTier,
	lockActorForOwnershipClaim,
	ownedWorkspacePlans,
	ownershipCapForTier,
	resolvePlanTier,
} from '../lib/workspace-capacity'
import { type AgentStorageManager, workspaceSkillKey } from './agent-storage'
import type { SessionManager } from './session-manager'

export const DEFAULT_AGENT_IDS = [
	'workspace_coach',
	'chief_of_staff',
	'driver',
	'strategist',
	'signal_analyst',
	'researcher',
	'knowledge_curator',
] as const

type DefaultAgentId = (typeof DEFAULT_AGENT_IDS)[number]

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
	description: string | null
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
			description: WORKSPACE_COACH_DEFAULT.description ?? null,
			isSystem: WORKSPACE_COACH_DEFAULT.isSystem,
			systemPrompt: WORKSPACE_COACH_DEFAULT.systemPrompt,
			llmProvider: WORKSPACE_COACH_DEFAULT.llmProvider,
			llmConfig: WORKSPACE_COACH_DEFAULT.llmConfig as Record<string, unknown> | null,
			tools: WORKSPACE_COACH_DEFAULT.tools as Record<string, unknown>,
		}
	}
	if (agentId === 'chief_of_staff') {
		return {
			type: CHIEF_OF_STAFF_DEFAULT.type,
			name: CHIEF_OF_STAFF_DEFAULT.name,
			description: CHIEF_OF_STAFF_DEFAULT.description ?? null,
			isSystem: CHIEF_OF_STAFF_DEFAULT.isSystem,
			systemPrompt: CHIEF_OF_STAFF_DEFAULT.systemPrompt,
			llmProvider: CHIEF_OF_STAFF_DEFAULT.llmProvider,
			llmConfig: CHIEF_OF_STAFF_DEFAULT.llmConfig as Record<string, unknown> | null,
			tools: CHIEF_OF_STAFF_DEFAULT.tools as Record<string, unknown>,
		}
	}
	const agent = DEFAULT_WORKSPACE_AGENTS.find((a) => a.$id === agentId)
	if (!agent) throw new Error(`agent "${agentId}" missing from DEFAULT_WORKSPACE_AGENTS`)
	return {
		type: 'agent',
		name: agent.name,
		description: agent.description ?? null,
		isSystem: false,
		systemPrompt: agent.systemPrompt,
		llmProvider: null,
		llmConfig: (agent.llmConfig ?? null) as Record<string, unknown> | null,
		tools: (agent.tools ?? null) as Record<string, unknown> | null,
	}
}

/**
 * Seed the default agent actor rows + workspace_members inside the
 * caller's transaction. Skills, workspace_skill files, and triggers are NOT
 * seeded here — those hit S3 and must live post-commit (see
 * bootstrapDefaultAgents).
 *
 * Idempotent per workspace: an agent whose `name` already has a
 * workspace_members row is skipped. On any per-agent failure throws
 * SeedAgentError so the caller's tx rolls back cleanly.
 *
 * Returns a map of agent id → actor id (whether newly created or
 * pre-existing) so callers can pin one of them as the workspace's default
 * chat agent without an extra lookup query.
 */
export async function seedDefaultAgentActors(
	tx: Tx,
	workspaceId: string,
	createdBy: string,
): Promise<Record<DefaultAgentId, string>> {
	const actorIds = {} as Record<DefaultAgentId, string>

	for (const agentId of DEFAULT_AGENT_IDS) {
		try {
			const spec = resolveActorSpec(agentId)

			const [existing] = await tx
				.select({ actorId: workspaceMembers.actorId })
				.from(workspaceMembers)
				.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
				.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.name, spec.name)))
				.limit(1)

			if (existing) {
				actorIds[agentId] = existing.actorId
				continue
			}

			const [created] = await tx
				.insert(actors)
				.values({
					type: spec.type,
					name: spec.name,
					description: spec.description,
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

			actorIds[agentId] = created.id
		} catch (err) {
			if (err instanceof SeedAgentError) throw err
			throw new SeedAgentError(agentId, err)
		}
	}

	return actorIds
}

/**
 * Idempotently ensures a Chief of Staff actor exists in the workspace,
 * creating it if missing. Returns its actor id either way, plus whether this
 * call was the one that created it (used to gate the one-time welcome
 * session kickoff in bootstrapDefaultAgents — must only fire once per
 * workspace, not on every idempotent re-run).
 */
export async function ensureChiefOfStaffActor(
	db: Tx,
	workspaceId: string,
	createdBy: string,
): Promise<{ actorId: string; isNew: boolean }> {
	const chiefSpec = resolveActorSpec('chief_of_staff')
	const [existing] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(actors.name, chiefSpec.name)))
		.limit(1)

	if (existing) return { actorId: existing.actorId, isNew: false }

	const [created] = await db
		.insert(actors)
		.values({
			type: chiefSpec.type,
			name: chiefSpec.name,
			description: chiefSpec.description,
			isSystem: chiefSpec.isSystem,
			systemPrompt: chiefSpec.systemPrompt.replaceAll('{{self_id}}', ''),
			llmProvider: chiefSpec.llmProvider,
			llmConfig: chiefSpec.llmConfig,
			tools: chiefSpec.tools,
			apiKey: generateApiKey().key,
			createdBy,
		})
		.returning()

	if (!created) throw new Error('Failed to create Chief of Staff actor')

	await db.insert(workspaceMembers).values({
		workspaceId,
		actorId: created.id,
		role: 'member',
	})

	return { actorId: created.id, isNew: true }
}

/**
 * Pins `agentActorId` as the workspace's default chat agent, but only if
 * `settings.default_agent_id` isn't already set — never clobbers an
 * explicit choice (owner pick, or a prior run of this same function).
 * Returns whether it made a change.
 */
export async function pinDefaultAgentIfUnset(
	db: Tx,
	workspaceId: string,
	agentActorId: string,
): Promise<boolean> {
	const [ws] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)

	const currentSettings = (ws?.settings ?? {}) as Record<string, unknown>
	if (currentSettings.default_agent_id != null) return false

	await db
		.update(workspaces)
		.set({ settings: { ...currentSettings, default_agent_id: agentActorId } })
		.where(eq(workspaces.id, workspaceId))

	return true
}

/**
 * Creates the workspace_skill row (+ S3 object) for `skill` if it doesn't
 * already exist in this workspace, and attaches it to `actorId`. Both
 * inserts use onConflictDoNothing so this is safe to call repeatedly for the
 * same actor/skill pair (e.g. Chief of Staff re-resolved via
 * ensureChiefOfStaffActor on every bootstrap run).
 */
async function attachSkill(
	db: Database,
	agentStorage: AgentStorageManager,
	workspaceId: string,
	createdBy: string,
	actorId: string,
	skill: SeedSkill,
): Promise<void> {
	try {
		let parsed: ReturnType<typeof parseSkillMd> | null = null
		try {
			parsed = parseSkillMd(skill.content)
		} catch {
			parsed = null
		}
		const description = parsed?.description ?? null
		const isValid = parsed !== null && skillNameSchema.safeParse(parsed.name).success

		const [existingSkill] = await db
			.select({ id: workspaceSkills.id })
			.from(workspaceSkills)
			.where(
				and(eq(workspaceSkills.workspaceId, workspaceId), eq(workspaceSkills.name, skill.name)),
			)
			.limit(1)

		let skillId = existingSkill?.id
		if (!skillId) {
			const newSkillId = randomUUID()
			const storageKey = workspaceSkillKey(workspaceId, newSkillId)
			const sizeBytes = Buffer.byteLength(skill.content, 'utf-8')

			const createdSkill = await db.transaction(async (tx) => {
				const [row] = await tx
					.insert(workspaceSkills)
					.values({
						id: newSkillId,
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
				await agentStorage.putWorkspaceSkill(workspaceId, newSkillId, skill.content)
				return row
			})

			skillId = createdSkill?.id ?? existingSkill?.id
		}

		if (skillId) {
			await db
				.insert(agentSkills)
				.values({ actorId, workspaceSkillId: skillId })
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

export async function bootstrapDefaultAgents(
	db: Database,
	agentStorage: AgentStorageManager,
	workspaceId: string,
	createdBy: string,
	sessionManager?: SessionManager,
): Promise<void> {
	// Map from $id → created actor UUID — used to wire triggers after all agents are seeded.
	const actorIdMap: Record<string, string> = {}

	// Seed system agents that live outside DEFAULT_WORKSPACE_AGENTS (Chief of
	// Staff). Workspace Coach is seeded synchronously by the workspace-create
	// paths, so its name-check below would only ever hit "existing" — Chief of
	// Staff is the one that actually needs post-commit seeding via this
	// function. Idempotent per workspace via the actors.name check.
	let chiefId: string | null = null
	let chiefIsNew = false
	try {
		const result = await ensureChiefOfStaffActor(db, workspaceId, createdBy)
		chiefId = result.actorId
		chiefIsNew = result.isNew
	} catch (err) {
		logger.error('Failed to create Chief of Staff during workspace bootstrap', {
			workspaceId,
			err,
		})
	}

	// Pin Chief of Staff as the workspace's default chat agent if nothing has
	// claimed that slot yet. No-op for workspaces that already have a
	// default_agent_id (e.g. dev-bootstrap already set it synchronously, or an
	// owner picked a different default).
	if (chiefId) {
		actorIdMap.chief_of_staff = chiefId
		await pinDefaultAgentIfUnset(db, workspaceId, chiefId)
		for (const skill of CHIEF_OF_STAFF_DEFAULT.skills ?? []) {
			await attachSkill(db, agentStorage, workspaceId, createdBy, chiefId, skill)
		}
	}

	// Workspace Coach was already seeded synchronously by the caller (see
	// workspaces.ts / actors.ts / dev-bootstrap.ts) — resolve its actor id here
	// so triggers targeting it can be wired below.
	const [coachRow] = await db
		.select({ actorId: workspaceMembers.actorId })
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(
			and(
				eq(workspaceMembers.workspaceId, workspaceId),
				eq(actors.name, WORKSPACE_COACH_DEFAULT.name),
			),
		)
		.limit(1)
	if (coachRow) {
		actorIdMap.workspace_coach = coachRow.actorId
		for (const skill of WORKSPACE_COACH_DEFAULT.skills ?? []) {
			await attachSkill(db, agentStorage, workspaceId, createdBy, coachRow.actorId, skill)
		}
	}

	for (const agent of DEFAULT_WORKSPACE_AGENTS) {
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
					description: agent.description ?? null,
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

		// Seed skills for this agent. Both inserts use onConflictDoNothing so
		// this is idempotent across repeated bootstrap runs.
		for (const skill of agent.skills ?? []) {
			await attachSkill(db, agentStorage, workspaceId, createdBy, actorId, skill)
		}
	}

	// Create triggers for all seeded agents. Track each trigger's id by name so
	// the default loops below (whose steps reference triggers by name) can wire
	// metadata.trigger_ids without a second lookup pass.
	const triggerIdByName: Record<string, string> = {}
	for (const trigger of DEFAULT_WORKSPACE_TRIGGERS) {
		const targetActorId = actorIdMap[trigger.targetActor$id]
		if (!targetActorId) continue

		// Idempotent: skip if a trigger with this name already exists in the workspace.
		const [existingTrigger] = await db
			.select({ id: triggers.id })
			.from(triggers)
			.where(and(eq(triggers.workspaceId, workspaceId), eq(triggers.name, trigger.name)))
			.limit(1)

		if (existingTrigger) {
			triggerIdByName[trigger.name] = existingTrigger.id
			continue
		}

		try {
			const [created] = await db
				.insert(triggers)
				.values({
					workspaceId,
					name: trigger.name,
					type: trigger.type,
					config: trigger.config as Record<string, unknown>,
					actionPrompt: trigger.actionPrompt,
					targetActorId,
					enabled: trigger.enabled,
					createdBy,
				})
				.returning({ id: triggers.id })

			if (created) triggerIdByName[trigger.name] = created.id
		} catch (err) {
			logger.error('Failed to create trigger during workspace bootstrap', {
				workspaceId,
				triggerName: trigger.name,
				err,
			})
		}
	}

	// Create the default Loop objects (Bet discovery loop, Workspace improvements),
	// wiring metadata.trigger_ids to the triggers seeded above. Idempotent per
	// workspace via the objects.title check, mirroring the agent/trigger checks
	// above.
	for (const loop of DEFAULT_WORKSPACE_LOOPS) {
		const [existingLoop] = await db
			.select({ id: objects.id })
			.from(objects)
			.where(
				and(
					eq(objects.workspaceId, workspaceId),
					eq(objects.type, 'loop'),
					eq(objects.title, loop.name),
				),
			)
			.limit(1)

		if (existingLoop) continue

		const triggerIds = loop.triggerNames
			.map((name) => triggerIdByName[name])
			.filter((id): id is string => Boolean(id))

		if (triggerIds.length === 0) {
			logger.error('Skipped seeding default loop — none of its triggers were created', {
				workspaceId,
				loopName: loop.name,
			})
			continue
		}

		try {
			const [created] = await db
				.insert(objects)
				.values({
					workspaceId,
					type: 'loop',
					title: loop.name,
					content: loop.content,
					status: 'learning',
					createdBy,
					metadata: {
						entry_condition: loop.entryCondition,
						close_condition: loop.closeCondition,
						trigger_ids: triggerIds,
					},
				})
				.returning()

			if (!created) {
				logger.error('Failed to create default loop object during workspace bootstrap', {
					workspaceId,
					loopName: loop.name,
				})
				continue
			}

			await db.insert(events).values({
				workspaceId,
				actorId: createdBy,
				action: 'created',
				entityType: 'loop',
				entityId: created.id,
				data: created,
			})
		} catch (err) {
			logger.error('Failed to create default loop during workspace bootstrap', {
				workspaceId,
				loopName: loop.name,
				err,
			})
		}
	}

	// Kick off Chief of Staff's welcome + first-pass-research session directly —
	// do NOT rely on an `actor.created` event trigger for this. The owner's
	// actor row is inserted (and this function is invoked) before any of the
	// triggers above exist, and actor creation doesn't emit an audit event at
	// all today, so the "New workspace — welcome & first-pass research" event
	// trigger can never actually catch this moment live. Only fires the first
	// time Chief of Staff is created for this workspace (chiefIsNew), so
	// idempotent re-runs of this function (e.g. a template backfill on an
	// existing workspace) never re-kick the welcome session.
	if (chiefIsNew && chiefId && sessionManager) {
		const [owner] = await db
			.select({ name: actors.name, email: actors.email })
			.from(actors)
			.where(eq(actors.id, createdBy))
			.limit(1)

		sessionManager
			.createSession(workspaceId, {
				actorId: chiefId,
				actionPrompt: buildChiefOfStaffKickoffPrompt(owner ?? {}),
				createdBy,
			})
			.catch((err) =>
				logger.error(
					'Failed to kick off Chief of Staff welcome session during workspace bootstrap',
					{
						workspaceId,
						err,
					},
				),
			)
	}
}

/**
 * The single, canonical "make a fully-provisioned workspace" path.
 *
 * Every caller that mints a workspace — signup (`POST /api/actors`), explicit
 * creation (`POST /api/workspaces`), and the dev auto-bootstrap — goes through
 * this so a workspace is never half-furnished depending on which door it came
 * in by. Previously each path hand-rolled its own subset: signup seeded only
 * Workspace Coach in-transaction and left the rest to a post-commit call,
 * dev-bootstrap seeded Coach + Chief of Staff, and only the workspaces route
 * seeded the full roster in-transaction or emitted `workspace_created`.
 *
 * In-transaction (rolled back as a unit on failure):
 *   - the `workspaces` row + the owner's `workspace_members` row
 *   - all seven default agent actors and their membership rows
 *   - pinning Chief of Staff as `settings.default_agent_id`
 *
 * Post-commit (each step non-fatal — these hit S3 / PostHog / the container
 * runtime, none of which can participate in a DB transaction):
 *   - the `workspace_created` analytics event
 *   - skills, workspace_skill files, triggers, and the default Loop objects
 *   - Chief of Staff's welcome + first-pass-research session
 *
 * `bootstrapDefaultAgents` is awaited rather than fired-and-forgotten: callers
 * hand the workspace straight to a user (or to an agent that immediately lists
 * its triggers), and racing that against skill/trigger/loop seeding is what
 * made freshly-created workspaces look emptier than freshly-signed-up ones.
 *
 * Throws SeedAgentError if a default agent fails to seed, so the caller can
 * surface which agent broke instead of a generic 500.
 */
export async function provisionWorkspace(params: {
	db: Database
	agentStorage: AgentStorageManager | undefined
	sessionManager: SessionManager | undefined
	name: string
	ownerActorId: string
	/** Raw settings from the request body, if any — parsed and merged here. */
	settings?: unknown
}): Promise<typeof workspaces.$inferSelect | null> {
	const { db, agentStorage, sessionManager, name, ownerActorId } = params

	// Every workspace is provisioned on the trial tier — `billing` is written
	// only by the Stripe webhook and /api/billing/*. POST /api/workspaces
	// rejects a caller-supplied `billing` outright; this strip is the
	// chokepoint that also covers signup and the dev bootstrap, and keeps a
	// future caller from reopening the hole. It matters doubly because
	// `candidatePlan` below is derived from these settings, so an unstripped
	// `billing.plan` would let the request validate its own ownership cap.
	const requestedSettings =
		params.settings && typeof params.settings === 'object' && !Array.isArray(params.settings)
			? (({ billing: _ignored, ...rest }) => rest)(params.settings as Record<string, unknown>)
			: params.settings

	const parsedSettings = workspaceSettingsSchema.parse(requestedSettings ?? {})
	const settings = applyModuleDefaults(parsedSettings, parsedSettings.enabled_modules)

	let chiefOfStaffId: string | undefined

	const candidatePlan = resolvePlanTier(settings)

	const workspace = await db.transaction(async (tx) => {
		// Serializes ownership-cap claims for this actor against any concurrent
		// workspace creation / transfer-ownership acceptance racing the same
		// actor's cap. See lockActorForOwnershipClaim's docstring.
		await lockActorForOwnershipClaim(tx, ownerActorId)

		const ownedPlans = await ownedWorkspacePlans(tx, ownerActorId)
		const effectiveTier = computeEffectiveTier(ownedPlans, candidatePlan)
		const cap = ownershipCapForTier(effectiveTier)
		if (cap !== null && ownedPlans.length >= cap && !isEnterpriseActor(ownerActorId)) {
			throw new OwnershipCapExceededError({
				actorId: ownerActorId,
				effectiveTier,
				used: ownedPlans.length,
				cap,
			})
		}

		const [ws] = await tx
			.insert(workspaces)
			.values({ name, settings, createdBy: ownerActorId, billingOwnerId: ownerActorId })
			.returning()

		if (!ws) {
			// An insert...returning() that yields no row is an anomaly, not an
			// expected branch. Log it here so the generic 500 the callers turn
			// this into is traceable to a cause.
			logger.error('provisionWorkspace: workspaces insert returned no row', {
				name,
				ownerActorId,
			})
			return null
		}

		await tx.insert(workspaceMembers).values({
			workspaceId: ws.id,
			actorId: ownerActorId,
			role: 'owner',
		})

		const agentIds = await seedDefaultAgentActors(tx, ws.id, ownerActorId)
		chiefOfStaffId = agentIds.chief_of_staff

		// Pin Chief of Staff as the default chat agent unless the caller
		// explicitly requested a different (or no) default in the create body.
		if (parsedSettings.default_agent_id === undefined && agentIds.chief_of_staff) {
			const nextSettings = { ...settings, default_agent_id: agentIds.chief_of_staff }
			await tx.update(workspaces).set({ settings: nextSettings }).where(eq(workspaces.id, ws.id))
			ws.settings = nextSettings
		}

		return ws
	})

	if (!workspace) return null

	// Fire-and-forget by design — the analytics client never throws (see posthog.ts).
	void capturePosthogEvent('workspace_created', workspace.id, {
		workspace_id: workspace.id,
		workspace_name: workspace.name,
		created_by: ownerActorId,
	})

	// The actor + member rows are already committed above, so this call is a
	// no-op for actors (its name check hits every one) and only writes
	// workspace_skills + agent_skills + triggers + the default loop objects.
	if (agentStorage) {
		await bootstrapDefaultAgents(
			db,
			agentStorage,
			workspace.id,
			ownerActorId,
			sessionManager,
		).catch((err) => logger.error('workspace bootstrap failed', { workspaceId: workspace.id, err }))
	} else {
		// Not a silent branch: without agentStorage the workspace ships with its
		// agents but no skills, no triggers and no default Loop objects. That is
		// a wiring bug everywhere except tests that deliberately opt out.
		logger.warn('provisionWorkspace: no agentStorage — skipped skills, triggers and loops', {
			workspaceId: workspace.id,
		})
	}

	// Chief of Staff was seeded synchronously above, so bootstrapDefaultAgents
	// only ever sees it as pre-existing (chiefIsNew === false) and skips its own
	// kickoff — fire the welcome session here instead. It can't be driven by an
	// `actor.created` event trigger either: the owner's actor row predates every
	// trigger in this workspace.
	if (chiefOfStaffId && sessionManager) {
		const [owner] = await db
			.select({ name: actors.name, email: actors.email })
			.from(actors)
			.where(eq(actors.id, ownerActorId))
			.limit(1)

		sessionManager
			.createSession(workspace.id, {
				actorId: chiefOfStaffId,
				actionPrompt: buildChiefOfStaffKickoffPrompt(owner ?? {}),
				createdBy: ownerActorId,
			})
			.catch((err) =>
				logger.error('Chief of Staff welcome session failed', { workspaceId: workspace.id, err }),
			)
	}

	return workspace
}
