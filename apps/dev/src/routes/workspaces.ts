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
	transferBillingOwnershipSchema,
	updateWorkspaceAdminSchema,
	updateWorkspaceSchema,
} from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { byollmEntitled, isEnterpriseActor } from '../lib/enterprise-allowlist'
import { createApiError, validationFailureHook } from '../lib/errors'
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
import {
	isWorkspaceHumanAdminOrOwner,
	isWorkspaceMember,
	isWorkspaceOwner,
} from '../lib/workspace-auth'
import {
	OwnershipCapExceededError,
	SeatCapExceededError,
	computeEffectiveTier,
	countHumanMembers,
	lockActorForOwnershipClaim,
	ownedWorkspacePlans,
	ownershipCapForTier,
	resolvePlanTier,
	seatCapForPlan,
} from '../lib/workspace-capacity'
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'
import { SeedAgentError, provisionWorkspace } from '../services/workspace-bootstrap'

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

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

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
		400: {
			description: 'Request set `settings.billing`, which is owned by Stripe',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Actor has reached their workspace-ownership cap for their plan tier',
			content: { 'application/json': { schema: errorSchema } },
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

	// Same rule as PATCH below: `billing` is owned by Stripe and /api/billing/*.
	// Every workspace starts on trial; accepting it here would let any actor —
	// or any agent via MCP `create_workspace`, which shares this schema —
	// self-grant `plan: 'team', status: 'active'` at creation time and take the
	// seat cap, the ownership cap and an arbitrary `hard_cap_usd_cents` of
	// Maskin-funded spend without paying. The ownership-cap check inside
	// provisionWorkspace() derives the candidate tier from these same settings,
	// so an unguarded create also validates the claim against itself.
	if (body.settings && 'billing' in body.settings) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				'billing cannot be set via POST /api/workspaces — it is owned by Stripe and /api/billing/*',
			),
			400,
		)
	}

	// All workspace provisioning — default agents, skills, triggers, default
	// loops, the pinned chat agent, and Chief of Staff's welcome session — lives
	// in provisionWorkspace() so this route, signup, and the dev auto-bootstrap
	// all produce identically furnished workspaces.
	let workspace: typeof workspaces.$inferSelect | null
	try {
		workspace = await provisionWorkspace({
			db,
			agentStorage: c.get('agentStorage'),
			sessionManager: c.get('sessionManager'),
			name: body.name,
			ownerActorId: actorId,
			settings: body.settings,
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
			// The BYO-LLM entitlement flag drives whether the settings UI renders
			// the Claude subscription / API-key controls at all. Omitting it here
			// made every workspace look non-entitled in the frontend even after an
			// ops grant, because the sidebar workspace list is the only source the
			// UI reads it from. See PR #970.
			onboardingEnabled: workspaces.onboardingEnabled,
			byollmAllowed: workspaces.byollmAllowed,
			billingOwnerId: workspaces.billingOwnerId,
			createdBy: workspaces.createdBy,
			role: workspaceMembers.role,
			createdAt: workspaces.createdAt,
			updatedAt: workspaces.updatedAt,
		})
		.from(workspaceMembers)
		.innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))
		.where(eq(workspaceMembers.actorId, actorId))

	// Report the *effective* entitlement, not the raw column — an enterprise
	// billing owner is entitled on every workspace they own without a
	// per-workspace grant. This list is the only place the frontend reads the
	// flag from, so it gates the whole settings UI.
	const withEntitlement = results.map((row) => ({
		...row,
		byollmAllowed: byollmEntitled(row),
	}))

	return c.json(serializeArray(withEntitlement) as z.infer<typeof workspaceWithRoleSchema>[])
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

	// `billing` is owned by Stripe (the webhook in routes/stripe-webhook.ts) and
	// the dedicated /api/billing/* routes; the balance is owned by
	// lib/credit-billing.ts. Accepting it here would let any workspace owner —
	// or any agent holding a workspace API key, since MCP exposes
	// `update_workspace` with this same schema — self-grant `plan: 'team',
	// status: 'active'` and take unlimited seats, unlimited owned workspaces and
	// a paid spend cap without paying. Nobody hand-writes billing, not even ops:
	// Stripe is authoritative and the next webhook would overwrite it anyway, so
	// this is rejected outright rather than permissioned. The BYO-transition
	// downgrade below still works — it derives `merged.billing` itself, after
	// this merge, and never reads it from the request body.
	if (body.settings && 'billing' in body.settings) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				'billing cannot be updated via PATCH /api/workspaces/:id — it is owned by Stripe and /api/billing/*',
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
		if (!byollmEntitled(existing) && patchAddsAnyByoCredential(body.settings)) {
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

// PATCH /api/workspaces/admin/:id — flip onboarding_enabled without a code deploy.
// `onboarding_enabled` is owner-settable; `byollm_allowed` additionally requires
// an ops actor (MASKIN_ENTERPRISE_ACTOR_IDS) — see the handler.
const updateWorkspaceOnboardingRoute = createRoute({
	method: 'patch',
	path: '/admin/{id}',
	tags: ['workspaces'],
	summary: 'Set onboarding_enabled (owner) / byollm_allowed (ops only)',
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
			description: 'Caller is not the workspace owner, or set byollm_allowed without ops rights',
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

	// `byollm_allowed` is an ops grant, NOT an owner-settable preference: it is
	// the only thing standing between a workspace and bypassing the plan cap,
	// the paid-plan mutex, and credit debiting entirely. Every self-signed-up
	// user is the `owner` of their own workspace, so the owner check above is
	// not a gate for this field — without the allowlist check, `PATCH
	// {"byollm_allowed": true}` would be free self-service entitlement. See the
	// same reasoning in `byollmEntitled` (lib/enterprise-allowlist.ts).
	if (body.byollm_allowed !== undefined && !isEnterpriseActor(actorId)) {
		return c.json(
			createApiError('FORBIDDEN', 'byollm_allowed can only be set by an ops actor'),
			403,
		)
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
						'A workspace has been enabled for onboarding (onboarding_enabled flipped to true). Run the workspace-observer-onboarding skill.\n\nBefore starting: check whether this workspace already has an onboarding_session object. If one exists, exit silently.\n\nIf none exists, follow the workspace-observer-onboarding skill to:\n1. Create the onboarding_session object.\n2. Subscribe the workspace owner.\n3. Post the five context prompts in sequence, waiting for each reply before the next.\n4. For each reply, call create_objects ONCE with both the knowledge node and the `about` edge in the same batch — owner-targeted prompts (product_vision, icp, first_bet_hypothesis, customer_evidence) edge to the workspace owner\'s actor id; the north_star_metric prompt edges to the workspace id. Populate metadata.source = "workspace_onboarding", subject_kind, subject_id, claim, confidence, valid_from, valid_to per the skill. Do NOT write to the actor\'s memory field.\n5. Close the session when all prompts are answered (or after 24h).',
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
			description: 'Member added (or already a member — idempotent)',
			content: { 'application/json': { schema: z.object({ added: z.boolean() }) } },
		},
		403: {
			description: 'Caller is not a workspace member, or the workspace has reached its seat cap',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace or actor not found',
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

	const [targetActor] = await db
		.select({ type: actors.type })
		.from(actors)
		.where(eq(actors.id, actor_id))
		.limit(1)
	if (!targetActor) return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)

	const outcome = await db.transaction(async (tx) => {
		// Lock the workspace row for the duration of the capacity check + insert.
		// Serializes ALL concurrent member-adds against this workspace — the
		// seat cap is a workspace-scoped aggregate (COUNT across all members),
		// not a per-row invariant a UNIQUE constraint alone could enforce.
		const [locked] = await tx
			.select({
				id: workspaces.id,
				settings: workspaces.settings,
				billingOwnerId: workspaces.billingOwnerId,
			})
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for('update')
			.limit(1)
		if (!locked) return { kind: 'ws_not_found' as const }

		// Agents never count toward the seat cap and are never blocked by it.
		if (targetActor.type === 'human' && !isEnterpriseActor(locked.billingOwnerId)) {
			const plan = resolvePlanTier(locked.settings)
			const cap = seatCapForPlan(plan)
			if (cap !== null) {
				const used = await countHumanMembers(tx, workspaceId)
				if (used >= cap) {
					return { kind: 'cap_exceeded' as const, plan, used, cap }
				}
			}
		}

		// onConflictDoNothing turns a re-invite of an already-a-member actor into
		// a safe idempotent no-op instead of an uncaught PK-violation crash.
		const inserted = await tx
			.insert(workspaceMembers)
			.values({ workspaceId, actorId: actor_id, role: role || 'member' })
			.onConflictDoNothing({ target: [workspaceMembers.workspaceId, workspaceMembers.actorId] })
			.returning()

		if (!inserted.length) return { kind: 'already_member' as const }

		await tx.insert(events).values({
			workspaceId,
			actorId: callerId,
			action: 'created',
			entityType: 'workspace_member',
			entityId: actor_id,
			data: { role: role || 'member', added_actor_id: actor_id },
		})

		return { kind: 'added' as const }
	})

	if (outcome.kind === 'ws_not_found') {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}
	if (outcome.kind === 'cap_exceeded') {
		throw new SeatCapExceededError({
			workspaceId,
			plan: outcome.plan,
			used: outcome.used,
			cap: outcome.cap,
		})
	}

	return c.json({ added: outcome.kind === 'added' }, 201)
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

// POST /api/workspaces/:id/transfer-ownership
const transferOwnershipRoute = createRoute({
	method: 'post',
	path: '/{id}/transfer-ownership',
	tags: ['workspaces'],
	summary: 'Transfer billing ownership to another existing human member',
	request: {
		params: idParamSchema,
		body: {
			content: {
				'application/json': {
					schema: transferBillingOwnershipSchema,
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Ownership transferred',
			content: { 'application/json': { schema: workspaceResponseSchema } },
		},
		400: {
			description: 'Cannot transfer to self',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Caller is not the current billing owner, or the new owner is over their cap',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found, or new owner is not an existing member',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'New owner is not a human actor',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(transferOwnershipRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { id: workspaceId } = c.req.valid('param')
	const { new_owner_actor_id: newOwnerActorId } = c.req.valid('json')

	if (newOwnerActorId === callerId) {
		return c.json(createApiError('BAD_REQUEST', 'Already the billing owner'), 400)
	}

	const outcome = await db.transaction(async (tx) => {
		// Lock BOTH actors' ownership-claim serialization points, in a fixed
		// (sorted) order to prevent a lock-ordering deadlock against a
		// concurrent transfer running the reverse direction (A transferring to
		// B while B transfers a DIFFERENT workspace to A at the same time).
		const [first, second] = [callerId, newOwnerActorId].sort() as [string, string]
		await lockActorForOwnershipClaim(tx, first)
		await lockActorForOwnershipClaim(tx, second)

		const [ws] = await tx
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for('update')
			.limit(1)
		if (!ws) return { kind: 'ws_not_found' as const }
		if (ws.billingOwnerId !== callerId) return { kind: 'not_owner' as const }

		const [targetMember] = await tx
			.select({ type: actors.type })
			.from(workspaceMembers)
			.innerJoin(actors, eq(actors.id, workspaceMembers.actorId))
			.where(
				and(
					eq(workspaceMembers.workspaceId, workspaceId),
					eq(workspaceMembers.actorId, newOwnerActorId),
				),
			)
			.limit(1)
		if (!targetMember) return { kind: 'not_member' as const }
		if (targetMember.type !== 'human') return { kind: 'not_human' as const }

		const wsPlan = resolvePlanTier(ws.settings)
		const newOwnerPlans = await ownedWorkspacePlans(tx, newOwnerActorId)
		const effectiveTier = computeEffectiveTier(newOwnerPlans, wsPlan)
		const cap = ownershipCapForTier(effectiveTier)
		if (cap !== null && newOwnerPlans.length >= cap) {
			return { kind: 'cap_exceeded' as const, effectiveTier, used: newOwnerPlans.length, cap }
		}

		const [updated] = await tx
			.update(workspaces)
			.set({ billingOwnerId: newOwnerActorId, updatedAt: new Date() })
			.where(eq(workspaces.id, workspaceId))
			.returning()
		if (!updated) return { kind: 'ws_not_found' as const }

		await tx.insert(events).values({
			workspaceId,
			actorId: callerId,
			action: 'updated',
			entityType: 'workspace',
			entityId: workspaceId,
			data: {
				billing_owner_transferred_from: callerId,
				billing_owner_transferred_to: newOwnerActorId,
			},
		})

		return { kind: 'transferred' as const, workspace: updated }
	})

	switch (outcome.kind) {
		case 'ws_not_found':
			return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
		case 'not_owner':
			return c.json(
				createApiError('FORBIDDEN', 'Only the current billing owner can transfer ownership'),
				403,
			)
		case 'not_member':
			return c.json(createApiError('NOT_FOUND', 'New owner must be an existing member'), 404)
		case 'not_human':
			return c.json(createApiError('CONFLICT', 'Billing owner must be a human actor'), 409)
		case 'cap_exceeded':
			throw new OwnershipCapExceededError({
				actorId: newOwnerActorId,
				effectiveTier: outcome.effectiveTier,
				used: outcome.used,
				cap: outcome.cap,
			})
		case 'transferred':
			return c.json(serialize(outcome.workspace) as z.infer<typeof workspaceResponseSchema>, 200)
	}
}) as RouteHandler<typeof transferOwnershipRoute, Env>)

// DELETE /api/workspaces/:id/members/:actorId
const removeMemberParamsSchema = idParamSchema.extend({ actorId: z.string().uuid() })

const removeMemberRoute = createRoute({
	method: 'delete',
	path: '/{id}/members/{actorId}',
	tags: ['workspaces'],
	summary: 'Remove a member from a workspace (or leave, if removing yourself)',
	request: {
		params: removeMemberParamsSchema,
	},
	responses: {
		200: {
			description: 'Member removed',
			content: { 'application/json': { schema: z.object({ removed: z.literal(true) }) } },
		},
		403: {
			description: 'Only owners/admins can remove other members',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace or membership not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'Cannot remove the current billing owner — transfer ownership first',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(removeMemberRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { id: workspaceId, actorId: targetActorId } = c.req.valid('param')
	const isSelfRemoval = targetActorId === callerId

	if (!isSelfRemoval && !(await isWorkspaceHumanAdminOrOwner(db, callerId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Only owners/admins can remove other members'), 403)
	}

	const outcome = await db.transaction(async (tx) => {
		const [ws] = await tx
			.select({ billingOwnerId: workspaces.billingOwnerId })
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for('update')
			.limit(1)
		if (!ws) return { kind: 'ws_not_found' as const }

		// Checked inside the same lock as the delete so a concurrent transfer
		// can't race past this guard.
		if (ws.billingOwnerId === targetActorId) return { kind: 'is_billing_owner' as const }

		const deleted = await tx
			.delete(workspaceMembers)
			.where(
				and(
					eq(workspaceMembers.workspaceId, workspaceId),
					eq(workspaceMembers.actorId, targetActorId),
				),
			)
			.returning()
		if (!deleted.length) return { kind: 'not_member' as const }

		await tx.insert(events).values({
			workspaceId,
			actorId: callerId,
			action: 'deleted',
			entityType: 'workspace_member',
			entityId: targetActorId,
			data: { removed_actor_id: targetActorId, self_removal: isSelfRemoval },
		})

		return { kind: 'removed' as const }
	})

	switch (outcome.kind) {
		case 'ws_not_found':
			return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
		case 'not_member':
			return c.json(createApiError('NOT_FOUND', 'Not a member of this workspace'), 404)
		case 'is_billing_owner':
			return c.json(
				createApiError(
					'CONFLICT',
					'Cannot remove the billing owner — transfer ownership to another member first',
				),
				409,
			)
		case 'removed':
			return c.json({ removed: true as const }, 200)
	}
}) as RouteHandler<typeof removeMemberRoute, Env>)

export default app
