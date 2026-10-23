import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import { evictActor, generateApiKey, hashPassword } from '@maskin/auth'
import type { Database, Transaction } from '@maskin/db'
import {
	events,
	actors,
	agentFiles,
	agentSkills,
	conversationParticipants,
	files,
	imports,
	integrations,
	messages,
	notifications,
	objects,
	orphanThreadDetections,
	readState,
	relationships,
	sessionLogs,
	sessions,
	subscriptions,
	triggers,
	workspaceMembers,
	workspaceSkills,
	workspaces,
} from '@maskin/db/schema'
import {
	type AgentState,
	PLATFORM_MCP_PRESET,
	WORKSPACE_COACH_DEFAULT,
	createActorSchema,
	updateActorSchema,
} from '@maskin/shared'
import { and, asc, count, countDistinct, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { maskLlmConfigSecrets, restoreMaskedLlmConfig } from '../lib/actor-llm-config-redaction'
import { toActorWithKeyResponse } from '../lib/actor-response'
import { redactActorToolsForCaller, restoreMaskedToolValues } from '../lib/actor-tools-redaction'
import { CLIENT_SOURCE_HEADER } from '../lib/analytics/knowledge-events'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { resolveBearerCaller } from '../lib/bearer-caller'
import { buildCreatedAtCursorConditions, useKeysetSeek } from '../lib/cursor-pagination'
import { createApiError, validationFailureHook } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import { describeAgentAccess } from '../lib/integrations/agent-access-view'
import { PlanCapExceededError } from '../lib/llm-routing'
import { logger } from '../lib/logger'
import {
	actorListItemSchema,
	actorResponseSchema,
	actorWithKeySchema,
	errorSchema,
	idParamSchema,
	workspaceIdHeader,
} from '../lib/openapi-schemas'
import { resolveClientSourceTag } from '../lib/sentry'
import { serialize, serializeArray } from '../lib/serialize'
import {
	actorsShareWorkspace,
	assertActorWriterAccess,
	assertWorkspaceWriterRole,
	getWorkspaceRole,
	isAdminOfSharedWorkspace,
	isWorkspaceHumanAdminOrOwner,
	isWorkspaceMember,
} from '../lib/workspace-auth'
import { OwnershipCapExceededError } from '../lib/workspace-capacity'
import { introduceAgentToRecipient } from '../services/agent-intro'
import type { AgentStorageManager } from '../services/agent-storage'
import { stopSessionsForActors } from '../services/session-cleanup'
import { startSession } from '../services/session-lifecycle'
import type { SessionManager } from '../services/session-manager'
import { SeedAgentError, provisionWorkspace } from '../services/workspace-bootstrap'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		sessionManager: SessionManager
		agentStorage: AgentStorageManager
		workspaceRole?: string
		maskinSessionId?: string
	}
}

/** Default prompt used when /run is invoked with no explicit action_prompt. */
const DEFAULT_RUN_ACTION_PROMPT = 'Resume your assigned work.'

const RUNNING_SESSION_STATUSES = ['pending', 'starting', 'queued', 'running', 'snapshotting']

/**
 * Event data for an actor mutation. Events are readable by every workspace
 * member (history and SSE return the row unfiltered), so this carries identity
 * only. Never pass an actor row here: it holds tools, llm_config and
 * credentials.
 */
function actorEventData(actor: { id: string; type: string; name: string; isSystem: boolean }) {
	return { id: actor.id, type: actor.type, name: actor.name, is_system: actor.isSystem }
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// POST / - Create actor (signup)
const createActorRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['Actors'],
	summary: 'Create actor (human signup, or an agent created by an authenticated caller)',
	request: {
		body: {
			content: {
				'application/json': {
					schema: createActorSchema,
				},
			},
		},
	},
	responses: {
		201: {
			content: { 'application/json': { schema: actorWithKeySchema } },
			description: 'Actor created',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
		401: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Agent creation without a valid API key',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description:
				'Only a human workspace admin or owner can set tools or llm_config on a new agent',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Workspace not found, or the caller is not a member of it',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor with this ID already exists',
		},
		500: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Internal server error',
		},
	},
})

function isEmailUniqueViolation(err: unknown): boolean {
	for (let cur: unknown = err; cur && typeof cur === 'object'; ) {
		const e = cur as {
			code?: string
			constraint_name?: string
			constraint?: string
			message?: string
			cause?: unknown
		}
		if (e.code === '23505') {
			const name = e.constraint_name ?? e.constraint
			if (name === 'actors_email_unique') return true
			if (typeof e.message === 'string' && e.message.includes('actors_email_unique')) return true
		}
		cur = e.cause
	}
	return false
}

