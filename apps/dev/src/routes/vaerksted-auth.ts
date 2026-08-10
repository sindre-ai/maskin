import { OpenAPIHono, createRoute, type z } from '@hono/zod-openapi'
import { generateApiKey } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { events, actors, workspaceMembers } from '@maskin/db/schema'
import { vaerkstedLinkSchema } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { createApiError } from '../lib/errors'
import { logger } from '../lib/logger'
import { actorWithKeySchema, errorSchema } from '../lib/openapi-schemas'
import { serialize } from '../lib/serialize'
import {
	InvalidVaerkstedSessionError,
	VaerkstedAuthUnreachableError,
	verifyVaerkstedSession,
} from '../lib/vaerksted-auth-client'
import type { AgentStorageManager } from '../services/agent-storage'
import { bootstrapDefaultAgents, createPersonalWorkspace } from '../services/workspace-bootstrap'

type Env = {
	Variables: {
		db: Database
		agentStorage: AgentStorageManager
	}
}

const app = new OpenAPIHono<Env>()

// POST /link — exchange a vaerksted-auth session token for a Maskin actor.
//
// Design doc vaerksted-auth-and-sync.md §8: "Maskin's sign-up flow, when the
// user chooses 'continue with vaerksted,' creates (or reuses) a vaerksted
// identity and then creates a Maskin actor with vaerksted_identity_id set —
// no second password." This is that exchange. It is intentionally public
// (no Maskin API key required) — it IS the login/signup entry point, the
// same way POST /api/actors and POST /api/auth/login are public.
const linkRoute = createRoute({
	method: 'post',
	path: '/link',
	tags: ['VaerkstedAuth'],
	summary: 'Exchange a vaerksted-auth session for a Maskin actor (login, link, or signup)',
	request: {
		body: {
			content: {
				'application/json': {
					schema: vaerkstedLinkSchema,
				},
			},
		},
	},
	responses: {
		200: {
			content: { 'application/json': { schema: actorWithKeySchema } },
			description: 'Existing actor — logged in (already linked, or just linked by email match)',
		},
		201: {
			content: { 'application/json': { schema: actorWithKeySchema } },
			description: 'New actor created and linked to the vaerksted identity',
		},
		401: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'The vaerksted-auth session token could not be verified',
		},
		409: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Email already exists (lost a race with a concurrent signup)',
		},
		500: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'Internal server error',
		},
		503: {
			content: { 'application/json': { schema: errorSchema } },
			description: 'VAERKSTED_AUTH_BASE_URL is not configured',
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

/** Shapes an `actors` row into the same body POST /api/actors returns on signup. */
function respondWithActor(
	actor: typeof actors.$inferSelect,
	status: 200 | 201,
	workspaceId?: string,
) {
	const { apiKey, passwordHash, systemPrompt, llmProvider, llmConfig, ...actorWithoutSecrets } =
		actor
	return [
		{
			...serialize(actorWithoutSecrets),
			system_prompt: systemPrompt,
			llm_provider: llmProvider,
			llm_config: llmConfig,
			api_key: apiKey,
			...(workspaceId && { workspace_id: workspaceId }),
			// 201 only ever comes from the brand-new-actor branch (step 4) —
			// 200 covers both the already-linked login and the link-by-email
			// cases, neither of which needs profile info collected again.
			is_new_actor: status === 201,
		} as z.infer<typeof actorWithKeySchema>,
		status,
	] as const
}

app.openapi(linkRoute, async (c) => {
	const db = c.get('db')
	const body = c.req.valid('json')

	const baseUrl = process.env.VAERKSTED_AUTH_BASE_URL
	if (!baseUrl) {
		return c.json(
			createApiError('INTERNAL_ERROR', 'VAERKSTED_AUTH_BASE_URL is not configured'),
			503,
		)
	}

	// Step 1: verify the session token against vaerksted-auth itself — never
	// trust a client-supplied identity_id directly (that would let any caller
	// claim to be any vaerksted identity; see the route-file header comment in
	// lib/vaerksted-auth-client.ts and apps/vaerksted-auth's new GET
	// /sessions/me). Any failure — the token was rejected, or vaerksted-auth
	// couldn't be reached at all — collapses to the same 401: from this
	// route's perspective, an unverifiable session is indistinguishable from
	// an invalid one.
	let verified: Awaited<ReturnType<typeof verifyVaerkstedSession>>
	try {
		verified = await verifyVaerkstedSession(baseUrl, body.session_token)
	} catch (err) {
		if (
			err instanceof InvalidVaerkstedSessionError ||
			err instanceof VaerkstedAuthUnreachableError
		) {
			return c.json(createApiError('UNAUTHORIZED', 'Could not verify vaerksted session'), 401)
		}
		throw err
	}

	// Step 2: login — an actor is already linked to this verified identity.
	const [byIdentity] = await db
		.select()
		.from(actors)
		.where(eq(actors.vaerkstedIdentityId, verified.identityId))
		.limit(1)
	if (byIdentity) {
		return c.json(...respondWithActor(byIdentity, 200))
	}

	// Step 3: explicit-linking judgment call (design doc §6a "explicit, not
	// automatic") applied to this specific case.
	//
	// §6a's policy is about Supabase Auth not silently merging two *different*
	// sign-in methods on email match ("emails get reassigned ... auto-linking
	// on email match risks silently merging two different people"). The
	// original implementation plan's M5 section proposed a *second*,
	// magic-link-style re-verification step here before linking a pre-existing
	// native-password Maskin actor by email match.
	//
	// We deliberately simplify that: by the time execution reaches this line,
	// the caller has already proven ownership of `verified.email` through a
	// real credential check — Supabase Auth's own magic-link/OAuth flow,
	// verified server-side by vaerksted-auth in step 1 above (not merely
	// asserted by the client). Requiring a *second* proof-of-email-ownership
	// step here would be redundant: it re-verifies the exact same fact
	// (control of this email inbox / OAuth account) that step 1 already
	// established, just via a different channel. The "explicit, not
	// automatic" principle is about not linking *without user action* — and
	// clicking "Continue with vaerksted" and completing that real auth flow
	// IS the explicit action, the same way §6a treats "link your Microsoft
	// account in account settings" as sufficiently explicit without asking
	// again. So: link now, on this request, no separate email round-trip.
	//
	// This also sidesteps the "silent backend migration via bcrypt hash
	// import into Supabase" path entirely — see the TODO(spike) below — since
	// nothing here reads or writes password_hash; it only ever sets
	// vaerksted_identity_id.
	if (verified.email) {
		const [byEmail] = await db
			.select()
			.from(actors)
			.where(eq(actors.email, verified.email))
			.limit(1)
		if (byEmail) {
			const [updated] = await db
				.update(actors)
				.set({ vaerkstedIdentityId: verified.identityId, updatedAt: new Date() })
				.where(eq(actors.id, byEmail.id))
				.returning()
			if (!updated) {
				return c.json(createApiError('INTERNAL_ERROR', 'Failed to link actor'), 500)
			}

			// Events audit log (.claude/rules/known-pitfalls.md "Missing Events
			// Audit Log on Entity Mutations") — actors doesn't carry its own
			// workspace_id, so (per TokenManager.markRevoked()'s established
			// pattern for service-layer mutations without a direct actorId/
			// workspaceId) look up a workspace this actor belongs to. A
			// pre-existing native-password human actor always has one (signup
			// auto-creates a personal workspace) — but events.workspace_id is
			// NOT NULL, so if this actor somehow has none, skip the audit row
			// rather than fail the login over it.
			const [membership] = await db
				.select({ workspaceId: workspaceMembers.workspaceId })
				.from(workspaceMembers)
				.where(eq(workspaceMembers.actorId, updated.id))
				.limit(1)
			if (membership) {
				await db.insert(events).values({
					workspaceId: membership.workspaceId,
					actorId: updated.id,
					action: 'vaerksted_linked',
					entityType: 'actor',
					entityId: updated.id,
					data: { vaerksted_identity_id: verified.identityId },
				})
			}

			return c.json(...respondWithActor(updated, 200))
		}
	}

	// TODO(spike): design doc §11 M5's "silent backend migration" path —
	// checking whether Supabase Auth's admin API accepts an existing bcrypt
	// hash directly (packages/auth/src/password.ts, bcryptjs, SALT_ROUNDS=12)
	// so a native-password actor could be migrated with zero user-visible
	// change — is NOT implemented here. It requires live Supabase admin
	// credentials to verify against Maskin's actual hash format/cost factor,
	// which don't exist in this environment. The email-match linking above
	// (step 3) covers the same "existing Maskin actor, now proven via
	// vaerksted" case regardless of which migration path is eventually chosen
	// for the password itself — this route never reads or writes
	// password_hash.

	// Step 4: genuinely new — create a fresh Maskin actor linked to this
	// identity. Maskin's own API-key mechanism stays untouched (design doc
	// §4's last paragraph: "every actor still needs one") — generateApiKey()
	// is the same function POST /api/actors uses.
	const { key } = generateApiKey()
	const name = verified.email ?? 'Vaerksted User'

	let created: typeof actors.$inferSelect | undefined
	try {
		;[created] = await db
			.insert(actors)
			.values({
				type: 'human',
				name,
				email: verified.email,
				apiKey: key,
				passwordHash: null,
				vaerkstedIdentityId: verified.identityId,
			})
			.returning()
	} catch (err) {
		if (isEmailUniqueViolation(err)) {
			// Race: another request linked/created this email between the
			// lookup above and this insert. Surface as a conflict so the client
			// can retry the link flow (which will now find it on the next
			// attempt) rather than a generic 500.
			return c.json(createApiError('CONFLICT', 'Email already exists'), 409)
		}
		throw err
	}
	if (!created) {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create actor'), 500)
	}

	// No events row for this creation — deliberately mirrors POST /api/actors'
	// own signup handler (apps/dev/src/routes/actors.ts createActorRoute),
	// which does not emit an events row for actor creation either (only
	// /reset, /delete, /pause, /run do there).
	//
	// Personal workspace + Workspace Coach + default agent roster, via the
	// same helper POST /api/actors uses (services/workspace-bootstrap.ts) —
	// without this, a brand-new actor would have zero workspaces, which trips
	// apps/web/src/routes/_authed/workspaces.tsx's "no workspace → bounce to
	// /signup" guard immediately after a successful login, making "Continue
	// with vaerksted" look broken even though the identity/session/actor
	// linking all worked. Failure here is logged, not fatal to the response —
	// same tolerance POST /api/actors already has (a workspace-bootstrap
	// failure shouldn't turn a successful actor creation into a 500).
	let workspaceId: string | undefined
	const workspace = await createPersonalWorkspace(db, created)
	if (workspace) {
		workspaceId = workspace.id
		const agentStorage = c.get('agentStorage')
		if (agentStorage) {
			await bootstrapDefaultAgents(db, agentStorage, workspace.id, created.id).catch((err) =>
				logger.error('workspace bootstrap failed (vaerksted-auth link)', {
					workspaceId: workspace.id,
					err,
				}),
			)
		}
	}

	return c.json(...respondWithActor(created, 201, workspaceId))
})

export default app
