import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	workspaceMembers,
	workspaceOnboardingPrompts,
	workspaces,
} from '@maskin/db/schema'
import {
	WORKSPACE_ADMIN_DIFF_FIELDS,
	WORKSPACE_COACH_DEFAULT,
	computeChanges,
	createWorkspaceSchema,
	updateWorkspaceAdminSchema,
	updateWorkspaceSchema,
	workspaceSettingsSchema,
} from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { createApiError } from '../lib/errors'
import {
	billingAfterByoTransition,
	cancelActivePaidSubscription,
	hasActivePaidPlan,
	patchAddsAnyByoCredential,
	patchAddsByoSource,
} from '../lib/llm-source-mutex'
import { logger } from '../lib/logger'
import { errorSchema, idParamSchema, workspaceResponseSchema } from '../lib/openapi-schemas'
import { serialize, serializeArray } from '../lib/serialize'
import { getStripeClient, readStripeEnv } from '../lib/stripe'
import type { WorkspaceSettings } from '../lib/types'
import { isWorkspaceMember, isWorkspaceOwner } from '../lib/workspace-auth'
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'
import {
	SeedAgentError,
	bootstrapDefaultAgents,
	seedDefaultAgentActors,
} from '../services/workspace-bootstrap'

type WorkspaceBilling = WorkspaceSettings['billing']

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		agentStorage: AgentStorageManager
		sessionManager: SessionManager
	}
}

const memberResponseSchema = z.object({
	actorId: z.string().uuid(),
	role: z.string(),
	joinedAt: z.string().nullable(),
	name: z.string(),
	type: z.string(),
})

const addMemberBodySchema = z.object({
	actor_id: z.string().uuid(),
	role: z.string().optional(),
})

const workspaceWithRoleSchema = workspaceResponseSchema.extend({
	role: z.string(),
})

const app = new OpenAPIHono<Env>()

// POST /api/workspaces
const createWorkspaceRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['workspaces'],
	summary: 'Create workspace',
	request: {
		body: {
			content: {
				'application/json': {
					schema: createWorkspaceSchema,
				},
			},
		},
	},
	responses: {
		201: {
			description: 'Workspace created',
			content: { 'application/json': { schema: workspaceResponseSchema } },
		},
		500: {
			description: 'Internal server error',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(createWorkspaceRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const body = c.req.valid('json')

	const settings = workspaceSettingsSchema.parse(body.settings ?? {})

	let workspace: typeof workspaces.$inferSelect | null
	try {
		workspace = await db.transaction(async (tx) => {
			const [ws] = await tx
				.insert(workspaces)
				.values({
					name: body.name,
					settings,
					createdBy: actorId,
				})
				.returning()

			if (!ws) return null

			// Auto-add creator as owner
			await tx.insert(workspaceMembers).values({
				workspaceId: ws.id,
				actorId,
				role: 'owner',
			})

			// Seed all default agents (Coach, Chief of Staff, Driver, Strategist,
			// Insights Triage, Research Agent) inside the same transaction. If any
			// one fails the tx rolls back — no half-seeded workspace lingers behind
			// a partial success.
			// Skills, workspace_skill files, and triggers are seeded post-commit
			// because they hit S3 and can't be rolled back inside a DB transaction.
			const agentIds = await seedDefaultAgentActors(tx, ws.id, actorId)

			// Pin Chief of Staff as the default chat agent unless the caller
			// explicitly requested a different (or no) default in the create body.
			if (settings.default_agent_id === undefined && agentIds.chief_of_staff) {
				const nextSettings = { ...settings, default_agent_id: agentIds.chief_of_staff }
				await tx.update(workspaces).set({ settings: nextSettings }).where(eq(workspaces.id, ws.id))
				ws.settings = nextSettings
			}

			return ws
		})
	} catch (err) {
		if (err instanceof SeedAgentError) {
			logger.error('Workspace create rolled back — default agent seed failed', {
				agentId: err.agentId,
				errorClass: err.errorClass,
				cause: err.cause instanceof Error ? err.cause.message : String(err.cause),
			})
			return c.json(
				createApiError(
					'INTERNAL_ERROR',
					`Failed to seed default agent "${err.agentId}": ${err.errorClass}`,
					[
						{ field: 'agent_id', message: err.agentId },
						{ field: 'error_class', message: err.errorClass },
					],
				),
				500,
			)
		}
		throw err
	}

	if (!workspace) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create workspace'), 500)
	}

	// Post-commit: emit workspace_created for the bet's activation-cohort query.
	// Fire-and-forget by design — the analytics client never throws (see posthog.ts).
	void capturePosthogEvent('workspace_created', workspace.id, {
		workspace_id: workspace.id,
		workspace_name: workspace.name,
		created_by: actorId,
	})

	// Post-commit: seed the default agents' skills + triggers. The actor + member
	// rows are already committed by seedDefaultAgentActors, so this call is a
	// no-op for actors (name check hits every one) and only writes
	// workspace_skills + agent_skills + triggers.
	const agentStorage = c.get('agentStorage')
	if (agentStorage) {
		bootstrapDefaultAgents(db, agentStorage, workspace.id, actorId).catch((err) =>
			logger.error('workspace bootstrap failed', { workspaceId: workspace.id, err }),
		)
	}

	return c.json(serialize(workspace) as z.infer<typeof workspaceResponseSchema>, 201)
})