app.openapi(createActorRoute, async (c) => {
	const db = c.get('db')
	const body = c.req.valid('json')

	// Human users must provide email and password
	if (body.type === 'human') {
		if (!body.email) {
			return c.json(
				createApiError('BAD_REQUEST', 'Email is required for human accounts', [
					{ field: 'email', message: 'Required for human accounts' },
				]),
				400,
			)
		}
		if (!body.password) {
			return c.json(
				createApiError('BAD_REQUEST', 'Password is required for human accounts', [
					{ field: 'password', message: 'Required for human accounts' },
				]),
				400,
			)
		}
	}

	if (body.type === 'human' && body.workspace_id) {
		return c.json(
			createApiError('BAD_REQUEST', 'workspace_id is only accepted when creating an agent', [
				{ field: 'workspace_id', message: 'Not accepted for human accounts' },
			]),
			400,
		)
	}

	// Human signup stays open. Creating an agent is done by an authenticated
	// caller, and the new agent is born as a member of a workspace that caller
	// belongs to. This route is on the auth allowlist, so it authenticates the
	// agent branch itself and takes the workspace from the body only (never from
	// X-Workspace-Id): the id is trusted only after it is checked against the key.
	const clientSource = resolveClientSourceTag(c.req.header(CLIENT_SOURCE_HEADER))
	let creatorId: string | undefined
	let creatorType: string | undefined
	let memberWorkspaceId: string | undefined
	if (body.type === 'agent') {
		const refuse = (reason: string, distinctId = 'anonymous', actorType?: string) =>
			void capturePosthogEvent('agent_create_refused', distinctId, {
				reason,
				client_source: clientSource,
				creator_actor_type: actorType,
			})

		const resolved = await resolveBearerCaller(db, c.req.header('Authorization'))
		if (!resolved.ok) {
			refuse('no_key')
			return c.json(
				createApiError(
					'UNAUTHORIZED',
					resolved.reason === 'no_key'
						? 'Creating an agent requires an API key'
						: 'Invalid API key',
					undefined,
					"Send 'Authorization: Bearer ank_…' and the workspace_id the agent should join.",
				),
				401,
			)
		}
		const { actorId: callerId, actorType: callerType } = resolved.caller
		creatorId = callerId
		creatorType = callerType

		const ownWorkspace = body.auto_create_workspace === true
		if (body.workspace_id && ownWorkspace) {
			return c.json(
				createApiError(
					'BAD_REQUEST',
					'Send either workspace_id or auto_create_workspace, not both',
					[{ field: 'workspace_id', message: 'Conflicts with auto_create_workspace' }],
				),
				400,
			)
		}
		if (!body.workspace_id && !ownWorkspace) {
			refuse('missing_workspace', callerId, callerType)
			return c.json(
				createApiError('BAD_REQUEST', 'workspace_id is required to create an agent', [
					{ field: 'workspace_id', message: 'Required unless auto_create_workspace is true' },
				]),
				400,
			)
		}

		if (body.workspace_id) {
			// Same answer as add-member gives a non-member, so existence does not leak.
			const callerRole = await getWorkspaceRole(db, callerId, body.workspace_id)
			if (callerRole === null) {
				refuse('not_member', callerId, callerType)
				return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
			}
			// A viewer is read-only, and a new agent comes with its own key and the
			// member role, so a viewer must not mint one. The gate sits after the
			// membership check: a viewer already knows the workspace exists.
			if (callerRole === 'viewer') {
				refuse('viewer', callerId, callerType)
				return c.json(
					createApiError('FORBIDDEN', 'Viewers have read-only access to this workspace'),
					403,
				)
			}
			// tools and llm_config decide what runs in the agent's sessions and with
			// which credentials, so they are held to the same floor as PATCH: a human
			// admin or owner. Checked before any insert so a refusal writes nothing.
			if (
				(body.tools !== undefined || body.llm_config !== undefined) &&
				!(await isWorkspaceHumanAdminOrOwner(db, callerId, body.workspace_id))
			) {
				refuse('tools_not_admin', callerId, callerType)
				return c.json(
					createApiError(
						'FORBIDDEN',
						'Only workspace admins can set tools or llm_config on a new agent',
					),
					403,
				)
			}
			memberWorkspaceId = body.workspace_id
		}
	}

	// Generate API key
	const { key } = generateApiKey()

	// Hash password if provided
	const passwordHash = body.password ? await hashPassword(body.password) : undefined

	// Agents get the Maskin MCP by default — caller-provided servers win on conflict.
	const tools =
		body.type === 'agent'
			? {
					mcpServers: {
						maskin: PLATFORM_MCP_PRESET,
						...(body.tools?.mcpServers ?? {}),
					},
				}
			: body.tools

	const insertActor = (writer: Database | Transaction) =>
		writer
			.insert(actors)
			.values({
				...(body.id && { id: body.id }),
				type: body.type,
				name: body.name,
				email: body.email,
				apiKey: key,
				passwordHash,
				description: body.description,
				systemPrompt: body.system_prompt,
				tools,
				llmProvider: body.llm_provider,
				llmConfig: body.llm_config,
				createdBy: creatorId,
			})
			.onConflictDoNothing({ target: actors.id })
			.returning()

	let actor: typeof actors.$inferSelect | undefined
	try {
		if (memberWorkspaceId && creatorId) {
			const workspaceId = memberWorkspaceId
			const callerId = creatorId
			// Actor row, membership row and the audit event commit together or not
			// at all, so a failure never leaves an agent outside the workspace.
			actor = await db.transaction(async (tx) => {
				const [inserted] = await insertActor(tx)
				if (!inserted) return undefined
				await tx
					.insert(workspaceMembers)
					.values({ workspaceId, actorId: inserted.id, role: 'member' })
				await recordEvent(tx, {
					workspaceId,
					actorId: callerId,
					action: 'created',
					entityType: 'workspace_member',
					entityId: inserted.id,
					data: { role: 'member', added_actor_id: inserted.id },
				})
				return inserted
			})
		} else {
			;[actor] = await insertActor(db)
		}
	} catch (err) {
		if (isEmailUniqueViolation(err)) {
			return c.json(
				createApiError('CONFLICT', 'Email already exists', [
					{ field: 'email', message: 'An account with this email already exists' },
				]),
				409,
			)
		}
		throw err
	}

	if (!actor) {
		if (body.id) {
			return c.json(createApiError('CONFLICT', 'An actor with this ID already exists'), 409)
		}
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create actor'), 500)
	}

	if (creatorId) {
		void capturePosthogEvent('agent_created', creatorId, {
			agent_id: actor.id,
			workspace_id: memberWorkspaceId,
			creator_actor_type: creatorType,
			client_source: clientSource,
			membership_added: !!memberWorkspaceId,
		})
		if (memberWorkspaceId) {
			void capturePosthogEvent('agent_membership_added', creatorId, {
				agent_id: actor.id,
				workspace_id: memberWorkspaceId,
				role: 'member',
				creator_actor_type: creatorType,
			})
		}
	}

	// The new agent says hello to the person it was made for. Fire and forget,
	// after the commit: the service never throws, so creation is unaffected.
	if (body.type === 'agent' && creatorId && memberWorkspaceId && creatorType) {
		void introduceAgentToRecipient({
			db,
			actor,
			workspaceId: memberWorkspaceId,
			creator: { id: creatorId, type: creatorType },
			claimedSessionId: c.get('maskinSessionId'),
			clientSource,
			hints: { firstSteps: body.first_steps, neededIntegrations: body.needed_integrations },
		})
	}

	// Auto-create personal workspace (default true for humans, false for agents)
	const shouldCreateWorkspace = body.auto_create_workspace ?? body.type === 'human'
	let workspaceId: string | undefined = memberWorkspaceId
	let workspaceProvisioningFailed = false

	if (shouldCreateWorkspace) {
		// Same provisioning path as POST /api/workspaces and the dev bootstrap:
		// full default agent roster, skills, triggers, default loops, pinned chat
		// agent, and the Chief of Staff welcome session.
		//
		// Unlike POST /api/workspaces (which 500s naming the failed agent), signup
		// cannot fail the request: the actor row is already committed above and
		// unretryable — a second attempt with the same email 409s. So it returns
		// 201 with a usable api_key and reports the failure via
		// `workspace_provisioning_failed` instead of leaving the caller to infer
		// it from an absent `workspace_id`.
		let created: Awaited<ReturnType<typeof provisionWorkspace>> = null
		let atOwnershipCap = false
		try {
			created = await provisionWorkspace({
				db,
				agentStorage: c.get('agentStorage'),
				sessionManager: c.get('sessionManager'),
				name: `${body.name}'s Workspace`,
				ownerActorId: actor.id,
				settings: { enabled_modules: ['work', 'crm', 'knowledge'] },
			})
			if (!created) {
				logger.error('signup workspace provisioning returned no workspace row', {
					actorId: actor.id,
				})
			}
		} catch (err) {
			// An actor at their ownership cap is not a provisioning failure — the
			// signup itself succeeded, and the response is shaped exactly like an
			// explicit `auto_create_workspace: false`.
			if (err instanceof OwnershipCapExceededError) {
				atOwnershipCap = true
				logger.warn('Skipping auto-workspace creation: actor at ownership cap', {
					actorId: actor.id,
					effectiveTier: err.effectiveTier,
					used: err.used,
					cap: err.cap,
				})
			} else if (err instanceof SeedAgentError) {
				// Log the seeded-agent detail when we have it, so this failure is as
				// diagnosable as the 500 the workspaces route returns for the same bug.
				logger.error('signup workspace provisioning failed — default agent seed failed', {
					actorId: actor.id,
					agentId: err.agentId,
					errorClass: err.errorClass,
					cause: err.cause instanceof Error ? err.cause.message : String(err.cause),
				})
			} else {
				logger.error('signup workspace provisioning failed', { actorId: actor.id, err })
			}
		}

		if (created) workspaceId = created.id
		else if (!atOwnershipCap) workspaceProvisioningFailed = true
	}

	// Baseline for the invite conversion metric: a human who signs up and lands
	// in their own workspace is a workspace_member_joined with from_invite:false.
	if (workspaceId && actor.type === 'human') {
		void capturePosthogEvent('workspace_member_joined', actor.id, {
			from_invite: false,
			workspace_id: workspaceId,
		})
	}

	// Allowlisted via actorWithKeySchema (see toActorWithKeyResponse) — never
	// spread the raw row here: it carries password_hash.
	return c.json(
		toActorWithKeyResponse(actor, key, {
			...(workspaceId && { workspace_id: workspaceId }),
			...(workspaceProvisioningFailed && { workspace_provisioning_failed: true as const }),
		}),
		201,
	)
})

