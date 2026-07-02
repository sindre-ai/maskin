import { createHash } from 'node:crypto'
import { OpenAPIHono, type RouteHandler, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { workspaceMembers, workspaces } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { type ClaudeOAuthTokens, encryptOAuthTokens, getValidOAuthToken } from '../lib/claude-oauth'
import {
	type OAuthFailoverState,
	type OAuthSlotKind,
	clearSlot,
	readFailoverState,
	readSlots,
	resolveActiveSlot,
	writeFailoverState,
	writeSlot,
} from '../lib/claude-oauth-slots'
import { createApiError } from '../lib/errors'
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

const app = new OpenAPIHono<Env>()

const slotKindSchema = z.enum(['primary', 'backup'])

const slotStatusSchema = z.object({
	subscription_type: z.string().optional(),
	expires_at: z.number(),
	fingerprint: z.string(),
})

const statusResponseSchema = z.object({
	// Back-compat: kept so existing callers (status route consumers, MCP
	// onboarding banner) continue to read a single boolean. Mirrors
	// `valid` below — true when the active slot has refreshable tokens.
	connected: z.boolean(),
	valid: z.boolean(),
	subscription_type: z.string().optional(),
	expires_at: z.number().optional(),
	// New shape for T8: per-slot info + the failover state T1 persists.
	slots: z.object({
		primary: slotStatusSchema.optional(),
		backup: slotStatusSchema.optional(),
	}),
	active_slot: slotKindSchema,
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
		let nextOAuth = clearSlot(settings.claude_oauth, slot)

		if (nextOAuth && wasActiveSlot) {
			// We just disconnected the slot session-start would have read next.
			// Repoint active_slot to whichever slot still has data so a healthy
			// remaining slot isn't orphaned by a stale pointer.
			const remainingSlot: OAuthSlotKind = slot === 'primary' ? 'backup' : 'primary'
			if (readSlots(nextOAuth)[remainingSlot]) {
				nextOAuth = writeFailoverState(nextOAuth, { active_slot: remainingSlot })
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
		active_slot: 'primary' as const,
	}

	const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
	if (!ws) {
		return c.json(emptyResponse)
	}

	const settings = (ws.settings as WorkspaceSettings) ?? {}
	const slots = readSlots(settings.claude_oauth)
	const failover = readFailoverState(settings.claude_oauth)

	const slotResponse: {
		primary?: { subscription_type?: string; expires_at: number; fingerprint: string }
		backup?: { subscription_type?: string; expires_at: number; fingerprint: string }
	} = {}
	if (slots.primary) {
		slotResponse.primary = {
			subscription_type: slots.primary.subscriptionType,
			expires_at: slots.primary.expiresAt,
			fingerprint: slotFingerprint(slots.primary),
		}
	}
	if (slots.backup) {
		slotResponse.backup = {
			subscription_type: slots.backup.subscriptionType,
			expires_at: slots.backup.expiresAt,
			fingerprint: slotFingerprint(slots.backup),
		}
	}

	if (!slots.primary && !slots.backup) {
		return c.json(emptyResponse)
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
		const activeData = slots[failover.active_slot]
		subscriptionType = activeData?.subscriptionType
		expiresAt = activeData?.expiresAt
	}

	return c.json({
		connected: true,
		valid,
		subscription_type: subscriptionType,
		expires_at: expiresAt,
		slots: slotResponse,
		active_slot: failover.active_slot,
		last_primary_failure_at: failover.last_primary_failure_at,
		last_classified_reason: failover.last_classified_reason,
		last_backup_failure_at: failover.last_backup_failure_at,
		last_backup_classified_reason: failover.last_backup_classified_reason,
	})
}) as RouteHandler<typeof statusRoute, Env>)

// ── POST /api/claude-oauth/import ───────────────────────────────────────────
// Accept raw tokens directly (from credentials.json paste). The `slot` field
// is optional for back-compat with the legacy single-slot importer — old
// clients keep working and the resolver treats the legacy shape as primary.

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
						slot: slotKindSchema.optional(),
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
						slot: slotKindSchema,
						subscription_type: z.string().optional(),
						expires_at: z.number(),
					}),
				},
			},
		},
		403: {
			description: 'Not a workspace member',
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
	const slot: OAuthSlotKind = requestedSlot ?? 'primary'
	const tokens: ClaudeOAuthTokens = tokenFields

	// Locked read-modify-write — see the disconnect route above for why.
	const found = await db.transaction(async (tx) => {
		const [ws] = await tx
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.for('update')
			.limit(1)
		if (!ws) return false

		const settings = (ws.settings as WorkspaceSettings) ?? {}
		const currentFailover = readFailoverState(settings.claude_oauth)
		const currentlyResolvable = resolveActiveSlot(settings.claude_oauth) !== undefined

		// Reset failover state (clearing any stale reason/failure timestamp) in
		// three cases: re-importing the slot that's already active (fresh
		// credentials deserve a clean slate), restoring the default primary
		// after a failover to backup, or nothing was resolvable beforehand (a
		// dangling active_slot pointer). Anything else — e.g. routine
		// credential rotation of an inactive slot while a different slot is
		// currently active and healthy — must leave `active_slot` and the
		// recorded failure state untouched; it must not silently steal traffic
		// away from a slot that's serving fine.
		const isReimportOfActiveSlot = currentFailover.active_slot === slot
		const isPrimaryRecovery = slot === 'primary' && currentFailover.active_slot === 'backup'
		const shouldResetFailoverState =
			isReimportOfActiveSlot || isPrimaryRecovery || !currentlyResolvable

		const withSlot = writeSlot(settings.claude_oauth, slot, encryptOAuthTokens(tokens))
		const nextOAuth = shouldResetFailoverState
			? writeFailoverState(withSlot, { active_slot: slot })
			: withSlot

		await tx
			.update(workspaces)
			.set({
				settings: { ...settings, claude_oauth: nextOAuth },
				updatedAt: new Date(),
			})
			.where(eq(workspaces.id, workspaceId))
		return true
	})

	if (!found) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	// BYOLLM ↔ paid plan mutex: importing Claude OAuth tokens is a BYOLLM
	// selection. Re-read the workspace after the slot-aware transaction and
	// cancel any live Stripe subscription so the customer isn't charged for
	// an inactive plan, then roll billing forward.
	const [wsAfter] = await db
		.select()
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	const settingsAfter = (wsAfter?.settings as WorkspaceSettings) ?? {}
	if (hasActivePaidPlan({ billing: settingsAfter.billing })) {
		let stripeEnv: ReturnType<typeof readStripeEnv>
		try {
			stripeEnv = readStripeEnv()
		} catch (err) {
			logger.error('Cannot cancel paid plan for Claude OAuth import: Stripe is not configured', {
				workspaceId,
				error: err instanceof Error ? err.message : String(err),
			})
			return c.json(createApiError('INTERNAL_ERROR', 'Stripe is not configured'), 500)
		}
		try {
			await cancelActivePaidSubscription(
				getStripeClient(stripeEnv),
				// biome-ignore lint/style/noNonNullAssertion: hasActivePaidPlan guarantees this
				settingsAfter.billing!.stripe_subscription_id!,
			)
		} catch (err) {
			logger.error('Stripe subscription cancel failed during Claude OAuth import', {
				workspaceId,
				subscriptionId: settingsAfter.billing?.stripe_subscription_id,
				error: err instanceof Error ? err.message : String(err),
			})
			return c.json(createApiError('INTERNAL_ERROR', 'Failed to cancel paid subscription'), 500)
		}
		const downgrade = billingAfterByoTransition(settingsAfter.billing)
		if (downgrade) {
			await db
				.update(workspaces)
				.set({
					settings: { ...settingsAfter, billing: downgrade },
					updatedAt: new Date(),
				})
				.where(eq(workspaces.id, workspaceId))
		}
		logger.info('Paid plan canceled during Claude OAuth import', {
			workspaceId,
			subscriptionId: settingsAfter.billing?.stripe_subscription_id,
		})
	}

	logger.info('Claude OAuth tokens imported for workspace', {
		workspaceId,
		slot,
		subscriptionType: tokens.subscriptionType,
	})

	return c.json({
		success: true,
		slot,
		subscription_type: tokens.subscriptionType,
		expires_at: tokens.expiresAt,
	})
}) as RouteHandler<typeof importRoute, Env>)