// GET /api/workspaces
const listWorkspacesRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['workspaces'],
	summary: 'List workspaces for current actor',
	responses: {
		200: {
			description: 'List of workspaces',
			content: { 'application/json': { schema: z.array(workspaceWithRoleSchema) } },
		},
	},
})

app.openapi(listWorkspacesRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')

	const results = await db
		.select({
			id: workspaces.id,
			name: workspaces.name,
			settings: workspaces.settings,
			role: workspaceMembers.role,
			createdAt: workspaces.createdAt,
		})
		.from(workspaceMembers)
		.innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
		.where(eq(workspaceMembers.actorId, actorId))

	return c.json(serializeArray(results) as z.infer<typeof workspaceWithRoleSchema>[])
})

// PATCH /api/workspaces/:id
const updateWorkspaceRoute = createRoute({
	method: 'patch',
	path: '/{id}',
	tags: ['workspaces'],
	summary: 'Update workspace',
	request: {
		params: idParamSchema,
		body: {
			content: {
				'application/json': {
					schema: updateWorkspaceSchema,
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Workspace updated',
			content: { 'application/json': { schema: workspaceResponseSchema } },
		},
		400: {
			description: 'Invalid request',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Workspace is not entitled to BYO LLM credentials',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(updateWorkspaceRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	// claude_oauth has its own locked, slot-aware, audited read-modify-write
	// routes (POST /api/claude-oauth/import, DELETE /api/claude-oauth,
	// POST /api/claude-oauth/swap) built to prevent concurrent writers from
	// clobbering the other slot or failover state. This route does a shallow,
	// unlocked settings merge, so it must not be allowed to touch claude_oauth
	// at all — otherwise any PATCH body containing `settings.claude_oauth`
	// (including `{}`) would silently overwrite both slots.
	if (body.settings && 'claude_oauth' in body.settings) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				'claude_oauth cannot be updated via PATCH /api/workspaces/:id — use /api/claude-oauth instead',
			),
			400,
		)
	}

	const updateData: Record<string, unknown> = { updatedAt: new Date() }
	if (body.name) updateData.name = body.name
	if (body.settings) {
		// Merge settings with existing. Top-level keys are shallow-merged, but
		// `llm_keys` is deep-merged so concurrent single-provider updates (UI +
		// MCP) don't clobber sibling providers. `null` values inside `llm_keys`
		// are treated as deletions.
		const [existing] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
		if (!existing) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)

		// Entitlement gate: every workspace defaults to the Maskin-provided LLM
		// plan; only ops-flagged exception workspaces may add a BYO Anthropic/
		// OpenAI key or enable custom_llm. See PR #970.
		if (!existing.byollmAllowed && patchAddsAnyByoCredential(body.settings)) {
			return c.json(
				createApiError(
					'FORBIDDEN',
					'This workspace is on the Maskin-provided LLM plan and cannot add BYO LLM credentials',
				),
				403,
			)
		}

		const existingSettings = (existing.settings ?? {}) as Record<string, unknown>
		const merged: Record<string, unknown> = { ...existingSettings, ...body.settings }
		if (body.settings.llm_keys) {
			const existingLlm = (existingSettings.llm_keys ?? {}) as Record<string, string>
			const mergedLlm: Record<string, string> = { ...existingLlm }
			for (const [k, v] of Object.entries(body.settings.llm_keys)) {
				if (v === null || v === undefined) delete mergedLlm[k]
				else mergedLlm[k] = v
			}
			merged.llm_keys = mergedLlm
		}

		// BYOLLM ↔ paid plan mutex: if the PATCH is adding a BYO Anthropic
		// key or enabling custom_llm AND a live Stripe subscription exists,
		// cancel the subscription via API first and roll the billing slot
		// into the same merged write. The .deleted webhook will arrive
		// shortly after and is idempotent against this exact terminal state.
		if (patchAddsByoSource(body.settings)) {
			const errorRes = await cancelPaidPlanForByoTransition(existingSettings, merged, id)
			if (errorRes) return c.json(...errorRes)
		}

		updateData.settings = merged
	}

	const [updated] = await db
		.update(workspaces)
		.set(updateData)
		.where(eq(workspaces.id, id))
		.returning()

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	await db.insert(events).values({
		workspaceId: id,
		actorId,
		action: 'updated',
		entityType: 'workspace',
		entityId: id,
		data: { updated },
	})

	return c.json(serialize(updated) as z.infer<typeof workspaceResponseSchema>)
}) as RouteHandler<typeof updateWorkspaceRoute, Env>)