// Pagination is opt-in: when `limit`/`offset` are absent, the endpoint returns
// every actor (preserving the historical frontend behaviour). When `limit`
// is present, the result is capped at min(limit, 100) and `X-Total-Count`
// surfaces the real total so MCP/widget callers can render an accurate
// `+N more` footer without changing the array body shape.
// Cap the `ids=` filter at 200 entries per request. Sized for the hero-card
// owner-resolution caller (one ID per object in a tool response) plus headroom.
const MAX_IDS_FILTER = 200
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseIdsParam(
	raw: string | undefined,
): { ok: true; ids: string[] | null } | { ok: false } {
	if (raw === undefined || raw === '') return { ok: true, ids: null }
	const seen = new Set<string>()
	for (const part of raw.split(',')) {
		const trimmed = part.trim()
		if (!trimmed) continue
		if (!UUID_RE.test(trimmed)) return { ok: false }
		seen.add(trimmed.toLowerCase())
		if (seen.size > MAX_IDS_FILTER) return { ok: false }
	}
	return { ok: true, ids: [...seen] }
}

const listActorsQuerySchema = z.object({
	limit: z.coerce.number().int().min(1).max(100).optional(),
	offset: z.coerce.number().int().min(0).optional(),
	ids: z
		.string()
		.optional()
		.openapi({
			description: `Comma-separated list of actor UUIDs to filter by. Max ${MAX_IDS_FILTER} entries.`,
			example: '00000000-0000-0000-0000-000000000001,00000000-0000-0000-0000-000000000002',
		}),
	order: z.enum(['asc', 'desc']).optional(),
	// Snapshot-consistent cursor pagination — mirrors `objectQuerySchema`.
	// Only the workspace-scoped branch honours these; the cross-workspace
	// branch uses a two-phase distinct query on `(name, id)` that is
	// intentionally out of scope for keyset pagination.
	snapshot_at: z.string().datetime().optional(),
	cursor_created_at: z.string().datetime().optional(),
	cursor_id: z.string().uuid().optional(),
})

// GET / - List actors
const listActorsRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['Actors'],
	summary: 'List actors',
	request: {
		headers: z.object({
			'x-workspace-id': z.string().uuid().optional(),
		}),
		query: listActorsQuerySchema,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.array(actorListItemSchema) } },
			description: 'List of actors',
			headers: z.object({
				'x-total-count': z
					.string()
					.describe('Total actor count for the scope, ignoring limit/offset'),
			}),
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Invalid request',
		},
	},
})

