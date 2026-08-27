import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { generateApiKey, hashPassword, validateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import {
	events,
	actors,
	workspaceInvitations,
	workspaceMembers,
	workspaces,
} from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import { capturePosthogEvent } from '../lib/analytics/posthog'
import { isEnterpriseActor } from '../lib/enterprise-allowlist'
import { createApiError, formatZodError, validationFailureHook } from '../lib/errors'
import { takeInvitePreviewToken } from '../lib/invite-preview-throttle'
import { hashInviteToken } from '../lib/invites-token'
import { logger } from '../lib/logger'
import { errorSchema } from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import { extractClientIp } from '../lib/trusted-proxy'
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

export default app
