import { createHash } from 'node:crypto'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { workspaceMembers, workspaces } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import {
	ACCOUNT_LOOKUP_RETRY_MS,
	type ClaudeAccountIdentity,
	type ClaudeOAuthTokens,
	decryptAccountIdentity,
	decryptOAuthData,
	encryptAccountIdentity,
	encryptOAuthTokens,
	fetchClaudeAccount,
	getValidOAuthToken,
	preserveSlotLabels,
} from '../lib/claude-oauth'
import {
	MAX_OAUTH_SLOTS,
	type OAuthSlotData,
	type OAuthSlotKind,
	clearSlot,
	isSlotId,
	nextFreeSlotId,
	nextSlotAfter,
	promoteSlot,
	readChain,
	readFailoverState,
	readSlots,
	resolveActiveSlot,
	slotFailure,
	slotIndexOf,
	withSlotFailure,
	writeFailoverState,
	writeSlot,
} from '../lib/claude-oauth-slots'
import { isEnterprise } from '../lib/enterprise'
import { createApiError, validationFailureHook } from '../lib/errors'
import {
	billingAfterByoTransition,
	cancelActivePaidSubscription,
	hasActivePaidPlan,
} from '../lib/llm-source-mutex'
import { logger } from '../lib/logger'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { getStripeClient, readStripeEnv } from '../lib/stripe'
import type { WorkspaceSettings } from '../lib/types'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

/**
 * A slot id: `primary`, `backup`, or `slot_3`…`slot_10`. Kept as a validated
 * string rather than an enum so the chain can grow without a schema change —
 * `isSlotId` (claude-oauth-slots.ts) owns which ids exist.
 */
const slotKindSchema = z.string().refine(isSlotId, {
	message: 'slot must be primary, backup, or slot_3 … slot_10',
})

/** Import target: an existing slot, or `new` to append to the chain. */
const importSlotSchema = z.string().refine((v) => v === 'new' || isSlotId(v), {
	message: 'slot must be primary, backup, slot_3 … slot_10, or new',
})

const slotStatusSchema = z.object({
	slot: z.string(),
	/** Position in the failover chain — 0 is the one sessions try first. */
	position: z.number(),
	subscription_type: z.string().optional(),
	expires_at: z.number(),
	fingerprint: z.string(),
	nickname: z.string().optional(),
	/** Who Anthropic says this subscription belongs to. Display only. */
	account_email: z.string().optional(),
	account_organization: z.string().optional(),
	/** When this slot was last classified unusable, and why. */
	failure_at: z.number().optional(),
	failure_reason: z.string().optional(),
})

// Free-text label users attach to a slot so multiple credentials are
// distinguishable in the UI instead of only showing an opaque fingerprint.
const nicknameSchema = z.string().trim().max(60)

const statusResponseSchema = z.object({
	// Back-compat: kept so existing callers (status route consumers, MCP
	// onboarding banner) continue to read a single boolean. Mirrors
	// `valid` below — true when the active slot has refreshable tokens.
	connected: z.boolean(),
	valid: z.boolean(),
	subscription_type: z.string().optional(),
	expires_at: z.number().optional(),
	// Per-slot info keyed by slot id. `primary` and `backup` are still the
	// first two keys, so callers written against the two-slot shape keep
	// working; `chain` is what a client should iterate to render them in
	// failover order.
	slots: z.record(slotStatusSchema),
	chain: z.array(z.string()),
	/** How many more subscriptions this workspace can connect. */
	slots_remaining: z.number(),
	active_slot: z.string(),
	// Legacy mirrors of the first two slots' failure records — kept so the
	// existing status consumers don't have to learn `slots[id].failure_*`.
	last_primary_failure_at: z.number().optional(),
	last_classified_reason: z.string().optional(),
	last_backup_failure_at: z.number().optional(),
	last_backup_classified_reason: z.string().optional(),
})

async function requireWorkspaceMember(db: Database, workspaceId: string, actorId: string) {
	const [member] = await db
		.select()
		.from(workspaceMembers)
		.where(
			and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.actorId, actorId)),
		)
		.limit(1)
	return member ?? null
}