app.openapi(listActorsRoute, (async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const query = c.req.valid('query')
	const { limit, offset, ids: idsParam } = query

	const parsed = parseIdsParam(idsParam)
	if (!parsed.ok) {
		return c.json(
			createApiError('BAD_REQUEST', `ids must be comma-separated UUIDs (max ${MAX_IDS_FILTER})`),
			400,
		)
	}
	const idsFilter = parsed.ids

	if (idsFilter !== null && idsFilter.length === 0) {
		c.header('X-Total-Count', '0')
		return c.json([] as z.infer<typeof actorListItemSchema>[])
	}

	if (workspaceId) {
		// Workspace-scoped listing
		const idsCondition = idsFilter ? [inArray(actors.id, idsFilter)] : []
		const cursorConditions = buildCreatedAtCursorConditions(
			{ createdAt: actors.createdAt, id: actors.id },
			query,
		)
		const wsWhereParts = [
			eq(workspaceMembers.workspaceId, workspaceId),
			...idsCondition,
			...cursorConditions,
		]
		const wsWhere = wsWhereParts.length > 1 ? and(...wsWhereParts) : wsWhereParts[0]

		if (limit === undefined) {
			const members = await db
				.select({
					id: actors.id,
					type: actors.type,
					name: actors.name,
					email: actors.email,
					description: actors.description,
					isSystem: actors.isSystem,
					agentState: actors.agentState,
					createdAt: actors.createdAt,
					role: workspaceMembers.role,
					voice_enabled: sql<boolean>`COALESCE((${actors.metadata}->>'voice_enabled')::boolean, false)`,
				})
				.from(workspaceMembers)
				.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
				.where(wsWhere)

			c.header('X-Total-Count', String(members.length))
			return c.json(serializeArray(members) as z.infer<typeof actorListItemSchema>[])
		}

		// Under the cursor path the sort switches to (createdAt, id) so the
		// keyset seek predicate agrees with the walk direction. Flag-off
		// callers preserve the historical (name, id) sort.
		const cursorOn = Boolean(query.snapshot_at)
		const orderBy = cursorOn
			? query.order === 'asc'
				? [asc(actors.createdAt), asc(actors.id)]
				: [desc(actors.createdAt), asc(actors.id)]
			: [asc(actors.name), asc(actors.id)]

		// X-Total-Count reflects the workspace's total under the snapshot upper
		// bound so a caller walking pages sees a stable count. The keyset seek
		// is intentionally left out — the header should not shrink as the
		// cursor advances.
		const totalWhereParts = [
			eq(workspaceMembers.workspaceId, workspaceId),
			...idsCondition,
			...(query.snapshot_at
				? buildCreatedAtCursorConditions(
						{ createdAt: actors.createdAt, id: actors.id },
						{ snapshot_at: query.snapshot_at },
					)
				: []),
		]
		const totalWhere = totalWhereParts.length > 1 ? and(...totalWhereParts) : totalWhereParts[0]

		const skipOffset = useKeysetSeek(query)
		const [members, totalRow] = await Promise.all([
			db
				.select({
					id: actors.id,
					type: actors.type,
					name: actors.name,
					email: actors.email,
					description: actors.description,
					isSystem: actors.isSystem,
					agentState: actors.agentState,
					createdAt: actors.createdAt,
					role: workspaceMembers.role,
					voice_enabled: sql<boolean>`COALESCE((${actors.metadata}->>'voice_enabled')::boolean, false)`,
				})
				.from(workspaceMembers)
				.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
				.where(wsWhere)
				.orderBy(...orderBy)
				.limit(limit)
				.offset(skipOffset ? 0 : (offset ?? 0)),
			db
				.select({ value: count() })
				.from(workspaceMembers)
				.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
				.where(totalWhere),
		])

		c.header('X-Total-Count', String(totalRow[0]?.value ?? 0))
		return c.json(serializeArray(members) as z.infer<typeof actorListItemSchema>[])
	}

	// List actors across all workspaces the authenticated actor belongs to
	const actorId = c.get('actorId')

	const myWorkspaces = await db
		.select({ workspaceId: workspaceMembers.workspaceId })
		.from(workspaceMembers)
		.where(eq(workspaceMembers.actorId, actorId))

	const workspaceIds = myWorkspaces.map((w) => w.workspaceId)
	if (workspaceIds.length === 0) {
		c.header('X-Total-Count', '0')
		return c.json([] as z.infer<typeof actorListItemSchema>[])
	}

	const baseQuery = () =>
		db
			.select({
				id: actors.id,
				type: actors.type,
				name: actors.name,
				email: actors.email,
				description: actors.description,
				isSystem: actors.isSystem,
				agentState: actors.agentState,
				createdAt: actors.createdAt,
				workspaceId: workspaces.id,
				workspaceName: workspaces.name,
				role: workspaceMembers.role,
				voice_enabled: sql<boolean>`COALESCE((${actors.metadata}->>'voice_enabled')::boolean, false)`,
			})
			.from(workspaceMembers)
			.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
			.innerJoin(workspaces, eq(workspaceMembers.workspaceId, workspaces.id))

	const crossWhere = idsFilter
		? and(inArray(workspaceMembers.workspaceId, workspaceIds), inArray(actors.id, idsFilter))
		: inArray(workspaceMembers.workspaceId, workspaceIds)

	if (limit === undefined) {
		const rows = await baseQuery()
			.where(crossWhere)
			.orderBy(asc(actors.name), asc(actors.id), asc(workspaces.name), asc(workspaces.id))
		const grouped = groupActorMemberships(rows)
		c.header('X-Total-Count', String(grouped.length))
		return c.json(serializeArray(grouped) as z.infer<typeof actorListItemSchema>[])
	}

	// Two phases: (1) count + pick paginated set of distinct actor IDs ordered
	// by name, then (2) fetch all membership rows for that set and group in
	// JS. This keeps a hard cap on rows transferred even when an actor sits in
	// many workspaces, and keeps `X-Total-Count` exact regardless of fan-out.
	const [totalRow, pageActorRows] = await Promise.all([
		db
			.select({ value: countDistinct(actors.id) })
			.from(workspaceMembers)
			.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
			.where(crossWhere),
		db
			.selectDistinct({ id: actors.id, name: actors.name })
			.from(workspaceMembers)
			.innerJoin(actors, eq(workspaceMembers.actorId, actors.id))
			.where(crossWhere)
			.orderBy(asc(actors.name), asc(actors.id))
			.limit(limit)
			.offset(offset ?? 0),
	])

	const pageActorIds = pageActorRows.map((r) => r.id)
	if (pageActorIds.length === 0) {
		c.header('X-Total-Count', String(totalRow[0]?.value ?? 0))
		return c.json([] as z.infer<typeof actorListItemSchema>[])
	}

	const rows = await baseQuery()
		.where(
			and(inArray(workspaceMembers.workspaceId, workspaceIds), inArray(actors.id, pageActorIds)),
		)
		.orderBy(asc(actors.name), asc(actors.id), asc(workspaces.name), asc(workspaces.id))

	c.header('X-Total-Count', String(totalRow[0]?.value ?? 0))
	return c.json(
		serializeArray(groupActorMemberships(rows)) as z.infer<typeof actorListItemSchema>[],
	)
}) as RouteHandler<typeof listActorsRoute, Env>)

interface ActorMembershipRow {
	id: string
	type: string
	name: string
	email: string | null
	description: string | null
	isSystem: boolean
	agentState: AgentState
	createdAt: Date | null
	workspaceId: string
	workspaceName: string
	role: string
	voice_enabled: boolean
}

function groupActorMemberships(rows: ActorMembershipRow[]): Array<{
	id: string
	type: string
	name: string
	email: string | null
	description: string | null
	isSystem: boolean
	agentState: AgentState
	createdAt: Date | null
	voice_enabled: boolean
	workspaces: { id: string; name: string; role: string }[]
}> {
	const byActor = new Map<
		string,
		{
			id: string
			type: string
			name: string
			email: string | null
			description: string | null
			isSystem: boolean
			agentState: AgentState
			createdAt: Date | null
			voice_enabled: boolean
			workspaces: { id: string; name: string; role: string }[]
		}
	>()
	for (const r of rows) {
		const membership = { id: r.workspaceId, name: r.workspaceName, role: r.role }
		const existing = byActor.get(r.id)
		if (existing) {
			existing.workspaces.push(membership)
		} else {
			byActor.set(r.id, {
				id: r.id,
				type: r.type,
				name: r.name,
				email: r.email,
				description: r.description,
				isSystem: r.isSystem,
				agentState: r.agentState,
				createdAt: r.createdAt,
				voice_enabled: r.voice_enabled,
				workspaces: [membership],
			})
		}
	}
	return [...byActor.values()]
}

// GET /:id - Get actor by ID
const getActorRoute = createRoute({
	method: 'get',
	path: '/{id}',
	tags: ['Actors'],
	summary: 'Get actor by ID',
	request: {
		params: idParamSchema,
		headers: z.object({
			'x-workspace-id': z
				.string()
				.uuid()
				.optional()
				.describe("When provided, the response includes the actor's `role` in this workspace."),
		}),
	},
	responses: {
		200: {
			content: { 'application/json': { schema: actorResponseSchema } },
			description: 'Actor found',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found',
		},
	},
})

