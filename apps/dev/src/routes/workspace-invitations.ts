import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import { generateApiKey, hashPassword, validateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	workspaceInvitations,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import { sendInviteEmail } from '@maskin/email'
import { and, count, desc, eq, gt, lte, min, sql } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { isEnterpriseActor } from '../lib/enterprise'
import { createApiError, formatZodError, validationFailureHook } from '../lib/errors'
import { takeInvitePreviewToken } from '../lib/invite-preview-throttle'
import { generateInviteToken, hashInviteToken } from '../lib/invites-token'
import { logger } from '../lib/logger'
import { errorSchema, idParamSchema } from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import { extractClientIp } from '../lib/trusted-proxy'
import { isWorkspaceHumanAdminOrOwner, isWorkspaceMember } from '../lib/workspace-auth'
import {
	SeatCapExceededError,
	countHumanMembers,
	resolvePlanTier,
	seatCapErrorBody,
	seatCapForPlan,
} from '../lib/workspace-capacity'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

// ─── Shared schemas ────────────────────────────────────────────────────────

// Accept body: both branches (new-signup + authenticated-accept) route through
// this endpoint. All fields optional at the schema layer; the handler dispatches
// on presence of `email` + `password`. An empty body means authenticated-accept
// (requires `Authorization: Bearer …`).
const acceptBodySchema = z.object({
	email: z.string().email().optional(),
	password: z.string().min(8).optional(),
	name: z.string().min(1).max(200).optional(),
})

const actorResponseInAcceptSchema = z.object({
	id: z.string().uuid(),
	type: z.string(),
	name: z.string(),
	email: z.string().nullable(),
	description: z.string().nullable(),
	system_prompt: z.string().nullable(),
	tools: z.unknown().nullable(),
	memory: z.unknown().nullable(),
	llm_provider: z.string().nullable(),
	llm_config: z.unknown().nullable(),
	isSystem: z.boolean(),
	agentState: z.string(),
	agentStateUpdatedAt: z.string().nullable(),
	createdAt: z.string().nullable(),
	updatedAt: z.string().nullable(),
	api_key: z.string(),
})

const previewResponseSchema = z.object({
	status: z.literal('pending'),
	workspaceId: z.string().uuid(),
	workspaceName: z.string(),
	inviterName: z.string(),
	inviteEmail: z.string(),
	expiresAt: z.string(),
})

const previewErrorSchema = z.object({
	status: z.string(),
})

// ─── Helpers ───────────────────────────────────────────────────────────────

function isInviteExpired(invite: { expiresAt: Date; status: string }): boolean {
	return invite.status !== 'pending' || invite.expiresAt.getTime() <= Date.now()
}

function stripActorSecretsForResponse(
	actor: typeof actors.$inferSelect,
): z.infer<typeof actorResponseInAcceptSchema> {
	const {
		apiKey,
		passwordHash: _passwordHash,
		systemPrompt,
		llmProvider,
		llmConfig,
		...rest
	} = actor
	return {
		...serialize(rest),
		system_prompt: systemPrompt,
		llm_provider: llmProvider,
		llm_config: llmConfig,
		api_key: apiKey ?? '',
	} as z.infer<typeof actorResponseInAcceptSchema>
}

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

// ─── POST /:token/accept ───────────────────────────────────────────────────
// SECURITY: this endpoint is mounted OUTSIDE the standard `Bearer ank_…` +
// `X-Workspace-Id` membership middleware in `packages/auth/src/middleware.ts`
// (see the allowlist in `apps/dev/src/app-factory.ts`), because the invitee
// has no membership yet. It reads `Authorization` itself for the
// authenticated-accept branch. The frontend MUST NOT send `X-Workspace-Id` on
// this call — a rogue X-Workspace-Id would be ignored by the carve-out, but
// including it is a smell that the frontend still thinks this is a member
// route. Same shape as `POST /login` in `apps/dev/src/routes/auth.ts`.

// Registered as a plain app.post() rather than app.openapi() because the
// endpoint accepts BOTH `{email, password, name?}` (new-signup) AND an empty
// body (authenticated-accept) on the same URL. Hono's OpenAPI body-validation
// treats a missing body as a validation failure even with `required: false`,
// which would 400 every authenticated-accept call. The OpenAPI documentation
// lives on the sibling endpoints in this file (and T2's endpoints in the same
// file) — the accept endpoint's contract is documented in the code comment
// below and in the parent bet's shaping doc.

app.post('/:token/accept', async (c) => {
	const db = c.get('db')
	const token = c.req.param('token')
	if (!token) {
		return c.json(createApiError('VALIDATION_ERROR', 'Missing token in path'), 400)
	}

	// Body may be absent (authenticated-accept sends an empty body). Read the
	// request body as text so we can safely distinguish empty from malformed;
	// undici's `Request` doesn't always set Content-Length on POSTs with a
	// stringified body, so the content-length header isn't a reliable signal.
	let body: z.infer<typeof acceptBodySchema> = {}
	let rawBodyText: string
	try {
		rawBodyText = await c.req.text()
	} catch {
		rawBodyText = ''
	}
	if (rawBodyText.trim().length > 0) {
		let parsedJson: unknown
		try {
			parsedJson = JSON.parse(rawBodyText)
		} catch {
			return c.json(createApiError('VALIDATION_ERROR', 'Body must be valid JSON if present'), 400)
		}
		const parsed = acceptBodySchema.safeParse(parsedJson)
		if (!parsed.success) {
			return c.json(
				createApiError(
					'VALIDATION_ERROR',
					'Request validation failed',
					formatZodError(parsed.error),
				),
				400,
			)
		}
		body = parsed.data
	}

	const isNewSignup = Boolean(body.email && body.password)
	// Partial body: email without password (or vice versa) is a client error.
	if (!isNewSignup && (body.email || body.password)) {
		return c.json(
			createApiError(
				'BAD_REQUEST',
				'New-signup accept requires both email and password',
				[
					!body.email && { field: 'email', message: 'Required for new-signup accept' },
					!body.password && { field: 'password', message: 'Required for new-signup accept' },
				].filter(Boolean) as Array<{ field: string; message: string }>,
			),
			400,
		)
	}

	const tokenHash = hashInviteToken(token)

	// Look up invite BEFORE opening a transaction so we can bail cheaply on
	// 404/410. The tx will re-select FOR UPDATE for the actual accept.
	const [invitePreview] = await db
		.select()
		.from(workspaceInvitations)
		.where(eq(workspaceInvitations.tokenHash, tokenHash))
		.limit(1)
	if (!invitePreview) {
		return c.json(createApiError('NOT_FOUND', 'Invite not found'), 404)
	}
	if (isInviteExpired(invitePreview)) {
		// 410 GONE per spec §Error/rate-limit posture — no `GONE` code in the
		// shared ApiErrorCode enum today, and adding one is out of this bet's
		// scope (Rail 2 — don't touch outside the task's natural surface).
		// NOT_FOUND is the closest existing code; the 410 HTTP status is what
		// the frontend keys on.
		return c.json(createApiError('NOT_FOUND', 'Invite is no longer valid'), 410)
	}

	if (isNewSignup) {
		// Sanity check: body email must match invite email (case-insensitive).
		// The invite is bound to a specific email; a different signup email would
		// bypass that binding.
		if ((body.email ?? '').toLowerCase() !== invitePreview.email.toLowerCase()) {
			return c.json(
				createApiError('BAD_REQUEST', 'Signup email does not match invite email', [
					{ field: 'email', message: 'Must match the invited email address' },
				]),
				400,
			)
		}

		// Pre-check for existing actor with this email. Race-free because the
		// insert below is guarded by the UNIQUE constraint on `actors.email`; this
		// check is a UX shortcut so the caller gets a clean 409 without hitting
		// the DB error path in the common case.
		const existing = await db
			.select({ id: actors.id })
			.from(actors)
			.where(sql`lower(${actors.email}) = ${(body.email ?? '').toLowerCase()}`)
			.limit(1)
		if (existing.length > 0) {
			return c.json(
				createApiError(
					'CONFLICT',
					'An account with this email already exists — sign in first, then accept the invite',
					[{ field: 'email', message: 'An account with this email already exists' }],
				),
				409,
			)
		}

		const { key: apiKey } = generateApiKey()
		const passwordHash = await hashPassword(body.password ?? '')
		const displayName = (body.name ?? body.email ?? '').trim() || (body.email ?? '')

		type NewSignupOutcome =
			| { kind: 'ok'; actor: typeof actors.$inferSelect; workspaceId: string }
			| { kind: 'gone' }
			| { kind: 'workspace_missing' }
		let outcome: NewSignupOutcome
		try {
			outcome = await db.transaction(async (tx): Promise<NewSignupOutcome> => {
				// Lock invite row so a concurrent revoke/accept can't race us.
				const [invite] = await tx
					.select()
					.from(workspaceInvitations)
					.where(eq(workspaceInvitations.id, invitePreview.id))
					.for('update')
					.limit(1)
				if (!invite || isInviteExpired(invite)) {
					return { kind: 'gone' }
				}

				const insertedRows = await tx
					.insert(actors)
					.values({
						type: 'human',
						name: displayName,
						email: body.email,
						apiKey,
						passwordHash,
						createdBy: null,
					})
					.returning()
				const insertedActor = insertedRows[0]
				if (!insertedActor) {
					// Should never happen — .returning() on a successful insert always
					// yields one row. Kept as an explicit guard so a future refactor
					// that adds .onConflictDoNothing() surfaces the empty case here
					// instead of a TypeError deep in the join below.
					throw new Error('Actor insert returned no row')
				}

				// Lock workspace, run seat-cap check exactly like POST /workspaces/:id/members.
				const [locked] = await tx
					.select({
						id: workspaces.id,
						settings: workspaces.settings,
						billingOwnerId: workspaces.billingOwnerId,
					})
					.from(workspaces)
					.where(eq(workspaces.id, invite.workspaceId))
					.for('update')
					.limit(1)
				if (!locked) return { kind: 'workspace_missing' }

				// Invitee is always human on the new-signup branch (we just inserted
				// them with type: 'human'). Skip cap only for enterprise-owned workspaces.
				if (!isEnterpriseActor(locked.billingOwnerId)) {
					const plan = resolvePlanTier(locked.settings)
					const cap = seatCapForPlan(plan)
					if (cap !== null) {
						const used = await countHumanMembers(tx, invite.workspaceId)
						if (used >= cap) {
							// Throw so the tx rolls back (actor insert reverts, invite stays pending).
							throw new SeatCapExceededError({
								workspaceId: invite.workspaceId,
								plan,
								used,
								cap,
							})
						}
					}
				}

				// Cross-tenant containment: membership is inserted ONLY into invite.workspaceId.
				await tx.insert(workspaceMembers).values({
					workspaceId: invite.workspaceId,
					actorId: insertedActor.id,
					role: invite.role,
				})

				// Flip the invite to accepted, conditional on it still being pending
				// under our lock (guards against a revoke that squeezed in above).
				const updated = await tx
					.update(workspaceInvitations)
					.set({
						status: 'accepted',
						acceptedAt: new Date(),
						acceptedByActorId: insertedActor.id,
						updatedAt: new Date(),
					})
					.where(
						and(eq(workspaceInvitations.id, invite.id), eq(workspaceInvitations.status, 'pending')),
					)
					.returning({ id: workspaceInvitations.id })
				if (updated.length === 0) {
					// Another accept squeezed through despite our FOR UPDATE — impossible
					// in practice, but the conditional keeps the invariant explicit.
					return { kind: 'gone' }
				}

				await tx.insert(events).values({
					workspaceId: invite.workspaceId,
					actorId: insertedActor.id,
					action: 'created',
					entityType: 'workspace_member',
					entityId: insertedActor.id,
					data: {
						role: invite.role,
						added_actor_id: insertedActor.id,
						from_invite: true,
						invite_id: invite.id,
					},
				})

				return { kind: 'ok', actor: insertedActor, workspaceId: invite.workspaceId }
			})
		} catch (err) {
			if (err instanceof SeatCapExceededError) {
				logger.warn('Invite accept blocked by seat cap (new-signup)', {
					workspaceId: err.workspaceId,
					plan: err.plan,
					used: err.used,
					cap: err.cap,
				})
				return c.json(seatCapErrorBody(err), 403)
			}
			if (isEmailUniqueViolation(err)) {
				return c.json(
					createApiError('CONFLICT', 'An account with this email already exists', [
						{ field: 'email', message: 'An account with this email already exists' },
					]),
					409,
				)
			}
			throw err
		}

		if (outcome.kind === 'gone') {
			return c.json(createApiError('NOT_FOUND', 'Invite is no longer valid'), 410)
		}
		if (outcome.kind === 'workspace_missing') {
			return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
		}

		void capturePosthogEvent('workspace_member_joined', outcome.actor.id, {
			from_invite: true,
			workspace_id: outcome.workspaceId,
			role: invitePreview.role,
			branch: 'new_signup',
		})

		return c.json(
			{
				actor: stripActorSecretsForResponse(outcome.actor),
				workspaceId: outcome.workspaceId,
			},
			201,
		)
	}

	// ── Authenticated-accept branch ────────────────────────────────────────
	// We're outside the auth middleware, so read Authorization ourselves. The
	// UNAUTHORIZED response has to be plain since we can't rely on the frontend
	// keeping the raw token in memory for a retry.
	const authHeader = c.req.header('Authorization')
	if (!authHeader?.startsWith('Bearer ')) {
		return c.json(
			createApiError(
				'UNAUTHORIZED',
				'Authenticated-accept requires an Authorization header',
				undefined,
				"Send 'Authorization: Bearer ank_…' with an empty body, or POST { email, password } to sign up.",
			),
			401,
		)
	}
	const bearer = authHeader.slice(7).trim()
	if (!bearer.startsWith('ank_')) {
		return c.json(createApiError('UNAUTHORIZED', 'Only API keys are supported here'), 401)
	}
	const validated = await validateApiKey(db, bearer)
	if (!validated) {
		return c.json(createApiError('UNAUTHORIZED', 'Invalid API key'), 401)
	}

	const [actor] = await db.select().from(actors).where(eq(actors.id, validated.actorId)).limit(1)
	if (!actor) {
		return c.json(createApiError('UNAUTHORIZED', 'Actor not found for this API key'), 401)
	}

	const emailMismatch = (actor.email ?? '').toLowerCase() !== invitePreview.email.toLowerCase()

	type AuthOutcome =
		| { kind: 'ok'; workspaceId: string; actorId: string }
		| { kind: 'gone' }
		| { kind: 'workspace_missing' }
	let outcome: AuthOutcome
	try {
		outcome = await db.transaction(async (tx): Promise<AuthOutcome> => {
			const [invite] = await tx
				.select()
				.from(workspaceInvitations)
				.where(eq(workspaceInvitations.id, invitePreview.id))
				.for('update')
				.limit(1)
			if (!invite || isInviteExpired(invite)) return { kind: 'gone' }

			const [locked] = await tx
				.select({
					id: workspaces.id,
					settings: workspaces.settings,
					billingOwnerId: workspaces.billingOwnerId,
				})
				.from(workspaces)
				.where(eq(workspaces.id, invite.workspaceId))
				.for('update')
				.limit(1)
			if (!locked) return { kind: 'workspace_missing' }

			// Seat cap applies only to humans on non-enterprise-owned workspaces —
			// mirrors POST /workspaces/:id/members. Agents accepting invites (e.g.
			// via a personal-token flow) don't count.
			if (actor.type === 'human' && !isEnterpriseActor(locked.billingOwnerId)) {
				// If the actor is already a member, adding them again is a no-op —
				// so the cap check is irrelevant in that case. Cheaper to check
				// membership first than to over-fetch: countHumanMembers is a single
				// SQL COUNT, so this is a tiny two-query cost we pay only when the
				// actor is NOT already a member.
				const [existingMember] = await tx
					.select({ actorId: workspaceMembers.actorId })
					.from(workspaceMembers)
					.where(
						and(
							eq(workspaceMembers.workspaceId, invite.workspaceId),
							eq(workspaceMembers.actorId, actor.id),
						),
					)
					.limit(1)
				if (!existingMember) {
					const plan = resolvePlanTier(locked.settings)
					const cap = seatCapForPlan(plan)
					if (cap !== null) {
						const used = await countHumanMembers(tx, invite.workspaceId)
						if (used >= cap) {
							throw new SeatCapExceededError({
								workspaceId: invite.workspaceId,
								plan,
								used,
								cap,
							})
						}
					}
				}
			}

			// Cross-tenant containment: membership is inserted ONLY into invite.workspaceId.
			// onConflictDoNothing means an already-a-member accept flips the invite
			// to accepted without a duplicate-PK crash.
			await tx
				.insert(workspaceMembers)
				.values({
					workspaceId: invite.workspaceId,
					actorId: actor.id,
					role: invite.role,
				})
				.onConflictDoNothing({
					target: [workspaceMembers.workspaceId, workspaceMembers.actorId],
				})

			const mergedMetadata = emailMismatch
				? { ...(invite.metadata ?? {}), email_mismatch: true }
				: invite.metadata

			const updated = await tx
				.update(workspaceInvitations)
				.set({
					status: 'accepted',
					acceptedAt: new Date(),
					acceptedByActorId: actor.id,
					metadata: mergedMetadata,
					updatedAt: new Date(),
				})
				.where(
					and(eq(workspaceInvitations.id, invite.id), eq(workspaceInvitations.status, 'pending')),
				)
				.returning({ id: workspaceInvitations.id })
			if (updated.length === 0) return { kind: 'gone' }

			await tx.insert(events).values({
				workspaceId: invite.workspaceId,
				actorId: actor.id,
				action: 'created',
				entityType: 'workspace_member',
				entityId: actor.id,
				data: {
					role: invite.role,
					added_actor_id: actor.id,
					from_invite: true,
					invite_id: invite.id,
					email_mismatch: emailMismatch,
				},
			})

			return { kind: 'ok', workspaceId: invite.workspaceId, actorId: actor.id }
		})
	} catch (err) {
		if (err instanceof SeatCapExceededError) {
			logger.warn('Invite accept blocked by seat cap (authenticated)', {
				workspaceId: err.workspaceId,
				plan: err.plan,
				used: err.used,
				cap: err.cap,
			})
			return c.json(seatCapErrorBody(err), 403)
		}
		throw err
	}

	if (outcome.kind === 'gone') {
		return c.json(createApiError('NOT_FOUND', 'Invite is no longer valid'), 410)
	}
	if (outcome.kind === 'workspace_missing') {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	void capturePosthogEvent('workspace_member_joined', outcome.actorId, {
		from_invite: true,
		workspace_id: outcome.workspaceId,
		role: invitePreview.role,
		branch: 'authenticated',
		email_mismatch: emailMismatch,
	})

	return c.json({ workspaceId: outcome.workspaceId, actorId: outcome.actorId }, 200)
})

// ─── GET /preview ──────────────────────────────────────────────────────────
// Unauthenticated. IP rate-limited to prevent token-space enumeration.
// Response deliberately omits workspace metadata on 404/410 for the same reason.

const previewRoute = createRoute({
	method: 'get',
	path: '/preview',
	tags: ['workspace-invitations'],
	summary: 'Preview an invite by token (unauthenticated, IP-rate-limited)',
	description:
		'Unauthenticated preview so the /invite accept page can render workspace + inviter context ' +
		'before the invitee has an account. IP-rate-limited (token-bucket). Response omits workspace ' +
		'metadata on 404/410 to prevent token-space enumeration.',
	request: {
		query: z.object({ token: z.string().min(1) }),
	},
	responses: {
		200: {
			description: 'Valid pending invite',
			content: { 'application/json': { schema: previewResponseSchema } },
		},
		404: {
			description: 'No invite matches this token (status-only body)',
			content: { 'application/json': { schema: previewErrorSchema } },
		},
		410: {
			description: 'Invite is no longer valid (status-only body)',
			content: { 'application/json': { schema: previewErrorSchema } },
		},
		429: {
			description: 'IP rate limit exceeded',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(previewRoute, async (c) => {
	const db = c.get('db')
	const { token } = c.req.valid('query')

	const socketIp = (c.req.raw as unknown as { remoteAddress?: string }).remoteAddress
	const ip = extractClientIp(socketIp, c.req.header('X-Forwarded-For'))
	if (!takeInvitePreviewToken(ip)) {
		c.header('Retry-After', '60')
		return c.json(createApiError('RATE_LIMITED', 'Too many invite previews from this IP'), 429)
	}

	const tokenHash = hashInviteToken(token)
	const [invite] = await db
		.select({
			id: workspaceInvitations.id,
			workspaceId: workspaceInvitations.workspaceId,
			email: workspaceInvitations.email,
			role: workspaceInvitations.role,
			status: workspaceInvitations.status,
			expiresAt: workspaceInvitations.expiresAt,
			invitedByActorId: workspaceInvitations.invitedByActorId,
		})
		.from(workspaceInvitations)
		.where(eq(workspaceInvitations.tokenHash, tokenHash))
		.limit(1)

	if (!invite) {
		return c.json({ status: 'not_found' }, 404)
	}
	if (invite.status !== 'pending') {
		return c.json({ status: invite.status }, 410)
	}
	if (invite.expiresAt.getTime() <= Date.now()) {
		return c.json({ status: 'expired' }, 410)
	}

	// Fetch workspace + inviter for the response. Both are FK-guaranteed to
	// exist (workspace cascade-deletes invites; invitedByActorId has ON DELETE
	// RESTRICT), so a missing row here is a genuine invariant break.
	const [workspace] = await db
		.select({ id: workspaces.id, name: workspaces.name })
		.from(workspaces)
		.where(eq(workspaces.id, invite.workspaceId))
		.limit(1)
	const [inviter] = await db
		.select({ id: actors.id, name: actors.name })
		.from(actors)
		.where(eq(actors.id, invite.invitedByActorId))
		.limit(1)
	if (!workspace || !inviter) {
		logger.error('Invite preview: FK-guaranteed row missing', {
			inviteId: invite.id,
			workspaceMissing: !workspace,
			inviterMissing: !inviter,
		})
		return c.json({ status: 'not_found' }, 404)
	}

	return c.json(
		{
			status: 'pending' as const,
			workspaceId: workspace.id,
			workspaceName: workspace.name,
			inviterName: inviter.name,
			inviteEmail: invite.email,
			expiresAt: invite.expiresAt.toISOString(),
		},
		200,
	)
})

// ─── Admin lifecycle: create / resend / revoke / list ──────────────────────
// All four run behind the standard auth middleware (Bearer + optional
// X-Workspace-Id). The workspace is derived from the body/query/invite row, so
// each handler does its own membership check.

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const INVITE_RATE_WINDOW_MS = 24 * 60 * 60 * 1000
// The 21st invite inside the window is rejected.
const INVITE_RATE_LIMIT = 20

export const createInviteBodySchema = z.object({
	workspaceId: z.string().uuid(),
	email: z.string().trim().email().max(320),
	// Owner is deliberately absent: ownership moves via transfer-ownership only.
	role: z.enum(['member', 'viewer']),
})

export const inviteSummarySchema = z.object({
	id: z.string().uuid(),
	email: z.string(),
	role: z.string(),
	expiresAt: z.string(),
})

export const pendingInviteResponseSchema = z.object({
	status: z.literal('pending'),
	invite: inviteSummarySchema,
})

export const linkedMemberResponseSchema = z.object({
	status: z.literal('linked'),
	member: z.object({
		workspaceId: z.string().uuid(),
		actorId: z.string().uuid(),
		role: z.string(),
	}),
})

export const revokeInviteResponseSchema = z.object({ revoked: z.literal(true) })

export const listInvitesQuerySchema = z.object({ workspaceId: z.string().uuid() })

export const pendingInviteListItemSchema = inviteSummarySchema.extend({
	invitedByActorId: z.string().uuid(),
	invitedByName: z.string(),
	createdAt: z.string(),
})

function resolveAcceptUrl(rawToken: string): string | null {
	const configured = process.env.APP_URL?.trim().replace(/\/+$/, '')
	// Unset APP_URL is only tolerable when nothing is really sent: in dev mode
	// (no RESEND_API_KEY) sendInviteEmail just logs the link. With a real key a
	// localhost link would go out to a customer, so refuse instead.
	const base = configured || (process.env.RESEND_API_KEY ? null : 'http://localhost:5173')
	return base ? `${base}/invite?token=${encodeURIComponent(rawToken)}` : null
}

function toInviteSummary(invite: { id: string; email: string; role: string; expiresAt: Date }) {
	return {
		id: invite.id,
		email: invite.email,
		role: invite.role,
		expiresAt: invite.expiresAt.toISOString(),
	}
}

function isPendingInviteUniqueViolation(err: unknown): boolean {
	for (let cur: unknown = err; cur && typeof cur === 'object'; ) {
		const e = cur as {
			code?: string
			constraint_name?: string
			constraint?: string
			cause?: unknown
		}
		if (e.code === '23505') {
			return (e.constraint_name ?? e.constraint) === 'workspace_invitations_pending_ws_email_uniq'
		}
		cur = e.cause
	}
	return false
}

// Send failure is an upstream (Resend) failure, so 502. The shared error enum
// has no BAD_GATEWAY code and adding one is outside this task; INTERNAL_ERROR
// with a 502 status is the closest fit, same call T3 made for its 410s.
function sendFailureResponse(err: unknown) {
	const reason = err instanceof Error ? err.message : String(err)
	return createApiError(
		'INTERNAL_ERROR',
		`Failed to send invite email: ${reason}`,
		undefined,
		'The invite was not created. Try again in a moment.',
	)
}

// POST / ────────────────────────────────────────────────────────────────────

const createInviteRoute = createRoute({
	method: 'post',
	path: '/',
	tags: ['workspace-invitations'],
	summary: 'Invite someone to a workspace by email',
	description:
		'If the email belongs to an existing actor who is not yet a member, that actor is added ' +
		'directly (status "linked"). Otherwise a pending invite is created and emailed (status ' +
		'"pending"). Re-inviting an email with a live pending invite returns that invite unchanged.',
	request: {
		body: { content: { 'application/json': { schema: createInviteBodySchema } } },
	},
	responses: {
		200: {
			description: 'A live pending invite for this email already exists (returned unchanged)',
			content: { 'application/json': { schema: pendingInviteResponseSchema } },
		},
		201: {
			description: 'Actor linked directly, or a new pending invite created and emailed',
			content: {
				'application/json': {
					schema: z.union([linkedMemberResponseSchema, pendingInviteResponseSchema]),
				},
			},
		},
		403: {
			description: 'Caller is not a human owner/admin of the workspace, or the seat cap is reached',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'That email already belongs to a member of this workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		429: {
			description: 'This workspace already sent 20 invites in the last 24 hours',
			content: { 'application/json': { schema: errorSchema } },
		},
		502: {
			description: 'The invite email could not be sent; the invite was not created',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(createInviteRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { workspaceId, email, role } = c.req.valid('json')

	if (!(await isWorkspaceHumanAdminOrOwner(db, callerId, workspaceId))) {
		return c.json(
			createApiError('FORBIDDEN', 'Only workspace owners and admins can invite members'),
			403,
		)
	}

	const emailLower = email.toLowerCase()

	// Branch A / C: the email already belongs to a Maskin actor.
	const [existingActor] = await db
		.select({ id: actors.id, type: actors.type })
		.from(actors)
		.where(sql`lower(${actors.email}) = ${emailLower}`)
		.limit(1)

	if (existingActor) {
		type LinkOutcome =
			| { kind: 'added' }
			| { kind: 'already_member' }
			| { kind: 'workspace_missing' }
		let outcome: LinkOutcome
		try {
			outcome = await db.transaction(async (tx): Promise<LinkOutcome> => {
				// Same lock + seat-cap + insert sequence as POST /workspaces/:id/members.
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
				if (!locked) return { kind: 'workspace_missing' }

				if (existingActor.type === 'human' && !isEnterpriseActor(locked.billingOwnerId)) {
					const [alreadyMember] = await tx
						.select({ actorId: workspaceMembers.actorId })
						.from(workspaceMembers)
						.where(
							and(
								eq(workspaceMembers.workspaceId, workspaceId),
								eq(workspaceMembers.actorId, existingActor.id),
							),
						)
						.limit(1)
					// A member is never blocked by the cap, so answer 409 rather than 403.
					if (alreadyMember) return { kind: 'already_member' }
					const plan = resolvePlanTier(locked.settings)
					const cap = seatCapForPlan(plan)
					if (cap !== null) {
						const used = await countHumanMembers(tx, workspaceId)
						if (used >= cap) throw new SeatCapExceededError({ workspaceId, plan, used, cap })
					}
				}

				const inserted = await tx
					.insert(workspaceMembers)
					.values({ workspaceId, actorId: existingActor.id, role })
					.onConflictDoNothing({
						target: [workspaceMembers.workspaceId, workspaceMembers.actorId],
					})
					.returning()
				if (!inserted.length) return { kind: 'already_member' }

				await tx.insert(events).values({
					workspaceId,
					actorId: callerId,
					action: 'created',
					entityType: 'workspace_member',
					entityId: existingActor.id,
					data: { role, added_actor_id: existingActor.id },
				})
				return { kind: 'added' }
			})
		} catch (err) {
			if (err instanceof SeatCapExceededError) {
				logger.warn('Invite blocked by seat cap (link existing actor)', {
					workspaceId: err.workspaceId,
					plan: err.plan,
					used: err.used,
					cap: err.cap,
				})
				return c.json(seatCapErrorBody(err), 403)
			}
			throw err
		}

		if (outcome.kind === 'workspace_missing') {
			return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
		}
		if (outcome.kind === 'already_member') {
			return c.json(
				createApiError('CONFLICT', `${email} is already a member of this workspace`, [
					{ field: 'email', message: 'Already a member of this workspace' },
				]),
				409,
			)
		}

		void capturePosthogEvent('workspace_member_invited', callerId, {
			invite_method: 'email',
			workspace_id: workspaceId,
			role,
		})
		// A direct link is not a redemption, so this is not from_invite.
		void capturePosthogEvent('workspace_member_joined', existingActor.id, {
			from_invite: false,
			workspace_id: workspaceId,
			role,
		})
		return c.json(
			{ status: 'linked' as const, member: { workspaceId, actorId: existingActor.id, role } },
			201,
		)
	}

	// Branch B: no matching actor, so a pending invite.
	const now = new Date()

	// An invite past its expiry keeps status 'pending' until something flips it,
	// and the partial unique index only frees the (workspace, email) slot once
	// it is no longer 'pending'. Retire stale rows first so they don't block.
	await db
		.update(workspaceInvitations)
		.set({ status: 'expired', updatedAt: now })
		.where(
			and(
				eq(workspaceInvitations.workspaceId, workspaceId),
				sql`lower(${workspaceInvitations.email}) = ${emailLower}`,
				eq(workspaceInvitations.status, 'pending'),
				lte(workspaceInvitations.expiresAt, now),
			),
		)

	const findLivePending = async () => {
		const [row] = await db
			.select()
			.from(workspaceInvitations)
			.where(
				and(
					eq(workspaceInvitations.workspaceId, workspaceId),
					sql`lower(${workspaceInvitations.email}) = ${emailLower}`,
					eq(workspaceInvitations.status, 'pending'),
					gt(workspaceInvitations.expiresAt, now),
				),
			)
			.limit(1)
		return row
	}

	// Idempotent: same invite back, token NOT rotated (resend does that).
	const existingInvite = await findLivePending()
	if (existingInvite) {
		return c.json({ status: 'pending' as const, invite: toInviteSummary(existingInvite) }, 200)
	}

	const windowStart = new Date(now.getTime() - INVITE_RATE_WINDOW_MS)
	const [usage] = await db
		.select({ sent: count(), oldest: min(workspaceInvitations.createdAt) })
		.from(workspaceInvitations)
		.where(
			and(
				eq(workspaceInvitations.workspaceId, workspaceId),
				gt(workspaceInvitations.createdAt, windowStart),
			),
		)
	if ((usage?.sent ?? 0) >= INVITE_RATE_LIMIT) {
		const oldest = usage?.oldest?.getTime() ?? now.getTime()
		const retryAfter = Math.max(
			1,
			Math.ceil((oldest + INVITE_RATE_WINDOW_MS - now.getTime()) / 1000),
		)
		c.header('Retry-After', String(retryAfter))
		return c.json(
			createApiError(
				'RATE_LIMITED',
				`This workspace has sent ${INVITE_RATE_LIMIT} invites in the last 24 hours`,
			),
			429,
		)
	}

	const [workspace] = await db
		.select({ name: workspaces.name })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!workspace) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	const [inviter] = await db
		.select({ name: actors.name })
		.from(actors)
		.where(eq(actors.id, callerId))
		.limit(1)

	const rawToken = generateInviteToken()
	const acceptUrl = resolveAcceptUrl(rawToken)
	if (!acceptUrl) {
		logger.error('Invite not created: APP_URL is unset while RESEND_API_KEY is set')
		return c.json(
			createApiError('INTERNAL_ERROR', 'Invite links are not configured (APP_URL)'),
			500,
		)
	}

	let invite: typeof workspaceInvitations.$inferSelect | undefined
	try {
		;[invite] = await db
			.insert(workspaceInvitations)
			.values({
				workspaceId,
				email,
				role,
				tokenHash: hashInviteToken(rawToken),
				invitedByActorId: callerId,
				expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
			})
			.returning()
	} catch (err) {
		// Two concurrent invites for the same email: the loser gets the winner's row.
		if (isPendingInviteUniqueViolation(err)) {
			const winner = await findLivePending()
			if (winner) {
				return c.json({ status: 'pending' as const, invite: toInviteSummary(winner) }, 200)
			}
		}
		throw err
	}
	if (!invite) throw new Error('Invite insert returned no row')

	// The row is committed by now. A Postgres transaction can't stay open across
	// an HTTP call to Resend, so a failed send is undone by deleting the row.
	try {
		await sendInviteEmail({
			to: email,
			workspaceName: workspace.name,
			inviterName: inviter?.name ?? 'A teammate',
			role,
			acceptUrl,
		})
	} catch (err) {
		logger.error('Invite email send failed, deleting invite', {
			workspaceId,
			inviteId: invite.id,
			error: String(err),
		})
		await db.delete(workspaceInvitations).where(eq(workspaceInvitations.id, invite.id))
		return c.json(sendFailureResponse(err), 502)
	}

	await db.insert(events).values({
		workspaceId,
		actorId: callerId,
		action: 'created',
		entityType: 'workspace_invitation',
		entityId: invite.id,
		data: { email, role },
	})
	void capturePosthogEvent('workspace_member_invited', callerId, {
		invite_method: 'email',
		workspace_id: workspaceId,
		role,
	})
	return c.json({ status: 'pending' as const, invite: toInviteSummary(invite) }, 201)
}) as RouteHandler<typeof createInviteRoute, Env>)

// POST /:id/resend ──────────────────────────────────────────────────────────

const resendInviteRoute = createRoute({
	method: 'post',
	path: '/{id}/resend',
	tags: ['workspace-invitations'],
	summary: 'Resend a pending invite with a fresh token and expiry',
	request: { params: idParamSchema },
	responses: {
		200: {
			description: 'Token rotated, expiry reset to 7 days, email sent again',
			content: { 'application/json': { schema: pendingInviteResponseSchema } },
		},
		403: {
			description: 'Caller is not a human owner/admin of the invite workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Invite not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'Invite is no longer pending (accepted or revoked)',
			content: { 'application/json': { schema: errorSchema } },
		},
		502: {
			description: 'The email could not be sent; the previous token and expiry are restored',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(resendInviteRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { id } = c.req.valid('param')

	const [invite] = await db
		.select()
		.from(workspaceInvitations)
		.where(eq(workspaceInvitations.id, id))
		.limit(1)
	if (!invite) return c.json(createApiError('NOT_FOUND', 'Invite not found'), 404)
	if (!(await isWorkspaceHumanAdminOrOwner(db, callerId, invite.workspaceId))) {
		return c.json(
			createApiError('FORBIDDEN', 'Only workspace owners and admins can resend invites'),
			403,
		)
	}
	if (invite.status !== 'pending') {
		return c.json(createApiError('CONFLICT', `Invite is already ${invite.status}`), 409)
	}

	const [workspace] = await db
		.select({ name: workspaces.name })
		.from(workspaces)
		.where(eq(workspaces.id, invite.workspaceId))
		.limit(1)
	// Same inviter name the preview page shows.
	const [inviter] = await db
		.select({ name: actors.name })
		.from(actors)
		.where(eq(actors.id, invite.invitedByActorId))
		.limit(1)
	if (!workspace) return c.json(createApiError('NOT_FOUND', 'Invite not found'), 404)

	const rawToken = generateInviteToken()
	const acceptUrl = resolveAcceptUrl(rawToken)
	if (!acceptUrl) {
		logger.error('Invite not resent: APP_URL is unset while RESEND_API_KEY is set')
		return c.json(
			createApiError('INTERNAL_ERROR', 'Invite links are not configured (APP_URL)'),
			500,
		)
	}

	const newHash = hashInviteToken(rawToken)
	const newExpiresAt = new Date(Date.now() + INVITE_TTL_MS)
	// Conditional on still being pending so a racing accept or revoke wins.
	const [rotated] = await db
		.update(workspaceInvitations)
		.set({ tokenHash: newHash, expiresAt: newExpiresAt, updatedAt: new Date() })
		.where(and(eq(workspaceInvitations.id, id), eq(workspaceInvitations.status, 'pending')))
		.returning()
	if (!rotated) {
		return c.json(createApiError('CONFLICT', 'Invite is no longer pending'), 409)
	}

	try {
		await sendInviteEmail({
			to: rotated.email,
			workspaceName: workspace.name,
			inviterName: inviter?.name ?? 'A teammate',
			role: rotated.role,
			acceptUrl,
		})
	} catch (err) {
		logger.error('Invite resend email failed, restoring previous token', {
			workspaceId: invite.workspaceId,
			inviteId: id,
			error: String(err),
		})
		// The new token never reached anyone, so put the old one back: the link
		// in the earlier email keeps working.
		await db
			.update(workspaceInvitations)
			.set({ tokenHash: invite.tokenHash, expiresAt: invite.expiresAt, updatedAt: new Date() })
			.where(and(eq(workspaceInvitations.id, id), eq(workspaceInvitations.tokenHash, newHash)))
		return c.json(sendFailureResponse(err), 502)
	}

	await db.insert(events).values({
		workspaceId: invite.workspaceId,
		actorId: callerId,
		action: 'updated',
		entityType: 'workspace_invitation',
		entityId: id,
		data: { resent: true },
	})
	void capturePosthogEvent('workspace_member_invited', callerId, {
		invite_method: 'email',
		workspace_id: invite.workspaceId,
		role: rotated.role,
	})
	return c.json({ status: 'pending' as const, invite: toInviteSummary(rotated) }, 200)
}) as RouteHandler<typeof resendInviteRoute, Env>)

// DELETE /:id ───────────────────────────────────────────────────────────────

const revokeInviteRoute = createRoute({
	method: 'delete',
	path: '/{id}',
	tags: ['workspace-invitations'],
	summary: 'Revoke a pending invite',
	request: { params: idParamSchema },
	responses: {
		200: {
			description: 'Invite revoked; its link no longer works',
			content: { 'application/json': { schema: revokeInviteResponseSchema } },
		},
		403: {
			description: 'Caller is not a human owner/admin of the invite workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Invite not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'Invite is no longer pending (accepted or already revoked)',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(revokeInviteRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { id } = c.req.valid('param')

	const [invite] = await db
		.select({ id: workspaceInvitations.id, workspaceId: workspaceInvitations.workspaceId })
		.from(workspaceInvitations)
		.where(eq(workspaceInvitations.id, id))
		.limit(1)
	if (!invite) return c.json(createApiError('NOT_FOUND', 'Invite not found'), 404)
	if (!(await isWorkspaceHumanAdminOrOwner(db, callerId, invite.workspaceId))) {
		return c.json(
			createApiError('FORBIDDEN', 'Only workspace owners and admins can revoke invites'),
			403,
		)
	}

	const now = new Date()
	// Conditional on pending: an accepted invite can't be revoked after the fact.
	const [revoked] = await db
		.update(workspaceInvitations)
		.set({ status: 'revoked', revokedAt: now, revokedByActorId: callerId, updatedAt: now })
		.where(and(eq(workspaceInvitations.id, id), eq(workspaceInvitations.status, 'pending')))
		.returning({ id: workspaceInvitations.id })
	if (!revoked) {
		return c.json(createApiError('CONFLICT', 'Invite is no longer pending'), 409)
	}

	await db.insert(events).values({
		workspaceId: invite.workspaceId,
		actorId: callerId,
		action: 'updated',
		entityType: 'workspace_invitation',
		entityId: id,
		data: { status: 'revoked' },
	})
	void capturePosthogEvent('workspace_invite_revoked', callerId, {
		workspace_id: invite.workspaceId,
		invite_id: id,
		revoked_by_actor_id: callerId,
	})
	return c.json({ revoked: true as const }, 200)
}) as RouteHandler<typeof revokeInviteRoute, Env>)

// GET / ─────────────────────────────────────────────────────────────────────

const listInvitesRoute = createRoute({
	method: 'get',
	path: '/',
	tags: ['workspace-invitations'],
	summary: 'List pending invites for a workspace',
	request: { query: listInvitesQuerySchema },
	responses: {
		200: {
			description: 'Pending, unexpired invites, newest first',
			content: { 'application/json': { schema: z.array(pendingInviteListItemSchema) } },
		},
		403: {
			description: 'Caller is not a member of the workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(listInvitesRoute, (async (c) => {
	const db = c.get('db')
	const callerId = c.get('actorId')
	const { workspaceId } = c.req.valid('query')

	if (!(await isWorkspaceMember(db, callerId, workspaceId))) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const rows = await db
		.select({
			id: workspaceInvitations.id,
			email: workspaceInvitations.email,
			role: workspaceInvitations.role,
			expiresAt: workspaceInvitations.expiresAt,
			invitedByActorId: workspaceInvitations.invitedByActorId,
			invitedByName: actors.name,
			createdAt: workspaceInvitations.createdAt,
		})
		.from(workspaceInvitations)
		.innerJoin(actors, eq(actors.id, workspaceInvitations.invitedByActorId))
		.where(
			and(
				eq(workspaceInvitations.workspaceId, workspaceId),
				eq(workspaceInvitations.status, 'pending'),
				gt(workspaceInvitations.expiresAt, new Date()),
			),
		)
		.orderBy(desc(workspaceInvitations.createdAt))

	return c.json(
		rows.map((r) => ({
			...toInviteSummary(r),
			invitedByActorId: r.invitedByActorId,
			invitedByName: r.invitedByName,
			createdAt: r.createdAt.toISOString(),
		})),
		200,
	)
}) as RouteHandler<typeof listInvitesRoute, Env>)

export default app