/**
 * Shared by PATCH /api/workspaces/:id when the body adds a BYOLLM source.
 * Mutates `merged.billing` in place once the Stripe cancel succeeds.
 * Returns a `[body, status]` tuple for the route to surface on failure, or
 * `null` to proceed with the existing settings merge.
 */
async function cancelPaidPlanForByoTransition(
	existingSettings: Record<string, unknown>,
	merged: Record<string, unknown>,
	workspaceId: string,
): Promise<[ReturnType<typeof createApiError>, 500] | null> {
	const existingBilling = (existingSettings.billing as WorkspaceBilling) ?? undefined
	if (!hasActivePaidPlan({ billing: existingBilling })) {
		// Either no plan, or already canceled — still write the byollm
		// downgrade so the local row reflects the user's intent.
		const downgrade = billingAfterByoTransition(existingBilling)
		if (downgrade) merged.billing = downgrade
		return null
	}

	let stripeEnv: ReturnType<typeof readStripeEnv>
	try {
		stripeEnv = readStripeEnv()
	} catch (err) {
		logger.error('Cannot cancel paid plan for BYOLLM transition: Stripe is not configured', {
			workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
		return [createApiError('INTERNAL_ERROR', 'Stripe is not configured'), 500]
	}

	try {
		await cancelActivePaidSubscription(
			getStripeClient(stripeEnv),
			// biome-ignore lint/style/noNonNullAssertion: hasActivePaidPlan guarantees this
			existingBilling!.stripe_subscription_id!,
		)
	} catch (err) {
		logger.error('Stripe subscription cancel failed during BYOLLM transition', {
			workspaceId,
			subscriptionId: existingBilling?.stripe_subscription_id,
			error: err instanceof Error ? err.message : String(err),
		})
		return [createApiError('INTERNAL_ERROR', 'Failed to cancel paid subscription'), 500]
	}

	const downgrade = billingAfterByoTransition(existingBilling)
	if (downgrade) merged.billing = downgrade
	logger.info('Paid plan canceled during BYOLLM transition', {
		workspaceId,
		subscriptionId: existingBilling?.stripe_subscription_id,
	})
	return null
}

// PATCH /api/workspaces/admin/:id — flip onboarding_enabled without a code deploy
const updateWorkspaceOnboardingRoute = createRoute({
	method: 'patch',
	path: '/admin/{id}',
	tags: ['workspaces'],
	summary: 'Set onboarding_enabled flag (owner only)',
	request: {
		params: idParamSchema,
		body: {
			content: {
				'application/json': {
					schema: updateWorkspaceAdminSchema,
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Workspace updated',
			content: { 'application/json': { schema: workspaceResponseSchema } },
		},
		403: {
			description: 'Caller is not the workspace owner',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

const ONBOARDING_PROMPT_TYPES = [
	'product_vision',
	'icp',
	'first_bet_hypothesis',
	'north_star_metric',
	'customer_evidence',
] as const

app.openapi(updateWorkspaceOnboardingRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const body = c.req.valid('json')

	const [existing] = await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1)
	if (!existing) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)

	if (!(await isWorkspaceOwner(db, actorId, id))) {
		return c.json(createApiError('FORBIDDEN', 'Not a workspace owner'), 403)
	}

	const adminUpdate: Record<string, unknown> = { updatedAt: new Date() }
	if (body.onboarding_enabled !== undefined) adminUpdate.onboardingEnabled = body.onboarding_enabled
	if (body.byollm_allowed !== undefined) adminUpdate.byollmAllowed = body.byollm_allowed

	const [updated] = await db
		.update(workspaces)
		.set(adminUpdate)
		.where(eq(workspaces.id, id))
		.returning()

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	if (body.onboarding_enabled) {
		await db
			.insert(workspaceOnboardingPrompts)
			.values(ONBOARDING_PROMPT_TYPES.map((promptType) => ({ workspaceId: id, promptType })))
			.onConflictDoNothing()

		const [coach] = await db
			.select({ id: actors.id })
			.from(actors)
			.innerJoin(workspaceMembers, eq(workspaceMembers.actorId, actors.id))
			.where(
				and(eq(workspaceMembers.workspaceId, id), eq(actors.name, WORKSPACE_COACH_DEFAULT.name)),
			)
			.limit(1)

		if (coach) {
			c.get('sessionManager')
				.createSession(id, {
					actorId: coach.id,
					actionPrompt:
						'A workspace has been enabled for onboarding (onboarding_enabled flipped to true). Run the workspace-observer-onboarding skill.\n\nBefore starting: check whether this workspace already has an onboarding_session object. If one exists, exit silently.\n\nIf none exists, follow the workspace-observer-onboarding skill to:\n1. Create the onboarding_session object.\n2. Subscribe the workspace owner.\n3. Post the five context prompts in sequence, waiting for each reply before the next.\n4. Capture each reply as a knowledge object.\n5. Close the session when all prompts are answered (or after 24h).',
					createdBy: actorId,
				})
				.catch((err) =>
					logger.error('Failed to create onboarding session', { workspaceId: id, err }),
				)
		}
	}

	const changes = computeChanges(
		existing as unknown as Record<string, unknown>,
		updated as unknown as Record<string, unknown>,
		WORKSPACE_ADMIN_DIFF_FIELDS,
	)
	await db.insert(events).values({
		workspaceId: id,
		actorId,
		action: 'updated',
		entityType: 'workspace',
		entityId: id,
		data: { changes },
	})

	return c.json(serialize(updated) as z.infer<typeof workspaceResponseSchema>)
}) as RouteHandler<typeof updateWorkspaceOnboardingRoute, Env>)

// POST /api/workspaces/:id/members
const addMemberRoute = createRoute({
	method: 'post',
	path: '/{id}/members',
	tags: ['workspaces'],
	summary: 'Add member to workspace',
	request: {
		params: idParamSchema,
		body: {
			content: {
				'application/json': {
					schema: addMemberBodySchema,
				},
			},
		},
	},
	responses: {
		201: {
			description: 'Member added',
			content: { 'application/json': { schema: z.object({ added: z.boolean() }) } },
		},
		403: {
			description: 'Caller is not a workspace member',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(addMemberRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { id: workspaceId } = c.req.valid('param')
	const { actor_id, role } = c.req.valid('json')

	if (!(await isWorkspaceMember(db, callerId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	await db.insert(workspaceMembers).values({
		workspaceId,
		actorId: actor_id,
		role: role || 'member',
	})

	return c.json({ added: true }, 201)
}) as RouteHandler<typeof addMemberRoute, Env>)

// GET /api/workspaces/:id/members
const listMembersRoute = createRoute({
	method: 'get',
	path: '/{id}/members',
	tags: ['workspaces'],
	summary: 'List workspace members',
	request: {
		params: idParamSchema,
	},
	responses: {
		200: {
			description: 'List of members',
			content: { 'application/json': { schema: z.array(memberResponseSchema) } },
		},
	},
})

app.openapi(listMembersRoute, async (c) => {
	const db = c.get('db')
	const { id: workspaceId } = c.req.valid('param')

	const members = await db
		.select({
			actorId: workspaceMembers.actorId,
			role: workspaceMembers.role,
			joinedAt: workspaceMembers.joinedAt,
			name: actors.name,
			type: actors.type,
		})
		.from(workspaceMembers)
		.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
		.where(eq(workspaceMembers.workspaceId, workspaceId))

	return c.json(serializeArray(members) as z.infer<typeof memberResponseSchema>[])
})

export default app