app.openapi(getActorRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	if (!(await actorsShareWorkspace(db, actorId, id, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	const [[actor], skills, [membership]] = await Promise.all([
		db
			.select({
				id: actors.id,
				type: actors.type,
				name: actors.name,
				email: actors.email,
				description: actors.description,
				system_prompt: actors.systemPrompt,
				tools: actors.tools,
				memory: actors.memory,
				llm_provider: actors.llmProvider,
				llm_config: actors.llmConfig,
				isSystem: actors.isSystem,
				agentState: actors.agentState,
				agentStateUpdatedAt: actors.agentStateUpdatedAt,
				createdAt: actors.createdAt,
				updatedAt: actors.updatedAt,
				installedLoopId: sql<string | null>`${actors.metadata}->>'installed_loop_id'`,
				voice_enabled: sql<boolean>`COALESCE((${actors.metadata}->>'voice_enabled')::boolean, false)`,
			})
			.from(actors)
			.where(eq(actors.id, id))
			.limit(1),
		db
			.select({ id: workspaceSkills.id, name: workspaceSkills.name })
			.from(agentSkills)
			.innerJoin(workspaceSkills, eq(agentSkills.workspaceSkillId, workspaceSkills.id))
			.where(eq(agentSkills.actorId, id)),
		workspaceId
			? db
					.select({ role: workspaceMembers.role })
					.from(workspaceMembers)
					.where(
						and(eq(workspaceMembers.actorId, id), eq(workspaceMembers.workspaceId, workspaceId)),
					)
					.limit(1)
			: Promise.resolve([]),
	])

	if (!actor) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	const role = workspaceId ? (membership?.role ?? null) : undefined
	const tools = await redactActorToolsForCaller(db, c.get('actorId'), id, actor.tools)
	return c.json(
		serialize({
			...actor,
			tools,
			llm_config: maskLlmConfigSecrets(actor.llm_config),
			skills,
			role,
		}) as z.infer<typeof actorResponseSchema>,
	)
}) as RouteHandler<typeof getActorRoute, Env>)

// GET /:id/access - What this actor can use: integrations and saved credentials
//
// The same description the launch prompt is built from, so the agent page, get_actor and a
// running session never disagree. Read-only; changes go through the integration grants routes.
const actorAccessRoute = createRoute({
	method: 'get',
	path: '/{id}/access',
	tags: ['Actors'],
	summary: 'What an actor can use: integrations (level, server attached) and saved credentials',
	request: {
		params: idParamSchema,
		headers: z.object({ 'x-workspace-id': z.string().uuid() }),
	},
	responses: {
		200: {
			content: {
				'application/json': {
					schema: z.object({
						integrations: z.array(
							z.object({
								integration_id: z.string().uuid(),
								provider: z.string(),
								name: z.string(),
								access: z.enum(['none', 'read', 'read_write']),
								source: z.enum(['grant', 'default']),
								default_access: z.enum(['read', 'read_write', 'none']),
								server_attached: z.boolean(),
								created_by: z.string().uuid(),
							}),
						),
						credentials: z.array(
							z.object({
								integration_id: z.string().uuid(),
								name: z.string(),
								kind: z.enum(['api_key', 'login']),
								has_access: z.boolean(),
								default_access: z.enum(['read', 'none']),
								scope: z.enum(['always', 'this_chat']).nullable(),
								chat_count: z.number().int(),
								created_by: z.string().uuid(),
							}),
						),
					}),
				},
			},
			description: 'Access by integration and credential',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found',
		},
	},
})

app.openapi(actorAccessRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	if (!(await actorsShareWorkspace(db, callerId, id, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}
	return c.json(await describeAgentAccess(db, workspaceId, id), 200)
}) as RouteHandler<typeof actorAccessRoute, Env>)

// PATCH /:id - Update actor
const updateActorRoute = createRoute({
	method: 'patch',
	path: '/{id}',
	'x-viewer-policy': 'writer',
	tags: ['Actors'],
	summary: 'Update actor',
	request: {
		params: idParamSchema,
		headers: z.object({
			'x-workspace-id': z.string().uuid().optional(),
		}),
		body: {
			content: {
				'application/json': {
					schema: updateActorSchema,
				},
			},
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: actorResponseSchema } },
			description: 'Actor updated',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Masked tool config value with no stored value to keep',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Caller may not update this actor',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found',
		},
	},
})