function slotFingerprint(slot: {
	encryptedAccessToken: string
	encryptedRefreshToken: string
}): string {
	return createHash('sha256')
		.update(`${slot.encryptedAccessToken}:${slot.encryptedRefreshToken}`)
		.digest('hex')
		.slice(0, 8)
}

// ── DELETE /api/claude-oauth ────────────────────────────────────────────────

const disconnectRoute = createRoute({
	method: 'delete',
	path: '/',
	tags: ['claude-oauth'],
	summary: 'Disconnect a Claude OAuth slot (default: primary)',
	request: {
		headers: workspaceIdHeader,
		query: z.object({ slot: slotKindSchema.optional() }),
	},
	responses: {
		200: {
			description: 'OAuth tokens removed',
			content: {
				'application/json': {
					schema: z.object({ success: z.boolean() }),
				},
			},
		},
		403: {
			description: 'Not a workspace member',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(disconnectRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { slot } = c.req.valid('query')

	const member = await requireWorkspaceMember(db, workspaceId, actorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	// Locked read-modify-write so a concurrent session-start (which persists
	// refreshed tokens or a failover transition via its own `SELECT ... FOR
	// UPDATE`) can't have its write silently clobbered by this route's stale
	// snapshot, or vice versa.
	const found = await db.transaction(async (tx) => {
		const [ws] = await tx
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for('update')
			.limit(1)
		if (!ws) return false

		const settings = (ws.settings as WorkspaceSettings) ?? {}

		if (!slot) {
			// Back-compat path used by older clients and the "remove credentials"
			// fallback when the row is in an unparseable state — drop the whole key.
			const { claude_oauth: _, ...rest } = settings
			await tx
				.update(workspaces)
				.set({ settings: rest, updatedAt: new Date() })
				.where(eq(workspaces.id, workspaceId))
			logger.info('Claude OAuth disconnected for workspace', { workspaceId, slot: 'all' })
			return true
		}

		const wasActiveSlot = readFailoverState(settings.claude_oauth).active_slot === slot
		// The slot session-start would try after this one, decided BEFORE the
		// removal so the chain still contains the slot being removed.
		const successor =
			nextSlotAfter(settings.claude_oauth, slot) ?? readChain(settings.claude_oauth)[0]?.id
		let nextOAuth = clearSlot(settings.claude_oauth, slot)

		if (nextOAuth && wasActiveSlot) {
			// We just disconnected the slot session-start would have read next.
			// Repoint active_slot at the next slot still holding data (falling
			// back to the head of what's left) so a healthy remaining slot isn't
			// orphaned by a stale pointer.
			const remaining = readSlots(nextOAuth)
			const repointed = successor && remaining[successor] ? successor : readChain(nextOAuth)[0]?.id
			if (repointed) {
				// Clear the failure recorded against the slot we're pointing at:
				// it's about to serve every session, and a stale reason from
				// before would read as "unhealthy" with no failover left to
				// explain it. Other slots keep their records.
				nextOAuth = writeFailoverState(nextOAuth, {
					...withSlotFailure(readFailoverState(nextOAuth), repointed, undefined),
					active_slot: repointed,
				})
			}
		}

		let nextSettings: WorkspaceSettings
		if (nextOAuth) {
			nextSettings = { ...settings, claude_oauth: nextOAuth }
		} else {
			const { claude_oauth: _, ...rest } = settings
			nextSettings = rest
		}

		await tx
			.update(workspaces)
			.set({ settings: nextSettings, updatedAt: new Date() })
			.where(eq(workspaces.id, workspaceId))

		logger.info('Claude OAuth slot disconnected for workspace', { workspaceId, slot })
		return true
	})

	if (!found) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}
	return c.json({ success: true })
}) as RouteHandler<typeof disconnectRoute, Env>)

// ── GET /api/claude-oauth/status ────────────────────────────────────────────

const statusRoute = createRoute({
	method: 'get',
	path: '/status',
	tags: ['claude-oauth'],
	summary: 'Get Claude OAuth connection status (per slot + failover state)',
	request: {
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description: 'OAuth status',
			content: { 'application/json': { schema: statusResponseSchema } },
		},
		403: {
			description: 'Not a workspace member',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(statusRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const member = await requireWorkspaceMember(db, workspaceId, actorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const emptyResponse = {
		connected: false,
		valid: false,
		slots: {},
		chain: [] as string[],
		slots_remaining: MAX_OAUTH_SLOTS,
		active_slot: 'primary',
	}

	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	if (!ws) {
		return c.json(emptyResponse)
	}

	const settings = (ws.settings as WorkspaceSettings) ?? {}
	const chain = readChain(settings.claude_oauth)
	const failover = readFailoverState(settings.claude_oauth)

	if (chain.length === 0) {
		return c.json(emptyResponse)
	}

	// Label any slot connected before we started reading the account identity
	// (or whose earlier lookup failed). Best-effort and self-limiting: it only
	// runs for slots that have no label AND a token that hasn't expired, so a
	// settings page load costs at most one profile call per unlabelled slot,
	// once.
	const accounts = await backfillAccountLabels(db, workspaceId, chain)

	const slotResponse: Record<string, z.infer<typeof slotStatusSchema>> = {}
	for (const [position, entry] of chain.entries()) {
		const failure = slotFailure(failover, entry.id)
		const account =
			accounts.get(entry.id) ??
			(entry.data.account ? decryptAccountIdentity(entry.data.account) : undefined)
		slotResponse[entry.id] = {
			slot: entry.id,
			position,
			subscription_type: entry.data.subscriptionType,
			expires_at: entry.data.expiresAt,
			fingerprint: slotFingerprint(entry.data),
			nickname: entry.data.nickname,
			account_email: account?.email,
			account_organization: account?.organization,
			failure_at: failure.at,
			failure_reason: failure.reason,
		}
	}

	// Refresh the currently-active slot to surface the canonical `valid` flag
	// the existing UI banner depends on (and to keep this endpoint a refresh
	// trigger as it was before T8).
	let valid = false
	let subscriptionType: string | undefined
	let expiresAt: number | undefined
	try {
		const result = await getValidOAuthToken(db, workspaceId, 0)
		if (result) {
			valid = true
			subscriptionType = result.tokens.subscriptionType
			expiresAt = result.tokens.expiresAt
		}
	} catch {
		// Active slot exists but couldn't refresh — surface as connected/invalid.
		const activeData = chain.find((entry) => entry.id === failover.active_slot)?.data
		subscriptionType = activeData?.subscriptionType
		expiresAt = activeData?.expiresAt
	}

	return c.json({
		connected: true,
		valid,
		subscription_type: subscriptionType,
		expires_at: expiresAt,
		slots: slotResponse,
		chain: chain.map((entry) => entry.id),
		slots_remaining: MAX_OAUTH_SLOTS - chain.length,
		active_slot: failover.active_slot,
		last_primary_failure_at: failover.last_primary_failure_at,
		last_classified_reason: failover.last_classified_reason,
		last_backup_failure_at: failover.last_backup_failure_at,
		last_backup_classified_reason: failover.last_backup_classified_reason,
	})
}) as RouteHandler<typeof statusRoute, Env>)

/**
 * Fill in the Anthropic account identity for connected slots that don't have
 * one yet, returning what was learned (keyed by slot id) so the caller can
 * render it without re-reading the row.
 *
 * Deliberately conservative:
 *   - only slots with NO stored identity are looked up, so this is a one-time
 *     cost per slot rather than a per-page-load one;
 *   - only slots whose access token is still valid, so nothing here triggers a
 *     token refresh or a chain of them;
 *   - every failure is swallowed — a settings page must render whether or not
 *     Anthropic can tell us who the subscription belongs to.
 */
async function backfillAccountLabels(
	db: Database,
	workspaceId: string,
	chain: Array<{ id: OAuthSlotKind; data: OAuthSlotData }>,
): Promise<Map<OAuthSlotKind, ClaudeAccountIdentity>> {
	const now = Date.now()
	const learned = new Map<OAuthSlotKind, ClaudeAccountIdentity>()
	const candidates = chain.filter(
		(entry) =>
			entry.data.expiresAt > now &&
			(!entry.data.account || now - entry.data.account.fetchedAt > ACCOUNT_LOOKUP_RETRY_MS),
	)
	if (candidates.length === 0) return learned

	await Promise.all(
		candidates.map(async (entry) => {
			// Every ATTEMPT is recorded, not just every success. Without that, a
			// subscription whose identity we can't read — a shape we don't
			// parse, a revoked token — would be asked about again on every
			// settings page load for the rest of time.
			let account: ClaudeAccountIdentity = { fetchedAt: now }
			try {
				const tokens = decryptOAuthData(entry.data)
				account = (await fetchClaudeAccount(tokens.accessToken)) ?? account
			} catch (err) {
				logger.debug('Could not read the Claude account identity for a slot', {
					workspaceId,
					slot: entry.id,
					error: err instanceof Error ? err.message : String(err),
				})
			}
			learned.set(entry.id, account)
		}),
	)
	if (learned.size === 0) return learned

	// One locked read-modify-write for everything learned — see the disconnect
	// route for why the lock is needed. Non-fatal: if this write loses a race
	// the labels are simply looked up again on the next load.
	try {
		await db.transaction(async (tx) => {
			const [latest] = await tx
				.select()
				.from(workspaces)
				.where(eq(workspaces.id, workspaceId))
				.for('update')
				.limit(1)
			if (!latest) return
			const latestSettings = (latest.settings as Record<string, unknown>) ?? {}
			let nextOAuth = latestSettings.claude_oauth
			for (const [slot, account] of learned) {
				const stored = readSlots(nextOAuth)[slot]
				// The slot may have been disconnected, replaced, or labelled by a
				// concurrent request while the lookups were in flight; only write
				// over an identity that is still missing or past its retry window.
				if (!stored) continue
				if (stored.account && now - stored.account.fetchedAt <= ACCOUNT_LOOKUP_RETRY_MS) continue
				nextOAuth = writeSlot(nextOAuth, slot, {
					...stored,
					account: encryptAccountIdentity(account),
				})
			}
			if (nextOAuth === latestSettings.claude_oauth) return
			await tx
				.update(workspaces)
				.set({
					settings: { ...latestSettings, claude_oauth: nextOAuth },
					updatedAt: new Date(),
				})
				.where(eq(workspaces.id, workspaceId))
		})
	} catch (err) {
		logger.debug('Could not persist Claude account labels', {
			workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
	return learned
}

// ── POST /api/claude-oauth/import ───────────────────────────────────────────
// Accept raw tokens directly (from credentials.json paste). `slot` names the
// slot to write: an existing id, `new` to append the credential to the end of
// the failover chain, or omitted (back-compat with the legacy single-slot
// importer, which only ever wrote the primary).

const importRoute = createRoute({
	method: 'post',
	path: '/import',
	tags: ['claude-oauth'],
	summary: 'Import Claude OAuth tokens into a slot (default: primary)',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: z.object({
						accessToken: z.string().min(1),
						refreshToken: z.string().min(1),
						expiresAt: z.number(),
						subscriptionType: z.string().optional(),
						scopes: z.array(z.string()).optional(),
						slot: importSlotSchema.optional(),
						nickname: nicknameSchema.optional(),
					}),
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Tokens imported and stored',
			content: {
				'application/json': {
					schema: z.object({
						success: z.boolean(),
						slot: z.string(),
						subscription_type: z.string().optional(),
						expires_at: z.number(),
						nickname: z.string().optional(),
					}),
				},
			},
		},
		403: {
			description: 'Not a workspace member',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'The workspace already holds the maximum number of subscriptions',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(importRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const member = await requireWorkspaceMember(db, workspaceId, actorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const body = c.req.valid('json')
	const { slot: requestedSlot, ...tokenFields } = body
	// Ask Anthropic who this subscription belongs to BEFORE opening the
	// transaction — a display lookup must not hold the workspace row lock
	// across a network call. Guarded here as well as inside
	// `fetchClaudeAccount`: importing a credential must not be able to fail
	// because we could not work out what to call it, and that guarantee
	// shouldn't rest on a promise made in another file.
	const account = await fetchClaudeAccount(tokenFields.accessToken).catch(() => undefined)
	const tokens: ClaudeOAuthTokens = { ...tokenFields, account }

	// Locked read-modify-write — see the disconnect route above for why.
	//
	// BYO-LLM ↔ paid plan mutex: importing Claude OAuth is a BYO-LLM selection,
	// so any live Stripe subscription must be canceled BEFORE the transaction
	// commits — otherwise a Stripe cancel failure would leave the workspace
	// with new BYO tokens AND a still-billing paid plan. Sentinel outcomes
	// let the outer handler translate the txn result into the right HTTP
	// status without throwing across the transaction boundary.
	type ImportOutcome =
		| { kind: 'ok'; slot: OAuthSlotKind }
		| { kind: 'not-found' }
		| { kind: 'not-allowed' }
		| { kind: 'chain-full' }
		| { kind: 'stripe-config' }
		| { kind: 'stripe-cancel' }
	const outcome: ImportOutcome = await db.transaction(async (tx) => {
		const [ws] = await tx
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for('update')
			.limit(1)
		if (!ws) return { kind: 'not-found' }
		// Every workspace defaults to the Maskin-provided LLM plan; only
		// ops-flagged exception workspaces may import a BYO Claude subscription.
		// See PR #970.
		if (!isEnterprise(ws)) return { kind: 'not-allowed' }

		const settings = (ws.settings as WorkspaceSettings) ?? {}
		const currentFailover = readFailoverState(settings.claude_oauth)
		const currentlyResolvable = resolveActiveSlot(settings.claude_oauth) !== undefined

		// `new` appends to the chain; an explicit id overwrites that slot;
		// omitted stays on the legacy single-slot behaviour.
		let slot: OAuthSlotKind
		if (!requestedSlot) {
			slot = 'primary'
		} else if (requestedSlot === 'new') {
			const free = nextFreeSlotId(settings.claude_oauth)
			if (!free) return { kind: 'chain-full' }
			slot = free
		} else {
			slot = requestedSlot
		}

		// Reset failover state (clearing any stale reason/failure timestamp) in
		// three cases: re-importing the slot that's already active (fresh
		// credentials deserve a clean slate), importing into a slot EARLIER in
		// the chain than the active one (a repaired primary should take traffic
		// back), or nothing was resolvable beforehand (a dangling active_slot
		// pointer). Anything else — e.g. routine credential rotation of a slot
		// further down the chain while an earlier one is serving fine — must
		// leave `active_slot` untouched; it must not silently steal traffic
		// away from a slot that's working.
		const isReimportOfActiveSlot = currentFailover.active_slot === slot
		const isEarlierSlotRecovery =
			slotIndexOf(slot) < slotIndexOf(currentFailover.active_slot) && currentlyResolvable
		const shouldResetFailoverState =
			isReimportOfActiveSlot || isEarlierSlotRecovery || !currentlyResolvable

		// Replacing a credential is not renaming it: an import that carries no
		// nickname keeps whatever the slot was already called. Re-pasting
		// credentials when a subscription expires is the most common reason to
		// hit this route, and silently dropping the label there is the second
		// way a nickname used to disappear on its own.
		const existingSlot = readSlots(settings.claude_oauth)[slot]
		const withSlot = writeSlot(
			settings.claude_oauth,
			slot,
			preserveSlotLabels(encryptOAuthTokens(tokens), existingSlot),
		)
		// Fresh credentials for a slot always clear that slot's recorded
		// failure, whether or not traffic moves back to it — otherwise the
		// settings page keeps showing "authentication failed" against a
		// credential the user has just replaced.
		const clearedFailure = withSlotFailure(currentFailover, slot, undefined)
		const nextOAuth = writeFailoverState(withSlot, {
			...clearedFailure,
			active_slot: shouldResetFailoverState ? slot : currentFailover.active_slot,
		})

		const nextSettings: Record<string, unknown> = {
			...settings,
			claude_oauth: nextOAuth,
		}

		if (hasActivePaidPlan({ billing: settings.billing })) {
			let stripeEnv: ReturnType<typeof readStripeEnv>
			try {
				stripeEnv = readStripeEnv()
			} catch (err) {
				logger.error('Cannot cancel paid plan for Claude OAuth import: Stripe is not configured', {
					workspaceId,
					error: err instanceof Error ? err.message : String(err),
				})
				return { kind: 'stripe-config' }
			}
			try {
				await cancelActivePaidSubscription(
					getStripeClient(stripeEnv),
					// biome-ignore lint/style/noNonNullAssertion: hasActivePaidPlan guarantees this
					settings.billing!.stripe_subscription_id!,
				)
			} catch (err) {
				logger.error('Stripe subscription cancel failed during Claude OAuth import', {
					workspaceId,
					subscriptionId: settings.billing?.stripe_subscription_id,
					error: err instanceof Error ? err.message : String(err),
				})
				return { kind: 'stripe-cancel' }
			}
			const downgrade = billingAfterByoTransition(settings.billing)
			if (downgrade) nextSettings.billing = downgrade
			logger.info('Paid plan canceled during Claude OAuth import', {
				workspaceId,
				subscriptionId: settings.billing?.stripe_subscription_id,
			})
		}

		await tx
			.update(workspaces)
			.set({
				settings: nextSettings,
				updatedAt: new Date(),
			})
			.where(eq(workspaces.id, workspaceId))
		return { kind: 'ok', slot }
	})

	if (outcome.kind === 'not-found') {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}
	if (outcome.kind === 'not-allowed') {
		return c.json(
			createApiError(
				'FORBIDDEN',
				'This workspace is on the Maskin-provided LLM plan and cannot import BYO Claude credentials',
			),
			403,
		)
	}
	if (outcome.kind === 'chain-full') {
		return c.json(
			createApiError(
				'CONFLICT',
				`This workspace already has ${MAX_OAUTH_SLOTS} Claude subscriptions connected — disconnect one first`,
			),
			409,
		)
	}
	if (outcome.kind === 'stripe-config') {
		return c.json(createApiError('INTERNAL_ERROR', 'Stripe is not configured'), 500)
	}
	if (outcome.kind === 'stripe-cancel') {
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to cancel paid subscription'), 500)
	}

	logger.info('Claude OAuth tokens imported for workspace', {
		workspaceId,
		slot: outcome.slot,
		subscriptionType: tokens.subscriptionType,
	})

	return c.json({
		success: true,
		slot: outcome.slot,
		subscription_type: tokens.subscriptionType,
		expires_at: tokens.expiresAt,
		nickname: tokens.nickname,
	})
}) as RouteHandler<typeof importRoute, Env>)

// ── PATCH /api/claude-oauth/nickname ────────────────────────────────────────
// Rename (or clear, via an empty string) a slot's nickname without touching
// its tokens — a lightweight sibling to /import for the common "just relabel
// it" case so callers don't need to re-paste credentials to rename a slot.

const renameRoute = createRoute({
	method: 'patch',
	path: '/nickname',
	tags: ['claude-oauth'],
	summary: "Set or clear a slot's nickname",
	request: {
		headers: workspaceIdHeader,
		body: {
			content: {
				'application/json': {
					schema: z.object({
						slot: slotKindSchema,
						nickname: nicknameSchema,
					}),
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Nickname updated',
			content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
		},
		403: {
			description: 'Not a workspace member',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found or slot not connected',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(renameRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { slot, nickname } = c.req.valid('json')

	const member = await requireWorkspaceMember(db, workspaceId, actorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	// Locked read-modify-write — see the disconnect route above for why.
	const result = await db.transaction(async (tx) => {
		const [ws] = await tx
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for('update')
			.limit(1)
		if (!ws) return 'not_found' as const

		const settings = (ws.settings as WorkspaceSettings) ?? {}
		const existing = readSlots(settings.claude_oauth)[slot]
		if (!existing) return 'slot_empty' as const

		const nextData = { ...existing, nickname: nickname || undefined }
		const nextOAuth = writeSlot(settings.claude_oauth, slot, nextData)

		await tx
			.update(workspaces)
			.set({ settings: { ...settings, claude_oauth: nextOAuth }, updatedAt: new Date() })
			.where(eq(workspaces.id, workspaceId))
		return 'ok' as const
	})

	if (result === 'not_found') {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}
	if (result === 'slot_empty') {
		return c.json(createApiError('NOT_FOUND', 'Slot not connected'), 404)
	}

	logger.info('Claude OAuth slot nickname updated', { workspaceId, slot })
	return c.json({ success: true })
}) as RouteHandler<typeof renameRoute, Env>)

// ── POST /api/claude-oauth/promote ──────────────────────────────────────────
// Move a slot to the head of the failover chain. The on-disk slot ids stay put
// (`primary` is always position 0, so session-start reads it first) — it is the
// CREDENTIAL DATA that rotates between them, which is what makes the user-facing
// order and the storage order the same thing.

const promoteRoute = createRoute({
	method: 'post',
	path: '/promote',
	tags: ['claude-oauth'],
	summary: 'Move a subscription to the front of the failover chain',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: { 'application/json': { schema: z.object({ slot: slotKindSchema }) } },
		},
	},
	responses: {
		200: {
			description: 'Chain reordered',
			content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
		},
		403: {
			description: 'Not a workspace member',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found or slot not connected',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(promoteRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { slot } = c.req.valid('json')

	const member = await requireWorkspaceMember(db, workspaceId, actorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const result = await promoteToHead(db, workspaceId, slot)
	if (result === 'not_found') {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}
	if (result === 'slot_empty') {
		return c.json(createApiError('NOT_FOUND', 'Slot not connected'), 404)
	}

	logger.info('Claude OAuth slot promoted to the head of the chain', { workspaceId, slot })
	return c.json({ success: true })
}) as RouteHandler<typeof promoteRoute, Env>)

// ── POST /api/claude-oauth/swap ─────────────────────────────────────────────
// Back-compat sibling of /promote for the two-slot case: swap the primary and
// backup designations. Equivalent to promoting `backup`.

const swapRoute = createRoute({
	method: 'post',
	path: '/swap',
	tags: ['claude-oauth'],
	summary: 'Swap the primary and backup designations',
	request: {
		headers: workspaceIdHeader,
	},
	responses: {
		200: {
			description: 'Designations swapped',
			content: {
				'application/json': {
					schema: z.object({ success: z.boolean() }),
				},
			},
		},
		400: {
			description: 'Both slots must be connected to swap',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Not a workspace member',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

app.openapi(swapRoute, (async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const member = await requireWorkspaceMember(db, workspaceId, actorId)
	if (!member) {
		return c.json(createApiError('FORBIDDEN', 'Not a member of this workspace'), 403)
	}

	const result = await promoteToHead(db, workspaceId, 'backup', { requirePrimary: true })
	if (result === 'not_found') {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}
	if (result === 'slot_empty') {
		return c.json(
			createApiError('BAD_REQUEST', 'Both primary and backup slots must be connected to swap'),
			400,
		)
	}

	logger.info('Claude OAuth slots swapped for workspace', { workspaceId })
	return c.json({ success: true })
}) as RouteHandler<typeof swapRoute, Env>)

/**
 * Rotate `slot`'s credential to the head of the chain under a row lock — see
 * the disconnect route for why the read-modify-write must be locked.
 *
 * The failover state is reset to "start from the head again, with a clean
 * slate": the per-slot failure records are keyed by slot id and the data under
 * those ids has just moved, so keeping them would attribute one credential's
 * failure to another.
 */
async function promoteToHead(
	db: Database,
	workspaceId: string,
	slot: OAuthSlotKind,
	opts: { requirePrimary?: boolean } = {},
): Promise<'ok' | 'not_found' | 'slot_empty'> {
	return db.transaction(async (tx) => {
		const [ws] = await tx
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for('update')
			.limit(1)
		if (!ws) return 'not_found' as const

		const settings = (ws.settings as WorkspaceSettings) ?? {}
		const slots = readSlots(settings.claude_oauth)
		if (!slots[slot]) return 'slot_empty' as const
		if (opts.requirePrimary && !slots.primary) return 'slot_empty' as const

		const promoted = promoteSlot(settings.claude_oauth, slot)
		if (!promoted) return 'slot_empty' as const
		const head = readChain(promoted)[0]?.id ?? 'primary'
		const nextOAuth = writeFailoverState(promoted, { active_slot: head })

		await tx
			.update(workspaces)
			.set({
				settings: { ...settings, claude_oauth: nextOAuth },
				updatedAt: new Date(),
			})
			.where(eq(workspaces.id, workspaceId))

		return 'ok' as const
	})
}

export default app