// ── POST /api/claude-oauth/swap ─────────────────────────────────────────────
// Swap the data in the primary and backup slots. The on-disk keys
// (`primary` / `backup`) stay stable so session-start always reads
// `primary` first — the user-facing designation IS the data placement.

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
		const slots = readSlots(settings.claude_oauth)
		if (!slots.primary || !slots.backup) return 'incomplete' as const

		// Swap the data, then reset failover state — what was unhealthy is now
		// the backup, so the next session-start should try primary fresh.
		let nextOAuth = writeSlot(settings.claude_oauth, 'primary', slots.backup)
		nextOAuth = writeSlot(nextOAuth, 'backup', slots.primary)
		const resetFailover: OAuthFailoverState = { active_slot: 'primary' }
		nextOAuth = writeFailoverState(nextOAuth, resetFailover)

		await tx
			.update(workspaces)
			.set({
				settings: { ...settings, claude_oauth: nextOAuth },
				updatedAt: new Date(),
			})
			.where(eq(workspaces.id, workspaceId))

		return 'ok' as const
	})

	if (result === 'not_found') {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}
	if (result === 'incomplete') {
		return c.json(
			createApiError('BAD_REQUEST', 'Both primary and backup slots must be connected to swap'),
			400,
		)
	}

	logger.info('Claude OAuth slots swapped for workspace', { workspaceId })
	return c.json({ success: true })
}) as RouteHandler<typeof swapRoute, Env>)

export default app