app.openapi(updateActorRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json')

	const [existing] = await db
		.select({ type: actors.type, tools: actors.tools, llmConfig: actors.llmConfig })
		.from(actors)
		.where(eq(actors.id, id))
		.limit(1)

	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	if (existing.type === 'agent' && !(await actorsShareWorkspace(db, actorId, id, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	if (existing.type === 'human' && id !== actorId) {
		if (!workspaceId) {
			return c.json(createApiError('FORBIDDEN', 'Workspace context is required'), 403)
		}

		const [callerMembership] = await db
			.select({ role: workspaceMembers.role })
			.from(workspaceMembers)
			.where(
				and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.actorId, actorId)),
			)
			.limit(1)

		if (!callerMembership || !['owner', 'admin'].includes(callerMembership.role)) {
			return c.json(createApiError('FORBIDDEN', 'Only workspace admins can update humans'), 403)
		}

		if (!(await isWorkspaceMember(db, id, workspaceId))) {
			return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
		}
	}

	// tools and llm_config decide what runs in the agent's sessions and with
	// which credentials, so changing another actor's needs owner/admin.
	// Prompt, description, name and memory stay open to workspace members.
	if (
		(body.tools !== undefined || body.llm_config !== undefined) &&
		id !== actorId &&
		!(await isAdminOfSharedWorkspace(db, actorId, id, workspaceId))
	) {
		return c.json(
			createApiError(
				'FORBIDDEN',
				"Only workspace admins can change another actor's tools or llm_config",
			),
			403,
		)
	}

	// A default workspace is a personal preference: only the actor itself may set
	// it, and only to a workspace it belongs to (null clears it).
	if (body.default_workspace_id !== undefined) {
		if (id !== actorId) {
			return c.json(
				createApiError('FORBIDDEN', 'Only an actor can change its own default workspace'),
				403,
			)
		}
		if (
			body.default_workspace_id !== null &&
			!(await isWorkspaceMember(db, id, body.default_workspace_id))
		) {
			return c.json(
				createApiError('BAD_REQUEST', 'You are not a member of that workspace', [
					{ field: 'default_workspace_id', message: 'Not a member of this workspace' },
				]),
				400,
			)
		}
	}

	// A viewer is read-only, but the default workspace is the caller's own preference
	// (the settings toggle), not workspace data, so a body of only that key stays open.
	if (Object.keys(body).some((key) => key !== 'default_workspace_id')) {
		await assertActorWriterAccess(db, actorId, id, workspaceId, c.get('workspaceRole'))
	}

	// A config read back masked must not overwrite the stored secrets with the mask.
	let tools = body.tools
	if (tools !== undefined) {
		const restored = restoreMaskedToolValues(tools, existing.tools)
		if (restored.unresolved.length > 0) {
			return c.json(
				createApiError(
					'BAD_REQUEST',
					'Masked tool config values have no stored value to keep; send the real value or leave the entry unchanged',
					restored.unresolved.map((field) => ({
						field: `tools.mcpServers.${field}`,
						message: 'Masked value cannot be saved',
					})),
				),
				400,
			)
		}
		tools = restored.tools as typeof tools
	}

	// Same for llm_config: its api key is read back masked.
	let llmConfig = body.llm_config
	if (llmConfig !== undefined) {
		const restored = restoreMaskedLlmConfig(llmConfig, existing.llmConfig)
		if (restored.unresolved.length > 0) {
			return c.json(
				createApiError(
					'BAD_REQUEST',
					'Masked llm_config values have no stored value to keep; send the real value or leave the entry unchanged',
					restored.unresolved.map((field) => ({
						field,
						message: 'Masked value cannot be saved',
					})),
				),
				400,
			)
		}
		llmConfig = restored.llmConfig as typeof llmConfig
	}

	const [updated] = await db
		.update(actors)
		.set({
			...(body.name && { name: body.name }),
			...(body.email && { email: body.email }),
			...(body.description !== undefined && { description: body.description }),
			...(body.system_prompt !== undefined && { systemPrompt: body.system_prompt }),
			...(tools !== undefined && { tools }),
			...(body.memory !== undefined && { memory: body.memory }),
			...(body.llm_provider !== undefined && { llmProvider: body.llm_provider }),
			...(llmConfig !== undefined && { llmConfig }),
			...(body.default_workspace_id !== undefined && {
				defaultWorkspaceId: body.default_workspace_id,
			}),
			updatedAt: new Date(),
		})
		.where(eq(actors.id, id))
		.returning({
			id: actors.id,
			type: actors.type,
			name: actors.name,
			email: actors.email,
			description: actors.description,
			system_prompt: actors.systemPrompt,
			tools: actors.tools,
			memory: actors.memory,
			llm_provider: actors.llmProvider,
			llm_config: actors.llmConfig,
			isSystem: actors.isSystem,
			agentState: actors.agentState,
			agentStateUpdatedAt: actors.agentStateUpdatedAt,
			createdAt: actors.createdAt,
			updatedAt: actors.updatedAt,
			voice_enabled: sql<boolean>`COALESCE((${actors.metadata}->>'voice_enabled')::boolean, false)`,
			default_workspace_id: actors.defaultWorkspaceId,
		})

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	updated.tools = await redactActorToolsForCaller(db, actorId, id, updated.tools)
	updated.llm_config = maskLlmConfigSecrets(updated.llm_config)
	return c.json(serialize(updated) as z.infer<typeof actorResponseSchema>)
}) as RouteHandler<typeof updateActorRoute, Env>)

// POST /:id/api-keys - Regenerate API key
const regenerateApiKeyRoute = createRoute({
	method: 'post',
	path: '/{id}/api-keys',
	'x-viewer-policy': 'writer',
	tags: ['Actors'],
	summary: 'Regenerate API key',
	request: {
		params: idParamSchema,
		headers: z.object({
			'x-workspace-id': z.string().uuid().optional(),
		}),
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.object({ api_key: z.string() }) } },
			description: 'API key regenerated',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Caller is not this actor',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found',
		},
	},
})

app.openapi(regenerateApiKeyRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	if (id !== actorId) {
		return c.json(createApiError('FORBIDDEN', 'Not allowed'), 403)
	}

	await assertActorWriterAccess(db, actorId, id, workspaceId, c.get('workspaceRole'))

	const { key } = generateApiKey()

	const [updated] = await db
		.update(actors)
		.set({ apiKey: key, updatedAt: new Date() })
		.where(eq(actors.id, id))
		.returning({ id: actors.id })

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	// The old key must stop authenticating now, not when its cached lookup expires.
	evictActor(id)

	return c.json({ api_key: key })
}) as RouteHandler<typeof regenerateApiKeyRoute, Env>)

// POST /:id/reset - Reset system actor to factory defaults (Workspace Coach)
const resetActorRoute = createRoute({
	method: 'post',
	path: '/{id}/reset',
	'x-viewer-policy': 'writer',
	tags: ['Actors'],
	summary: 'Reset system actor to factory defaults',
	request: {
		params: idParamSchema,
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: actorResponseSchema } },
			description: 'Actor reset to defaults',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor is not a system actor',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found',
		},
	},
})

app.openapi(resetActorRoute, (async (c) => {
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	const [existing] = await db.select().from(actors).where(eq(actors.id, id)).limit(1)

	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	if (!(await isWorkspaceMember(db, id, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	if (!existing.isSystem) {
		return c.json(createApiError('FORBIDDEN', 'Only system actors can be reset to defaults'), 403)
	}

	const [updated] = await db
		.update(actors)
		.set({
			name: WORKSPACE_COACH_DEFAULT.name,
			description: null,
			systemPrompt: WORKSPACE_COACH_DEFAULT.systemPrompt,
			llmProvider: WORKSPACE_COACH_DEFAULT.llmProvider,
			llmConfig: WORKSPACE_COACH_DEFAULT.llmConfig,
			tools: WORKSPACE_COACH_DEFAULT.tools,
			memory: null,
			updatedAt: new Date(),
		})
		.where(eq(actors.id, id))
		.returning({
			id: actors.id,
			type: actors.type,
			name: actors.name,
			email: actors.email,
			description: actors.description,
			system_prompt: actors.systemPrompt,
			tools: actors.tools,
			memory: actors.memory,
			llm_provider: actors.llmProvider,
			llm_config: actors.llmConfig,
			isSystem: actors.isSystem,
			agentState: actors.agentState,
			agentStateUpdatedAt: actors.agentStateUpdatedAt,
			updatedAt: actors.updatedAt,
			voice_enabled: sql<boolean>`COALESCE((${actors.metadata}->>'voice_enabled')::boolean, false)`,
		})

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	await recordEvent(db, {
		workspaceId,
		actorId,
		action: 'reset',
		entityType: 'actor',
		entityId: id,
		data: actorEventData(updated),
	})

	updated.llm_config = maskLlmConfigSecrets(updated.llm_config)
	return c.json(serialize(updated) as z.infer<typeof actorResponseSchema>)
}) as RouteHandler<typeof resetActorRoute, Env>)

// DELETE /:id - Delete actor (agents only)
const deleteActorRoute = createRoute({
	method: 'delete',
	path: '/{id}',
	'x-viewer-policy': 'writer',
	tags: ['Actors'],
	summary: 'Delete actor (agents only)',
	request: {
		params: idParamSchema,
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: z.object({ deleted: z.boolean() }) } },
			description: 'Actor deleted',
		},
		403: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Cannot delete human actors',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found',
		},
		500: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Agent files could not be removed from storage; the agent was not deleted',
		},
	},
})

app.openapi(deleteActorRoute, (async (c) => {
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	const [existing] = await db.select().from(actors).where(eq(actors.id, id)).limit(1)

	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	if (!(await isWorkspaceMember(db, id, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	if (existing.isSystem) {
		return c.json(createApiError('FORBIDDEN', 'System agents cannot be deleted'), 403)
	}

	if (existing.type !== 'agent') {
		return c.json(createApiError('FORBIDDEN', 'Only agent actors can be deleted'), 403)
	}

	// Stop before delete. The cascade below removes this actor's session rows,
	// but a sandbox already running on an agent-server keeps executing as an
	// agent the user believes they just deleted, keeps holding its capacity
	// slot until the 2h timeout, and keeps POSTing logs against a session_id
	// that no longer exists. Best-effort and outside the transaction — see
	// stopSessionsForActors.
	await stopSessionsForActors(db, c.get('sessionManager'), [id], c.get('actorId'))

	// Remove the agent's S3 folder before the DB rows. POST /actors accepts a
	// caller-supplied id, so objects left behind would be pulled into a later
	// agent created with the same id. Doing it first means a storage failure
	// returns an error while the actor still exists and the delete can be retried;
	// after the actor row is gone a retry would 404 and strand the objects.
	try {
		await c.get('agentStorage').deleteAllAgentFiles(id, workspaceId)
	} catch (err) {
		logger.error('Agent delete aborted: could not remove agent files from storage', {
			actorId: id,
			workspaceId,
			error: String(err),
		})
		return c.json(
			createApiError(
				'INTERNAL_ERROR',
				'Could not delete agent files from storage; agent not deleted',
			),
			500,
		)
	}

	await db.transaction(async (tx) => {
		// Delete session logs for sessions owned by this actor
		const actorSessions = await tx
			.select({ id: sessions.id })
			.from(sessions)
			.where(eq(sessions.actorId, id))
		const sessionIds = actorSessions.map((s) => s.id)
		if (sessionIds.length > 0) {
			await tx.delete(sessionLogs).where(inArray(sessionLogs.sessionId, sessionIds))
		}
		await tx.delete(sessions).where(eq(sessions.actorId, id))
		// Sessions this agent kicked off for other actors still exist; reassign
		// the creator so the sessions.created_by FK doesn't block the delete.
		await tx.update(sessions).set({ createdBy: actorId }).where(eq(sessions.createdBy, id))

		// Delete triggers targeting or created by this actor
		await tx.delete(triggers).where(or(eq(triggers.targetActorId, id), eq(triggers.createdBy, id)))

		// Delete agent files
		await tx.delete(agentFiles).where(eq(agentFiles.actorId, id))

		// Delete notifications
		await tx
			.delete(notifications)
			.where(or(eq(notifications.sourceActorId, id), eq(notifications.targetActorId, id)))

		// Delete events
		await tx.delete(events).where(eq(events.actorId, id))

		// Delete relationships
		await tx.delete(relationships).where(eq(relationships.createdBy, id))

		// Delete per-actor feed bookkeeping
		await tx.delete(subscriptions).where(eq(subscriptions.actorId, id))
		await tx.delete(readState).where(eq(readState.actorId, id))

		// Delete orphan-thread-detection ledger rows expecting a reply from this actor
		await tx
			.delete(orphanThreadDetections)
			.where(eq(orphanThreadDetections.expectedReplyActorId, id))

		// conversation_participants.actor_id/added_by are RESTRICT FKs to
		// actors.id with no cascade — null out added_by on surviving rows,
		// then drop this actor's own participant rows.
		await tx
			.update(conversationParticipants)
			.set({ addedBy: null })
			.where(eq(conversationParticipants.addedBy, id))
		await tx.delete(conversationParticipants).where(eq(conversationParticipants.actorId, id))

		// Reassign objects
		await tx.update(objects).set({ driver: null }).where(eq(objects.driver, id))
		await tx.update(objects).set({ createdBy: actorId }).where(eq(objects.createdBy, id))

		// Reassign workspace artifacts authored by this agent
		await tx.update(files).set({ createdBy: actorId }).where(eq(files.createdBy, id))
		await tx.update(imports).set({ createdBy: actorId }).where(eq(imports.createdBy, id))
		// messages.actor_id is NOT NULL with no cascade — reassign authorship
		// to the deleting actor rather than deleting message history.
		await tx.update(messages).set({ actorId }).where(eq(messages.actorId, id))
		await tx
			.update(workspaceSkills)
			.set({ createdBy: null })
			.where(eq(workspaceSkills.createdBy, id))

		// Clean up workspace references
		await tx.delete(workspaceMembers).where(eq(workspaceMembers.actorId, id))
		await tx.update(workspaces).set({ createdBy: null }).where(eq(workspaces.createdBy, id))
		await tx.update(integrations).set({ createdBy: actorId }).where(eq(integrations.createdBy, id))

		// Clean up self-references and delete
		await tx.update(actors).set({ createdBy: null }).where(eq(actors.createdBy, id))
		await tx.delete(actors).where(eq(actors.id, id))
	})
	evictActor(id)

	await recordEvent(db, {
		workspaceId,
		actorId,
		action: 'deleted',
		entityType: 'agent',
		entityId: id,
		data: actorEventData(existing),
	})

	return c.json({ deleted: true })
}) as RouteHandler<typeof deleteActorRoute, Env>)

// Returning shape used by /pause, /run, and /voice-mode handlers — full actor
// row. voice_enabled is projected off the metadata JSONB so the wire shape
// stays flat and callers never reach into raw metadata.
const actorReturningCols = {
	id: actors.id,
	type: actors.type,
	name: actors.name,
	email: actors.email,
	description: actors.description,
	system_prompt: actors.systemPrompt,
	tools: actors.tools,
	memory: actors.memory,
	llm_provider: actors.llmProvider,
	llm_config: actors.llmConfig,
	isSystem: actors.isSystem,
	agentState: actors.agentState,
	agentStateUpdatedAt: actors.agentStateUpdatedAt,
	createdAt: actors.createdAt,
	updatedAt: actors.updatedAt,
	voice_enabled: sql<boolean>`COALESCE((${actors.metadata}->>'voice_enabled')::boolean, false)`,
} as const

// POST /:id/pause - Pause an agent (and any in-flight session for it)
const pauseAgentRoute = createRoute({
	method: 'post',
	path: '/{id}/pause',
	'x-viewer-policy': 'writer',
	tags: ['Actors'],
	summary: 'Pause an agent and any in-flight session',
	description:
		'Sets the agent to a paused state. If the agent has a session in `running` state, that session is paused (snapshotted) too.',
	request: {
		params: idParamSchema,
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			content: { 'application/json': { schema: actorResponseSchema } },
			description: 'Agent paused',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Cannot pause agent',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found in workspace',
		},
	},
})

app.openapi(pauseAgentRoute, (async (c) => {
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	const [existing] = await db.select().from(actors).where(eq(actors.id, id)).limit(1)
	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	// Verify workspace membership before leaking anything about the actor (e.g.
	// its type), so a member of one workspace can't probe actors in another.
	if (!(await isWorkspaceMember(db, id, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	if (existing.type !== 'agent') {
		return c.json(createApiError('BAD_REQUEST', 'Actor is not an agent'), 400)
	}

	// Pause any currently-running session for this agent. Only `running`
	// sessions can be snapshotted — sessions in pending/starting/queued are
	// stopped instead so we don't leave orphaned containers behind.
	const liveSessions = await db
		.select()
		.from(sessions)
		.where(
			and(
				eq(sessions.actorId, id),
				eq(sessions.workspaceId, workspaceId),
				inArray(sessions.status, RUNNING_SESSION_STATUSES),
			),
		)
		.orderBy(desc(sessions.createdAt))

	const failedSessionIds: string[] = []
	for (const s of liveSessions) {
		try {
			if (s.status === 'running') {
				await sessionManager.pauseSession(s.id)
			} else {
				await sessionManager.stopSession(s.id)
			}
		} catch (err) {
			failedSessionIds.push(s.id)
			logger.warn('Failed to pause/stop session during agent pause', {
				sessionId: s.id,
				error: err instanceof Error ? err.message : String(err),
			})
		}
	}

	const [updated] = await db
		.update(actors)
		.set({
			agentState: 'paused',
			agentStateUpdatedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(actors.id, id))
		.returning(actorReturningCols)

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	await recordEvent(db, {
		workspaceId,
		actorId,
		action: 'agent_paused',
		entityType: 'actor',
		entityId: id,
		data: {
			paused_session_ids: liveSessions.map((s) => s.id),
			failed_session_ids: failedSessionIds,
		},
	})

	const tools = await redactActorToolsForCaller(db, actorId, id, updated.tools)
	return c.json(
		serialize({
			...updated,
			tools,
			llm_config: maskLlmConfigSecrets(updated.llm_config),
		}) as z.infer<typeof actorResponseSchema>,
	)
}) as RouteHandler<typeof pauseAgentRoute, Env>)

// POST /:id/run - Resume a paused agent OR start a fresh session
const runAgentBodySchema = z
	.object({
		action_prompt: z.string().min(1).optional(),
	})
	.optional()

const runAgentRoute = createRoute({
	method: 'post',
	path: '/{id}/run',
	'x-viewer-policy': 'writer',
	tags: ['Actors'],
	summary: 'Run an agent — resume paused session or start a fresh one',
	description:
		'If the agent has a paused session, it is resumed. Otherwise a fresh session is started using the provided action_prompt (or a default).',
	request: {
		params: idParamSchema,
		headers: workspaceIdHeader,
		body: {
			content: { 'application/json': { schema: runAgentBodySchema } },
			required: false,
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: actorResponseSchema } },
			description: 'Agent running',
		},
		400: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Cannot run agent',
		},
		404: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Actor not found in workspace',
		},
	},
})

app.openapi(runAgentRoute, (async (c) => {
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const db = c.get('db')
	const sessionManager = c.get('sessionManager')
	const actorId = c.get('actorId')
	const { id } = c.req.valid('param')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const body = c.req.valid('json') ?? {}

	if (!(await isWorkspaceMember(db, actorId, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	const [existing] = await db.select().from(actors).where(eq(actors.id, id)).limit(1)
	if (!existing) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	// Verify workspace membership before leaking anything about the actor (e.g.
	// its type), so a member of one workspace can't probe actors in another.
	if (!(await isWorkspaceMember(db, id, workspaceId))) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	if (existing.type !== 'agent') {
		return c.json(createApiError('BAD_REQUEST', 'Actor is not an agent'), 400)
	}

	// If there's already a live session, the agent is effectively running —
	// no-op the start logic and just sync the state field.
	const [liveSession] = await db
		.select()
		.from(sessions)
		.where(
			and(
				eq(sessions.actorId, id),
				eq(sessions.workspaceId, workspaceId),
				inArray(sessions.status, RUNNING_SESSION_STATUSES),
			),
		)
		.orderBy(desc(sessions.createdAt))
		.limit(1)

	if (!liveSession) {
		// Prefer resuming the most recent paused session over creating a new one,
		// so users don't lose context that was snapshotted on Pause.
		const [pausedSession] = await db
			.select()
			.from(sessions)
			.where(
				and(
					eq(sessions.actorId, id),
					eq(sessions.workspaceId, workspaceId),
					eq(sessions.status, 'paused'),
				),
			)
			.orderBy(desc(sessions.createdAt))
			.limit(1)

		try {
			if (pausedSession) {
				await sessionManager.resumeSession(pausedSession.id)
			} else {
				await startSession({
					workspaceId,
					actorId: id,
					callerKind: 'rest',
					actionPrompt: body.action_prompt ?? DEFAULT_RUN_ACTION_PROMPT,
					createdBy: actorId,
					// Ad-hoc actor run: no originating object.
					initiatedFromObjectId: null,
					await: 'none',
				})
			}
		} catch (err) {
			// A plan-cap rejection is not a bad request — flattening it to a 400
			// with a bare message string dropped the `PLAN_CAP_EXCEEDED` code and
			// the plan/used/cap context, so the client could only show the raw
			// text instead of a typed upgrade CTA. Re-throw and let app-factory's
			// onError emit the same structured 402 that POST /api/sessions does.
			if (err instanceof PlanCapExceededError) throw err
			const message = err instanceof Error ? err.message : String(err)
			return c.json(createApiError('BAD_REQUEST', message), 400)
		}
	}

	const [updated] = await db
		.update(actors)
		.set({
			agentState: 'running',
			agentStateUpdatedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(actors.id, id))
		.returning(actorReturningCols)

	if (!updated) {
		return c.json(createApiError('NOT_FOUND', 'Actor not found'), 404)
	}

	await recordEvent(db, {
		workspaceId,
		actorId,
		action: 'agent_run',
		entityType: 'actor',
		entityId: id,
		data: {},
	})

	const tools = await redactActorToolsForCaller(db, actorId, id, updated.tools)
	return c.json(
		serialize({
			...updated,
			tools,
			llm_config: maskLlmConfigSecrets(updated.llm_config),
		}) as z.infer<typeof actorResponseSchema>,
	)
}) as RouteHandler<typeof runAgentRoute, Env>)

export default app
