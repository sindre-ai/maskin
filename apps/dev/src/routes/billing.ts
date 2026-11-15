import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { workspaces } from '@maskin/db/schema'
import {
	ApiErrorCode,
	type BillingPlan,
	CREDIT_TOPUP_MAX_USD,
	CREDIT_TOPUP_MIN_USD,
	PAID_PLANS,
	autoTopUpResponseSchema,
	autoTopUpRuleSchema,
	dailyBudgetResponseSchema,
	setDailyBudgetSchema,
	storedDailyBudgetSchema,
	toPercentBudget,
	usdCentsToApproxDkk,
	workspaceSettingsSchema,
} from '@maskin/shared'
import { eq, sql } from 'drizzle-orm'
import { AUTO_TOP_UP_EVENT, autoTopUpClosedForPlans } from '../lib/auto-top-up'
import { DEFAULT_PERIOD_LENGTH_MS, resolvePlanCapCents } from '../lib/billing-defaults'
import { USAGE_BREAKDOWN_MAX_ROWS, readUsageBreakdown } from '../lib/billing-usage-breakdown'
import { cachedBillingUsage, evictBillingUsage } from '../lib/billing-usage-cache'
import { resolveWorkspaceCapCents } from '../lib/daily-budget'
import { isEnterprise, isEnterpriseWorkspace } from '../lib/enterprise'
import { createApiError } from '../lib/errors'
import { recordEvent } from '../lib/events/record-event'
import {
	getConnectedLinkedInIdentityCount,
	resolveLinkedInIdentityAddon,
} from '../lib/linkedin-addon'
import { getWorkspacePlanUsdCentsUsage } from '../lib/llm-routing'
import {
	billingAfterCancel,
	cancelActivePaidSubscription,
	hasActivePaidPlan,
} from '../lib/llm-source-mutex'
import { logger } from '../lib/logger'
import { shouldSkipOnboardingKickoff } from '../lib/onboarding/chief-of-staff-kickoff'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import {
	CREDIT_TOPUP_BOUNDS_MINOR,
	createCheckoutSession,
	getStripeClient,
	readStripeEnv,
} from '../lib/stripe'
import {
	TrialCardAlreadyUsedError,
	TrialCardError,
	createTrialSetup,
	startTrial,
} from '../lib/trial-card'
import {
	TrialPromoCodeInvalidError,
	hitPromoRateLimit,
	promoCodeTrialDays,
	startTrialWithPromo,
} from '../lib/trial-promo'
import { extractClientIp } from '../lib/trusted-proxy'
import type { WorkspaceSettings } from '../lib/types'
import { assertWorkspaceWriterRole, isWorkspaceHumanAdminOrOwner } from '../lib/workspace-auth'
import { startChiefOfStaffWelcome } from '../services/workspace-bootstrap'

/**
 * Fallback hard caps (USD cents) for paid plans when
 * `billing.hard_cap_usd_cents` hasn't been populated yet (delayed Stripe
 * webhook, partial state after a webhook failure).
 *
 * Delegates to `resolvePlanCapCents` so the cap shown here is byte-identical
 * to the one `lib/llm-routing.ts` enforces — these were two separate
 * implementations, and the enforcement side used to fail open to *no* cap for
 * pro/team in exactly this window. Env is read defensively (not via
 * `readStripeEnv`, which throws when Stripe is unconfigured) because
 * `/api/billing/usage` must keep serving usage regardless.
 */
function planHardCapFallback(plan: BillingPlan): number | null {
	return resolvePlanCapCents(plan)
}

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		/** Caller's role in the X-Workspace-Id workspace, set by authMiddleware. */
		workspaceRole?: string
	}
}

const app = new OpenAPIHono<Env>()

const checkoutBodySchema = z.object({
	plan: z.enum(PAID_PLANS),
	success_url: z.string().url(),
	cancel_url: z.string().url(),
})

const checkoutResponseSchema = z.object({
	url: z.string().url(),
	session_id: z.string(),
})

const checkoutRoute = createRoute({
	method: 'post',
	path: '/checkout',
	'x-viewer-policy': 'writer',
	tags: ['billing'],
	summary: 'Start a Stripe Checkout session for a Maskin subscription',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: { 'application/json': { schema: checkoutBodySchema } },
			required: true,
		},
	},
	responses: {
		200: {
			description: 'Checkout session created',
			content: { 'application/json': { schema: checkoutResponseSchema } },
		},
		400: {
			description: 'Bad request',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Caller is not permitted to manage billing for this workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Stripe misconfigured or upstream failure',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

// The LinkedIn Identity add-on line — $49/connected-identity/month, gated on
// ≥1 connected `linkedin-unipile` credential. Null when no identities are
// connected or the workspace is enterprise; see `../lib/linkedin-addon.ts`.
const linkedinIdentityAddonSchema = z
	.object({
		count: z.number().int().nonnegative(),
		unit_price_usd_cents: z.number().int().positive(),
		monthly_total_usd_cents: z.number().int().nonnegative(),
	})
	.nullable()

const usageResponseSchema = z.object({
	plan: z.enum(['trial', ...PAID_PLANS, 'enterprise']),
	status: z.enum(['active', 'past_due', 'canceled', 'incomplete']),
	// Actual dollar cost incurred this period, in USD cents — not a token
	// count, since different agents can run different models with different
	// $/token ratios.
	usd_cents_used: z.number().int().nonnegative(),
	hard_cap_usd_cents: z.number().int().positive().nullable(),
	period_start: z.number().int().nonnegative().nullable(),
	period_resets_in_ms: z.number().int().nullable(),
	stripe_customer_id: z.string().nullable(),
	stripe_subscription_id: z.string().nullable(),
	// Prepaid usage-credits balance, in USD cents. Only meaningful for
	// paid plans — see `lib/credit-billing.ts`. No new balance can be bought.
	credit_balance_cents: z.number().int().nonnegative(),
	// Always false now: the top-up is closed (see POST /credits/checkout). Kept so
	// older clients, which hide Buy usage credits on false, keep working.
	credit_topup_available: z.boolean(),
	linkedin_identity_addon: linkedinIdentityAddonSchema,
	// Card-at-sign-up trial: null on every workspace that did not go through the card step.
	// awaiting_card means no session starts until a card is saved; started means the 7 days run.
	trial_state: z.enum(['awaiting_card', 'started']).nullable(),
})

const usageRoute = createRoute({
	method: 'get',
	path: '/usage',
	tags: ['billing'],
	summary: 'Current billing plan + tokens used this period',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Current billing snapshot',
			content: { 'application/json': { schema: usageResponseSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

const usageBreakdownRowSchema = z.object({
	// Model id, agent id or flow id. Null for sessions that carry none.
	id: z.string().nullable(),
	name: z.string(),
	usd_cents: z.number().int().positive(),
})

const usageSplitSchema = z.object({
	rows: z.array(usageBreakdownRowSchema).max(USAGE_BREAKDOWN_MAX_ROWS),
	// Everything past the top rows, so rows + other always add up to usd_cents_used.
	other_usd_cents: z.number().int().nonnegative(),
})

const usageBreakdownResponseSchema = z.object({
	usd_cents_used: z.number().int().nonnegative(),
	by_model: usageSplitSchema,
	by_agent: usageSplitSchema,
	by_flow: usageSplitSchema,
})

const usageBreakdownRoute = createRoute({
	method: 'get',
	path: '/usage/breakdown',
	tags: ['billing'],
	summary: 'Spend this period split by model, agent and flow',
	description:
		'Splits the same usage GET /usage totals (usd_cents_used) by model, by agent and by flow. Each split lists the top rows plus an other bucket, and its rows plus other add up to usd_cents_used. Sessions that belong to no flow are listed as "No flow". Enterprise workspaces are not metered, so every split is empty.',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Usage split for the current billing period',
			content: { 'application/json': { schema: usageBreakdownResponseSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

const INVOICES_MAX_ROWS = 100

const invoiceSchema = z.object({
	id: z.string(),
	// Human-facing invoice number, null until Stripe numbers the invoice.
	number: z.string().nullable(),
	// Unix seconds, same unit as period_start on the usage read.
	created: z.number().int().nonnegative(),
	// Invoice total in minor units of its own currency (not USD cents).
	amount_cents: z.number().int(),
	currency: z.string(),
	status: z.enum(['open', 'paid', 'uncollectible', 'void']),
	hosted_invoice_url: z.string().nullable(),
	invoice_pdf: z.string().nullable(),
})

const invoicesResponseSchema = z.object({
	invoices: z.array(invoiceSchema).max(INVOICES_MAX_ROWS),
})

const invoicesRoute = createRoute({
	method: 'get',
	path: '/invoices',
	tags: ['billing'],
	summary: "List the workspace's own Stripe invoices",
	description:
		"Read-only list of the workspace's invoices, newest first, from the Stripe customer stored in the workspace's own billing settings (never taken from the request). Each invoice is shown in the currency it was charged in. Draft invoices are not listed. A workspace with no Stripe customer gets an empty list. Only human workspace owners and admins can read it.",
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Invoices, newest first',
			content: { 'application/json': { schema: invoicesResponseSchema } },
		},
		403: {
			description: 'Caller is not a human workspace admin or owner',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Stripe is not configured or the invoice list failed',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

type BillingWorkspace = {
	settings: unknown
	enterpriseGranted: boolean | null
	billingOwnerId: string | null
}

// The plan and billing window the usage read (and its breakdown) are measured over.
function resolveBillingWindow(workspace: BillingWorkspace) {
	const parsed = workspaceSettingsSchema.partial().safeParse(workspace.settings ?? {})
	const billing = parsed.success ? parsed.data.billing : undefined

	// No billing row → workspace is on trial. Window starts whenever sessions
	// first ran; we use a 30d rolling window so the trial usage never grows
	// unbounded, and the row in Settings has a consistent "X / Y · resets in Zd".
	//
	// A BYO-LLM entitled workspace (the `enterprise_granted` column OR an enterprise
	// billing owner) is reported as `enterprise` regardless of what's stored:
	// `billing.plan === 'enterprise'` is only written by `billingAfterByoTransition()`
	// once a BYO credential is connected, so an entitled workspace that hasn't
	// connected one yet — or never had a billing block at all — would otherwise
	// fall through to the `trial` default and be shown as a trial workspace with
	// a usage meter it isn't metered against. Same predicate the routing layer
	// uses to keep these workspaces off the Maskin-funded LLM.
	const plan = isEnterprise(workspace) ? 'enterprise' : (billing?.plan ?? 'trial')
	const status = billing?.status ?? 'active'
	const hardCapCents =
		billing?.hard_cap_usd_cents && billing.hard_cap_usd_cents > 0
			? billing.hard_cap_usd_cents
			: planHardCapFallback(plan)
	// `billing.period_start` is a Unix SECONDS value — the Stripe webhook
	// writes `subscription.current_period_start` straight through, and Stripe
	// timestamps are seconds (not ms). Coerce to a positive integer at read
	// time so a partial / legacy / malformed stored value never trips the
	// response schema (which requires `int().nonnegative()`).
	const rawPeriodStart = billing?.period_start
	const periodStartSec =
		typeof rawPeriodStart === 'number' && Number.isFinite(rawPeriodStart) && rawPeriodStart > 0
			? Math.floor(rawPeriodStart)
			: null
	const periodStartMs =
		periodStartSec !== null ? periodStartSec * 1000 : Date.now() - DEFAULT_PERIOD_LENGTH_MS
	return { billing, plan, status, hardCapCents, periodStartSec, periodStartMs }
}

// The uncached usage read. Returns null when the workspace does not exist.
async function readBillingUsage(db: Database, workspaceId: string) {
	const [workspace] = await db
		.select({
			id: workspaces.id,
			settings: workspaces.settings,
			enterpriseGranted: workspaces.enterpriseGranted,
			billingOwnerId: workspaces.billingOwnerId,
		})
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)

	if (!workspace) return null

	const { billing, plan, status, hardCapCents, periodStartSec, periodStartMs } =
		resolveBillingWindow(workspace)
	const rawPeriodEnd = billing?.period_end
	const periodEndSec =
		typeof rawPeriodEnd === 'number' && Number.isFinite(rawPeriodEnd) && rawPeriodEnd > 0
			? Math.floor(rawPeriodEnd)
			: null
	const periodEndMs =
		periodEndSec !== null
			? periodEndSec * 1000
			: periodStartSec !== null
				? periodStartSec * 1000 + DEFAULT_PERIOD_LENGTH_MS
				: Date.now() + DEFAULT_PERIOD_LENGTH_MS

	const usdCentsUsed =
		plan !== 'enterprise' ? await getWorkspacePlanUsdCentsUsage(db, workspaceId, periodStartMs) : 0

	const resetsIn = Math.max(0, periodEndMs - Date.now())

	const creditBalanceCents =
		typeof billing?.credit_balance_cents === 'number' && billing.credit_balance_cents > 0
			? Math.floor(billing.credit_balance_cents)
			: 0

	// LinkedIn Identity add-on line. Shown when ≥1 `linkedin-unipile`
	// credential row is connected. Deliberately DOES NOT touch `usdCentsUsed` — the $49
	// per-connected-identity/month price is a separate SKU line that must not
	// flow into the inference-token ledger (see bet §Pricing). Enterprise
	// workspaces skip the count query.
	//
	// Enterprise workspaces are exempt: connected identities are free for them,
	// so there is no line and `syncLinkedInAddonQuantity` creates no Stripe
	// item. Deliberately `isEnterprise(workspace)` and NOT the `plan` computed
	// above: `plan` also reads `'enterprise'` from a *stored*
	// `settings.billing.plan`, which `billingAfterByoTransition()` writes once
	// and never rewrites — so a workspace whose entitlement was later revoked
	// still reports plan `enterprise` while `syncLinkedInAddonQuantity` (which
	// calls `isEnterprise` directly) resumes billing it. Keying the disclosure
	// on the same predicate that does the billing is what keeps the two from
	// disagreeing.
	const linkedinExempt = isEnterprise(workspace)
	const linkedinConnectedCount = !linkedinExempt
		? await getConnectedLinkedInIdentityCount(db, workspaceId)
		: 0
	const linkedinIdentityAddon = resolveLinkedInIdentityAddon({
		connectedCount: linkedinConnectedCount,
		exempt: linkedinExempt,
	})

	logger.info('Billing usage read', {
		workspaceId,
		plan,
		status,
		usdCentsUsed,
		hardCapCents,
		creditBalanceCents,
		linkedinIdentityCount: linkedinIdentityAddon?.count ?? 0,
	})

	return {
		plan,
		status,
		usd_cents_used: usdCentsUsed,
		hard_cap_usd_cents: hardCapCents,
		period_start: periodStartSec,
		// No trial clock until the card is down: a workspace waiting for its card has no end date,
		// and the 30 day rolling fallback would show "30 days left" for a trial that has not begun.
		period_resets_in_ms:
			plan === 'enterprise' || billing?.trial_state === 'awaiting_card' ? null : resetsIn,
		stripe_customer_id: billing?.stripe_customer_id ?? null,
		stripe_subscription_id: billing?.stripe_subscription_id ?? null,
		credit_balance_cents: creditBalanceCents,
		credit_topup_available: false,
		linkedin_identity_addon: linkedinIdentityAddon,
		trial_state: billing?.trial_state ?? null,
	}
}

app.openapi(usageRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const usage = await cachedBillingUsage(actorId, workspaceId, () =>
		readBillingUsage(db, workspaceId),
	)
	if (!usage) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}
	return c.json(usage, 200)
})

app.openapi(usageBreakdownRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const [workspace] = await db
		.select({
			settings: workspaces.settings,
			enterpriseGranted: workspaces.enterpriseGranted,
			billingOwnerId: workspaces.billingOwnerId,
		})
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!workspace) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	const { plan, periodStartMs } = resolveBillingWindow(workspace)
	// Enterprise is not metered: /usage reports 0 for it, so the splits are empty too.
	if (plan === 'enterprise') {
		const empty = { rows: [], other_usd_cents: 0 }
		return c.json({ usd_cents_used: 0, by_model: empty, by_agent: empty, by_flow: empty }, 200)
	}
	return c.json(await readUsageBreakdown(db, workspaceId, periodStartMs), 200)
})

app.openapi(invoicesRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const [workspace] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!workspace) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	// Invoices carry amounts and hosted links, so this takes the same human
	// admin/owner gate as the checkout routes. Checked after the existence
	// lookup so a missing workspace still 404s.
	if (!(await isWorkspaceHumanAdminOrOwner(db, c.get('actorId'), workspaceId))) {
		return c.json(
			createApiError('FORBIDDEN', 'Only workspace owners/admins can manage billing'),
			403,
		)
	}

	// The customer always comes from this workspace's own settings, never from
	// the request, so one workspace can't read another's invoices.
	const settingsParse = workspaceSettingsSchema.partial().safeParse(workspace.settings ?? {})
	const customerId = settingsParse.success
		? (settingsParse.data.billing?.stripe_customer_id ?? null)
		: null
	if (!customerId) {
		return c.json({ invoices: [] }, 200)
	}

	let stripeEnv: ReturnType<typeof readStripeEnv>
	try {
		stripeEnv = readStripeEnv()
	} catch (err) {
		logger.error('Stripe is not configured', {
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Stripe is not configured'), 500)
	}

	try {
		const list = await getStripeClient(stripeEnv).invoices.list({
			customer: customerId,
			limit: INVOICES_MAX_ROWS,
		})
		const invoices = list.data.flatMap((invoice) => {
			// Drafts are not final and have no hosted page. Skip them.
			if (invoice.status === null || invoice.status === 'draft') return []
			return [
				{
					id: invoice.id,
					number: invoice.number ?? null,
					created: invoice.created,
					amount_cents: invoice.total,
					currency: invoice.currency,
					status: invoice.status,
					hosted_invoice_url: invoice.hosted_invoice_url ?? null,
					invoice_pdf: invoice.invoice_pdf ?? null,
				},
			]
		})
		return c.json({ invoices }, 200)
	} catch (err) {
		logger.error('Stripe invoice list failed', {
			workspaceId,
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to list invoices'), 500)
	}
})

app.openapi(checkoutRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { plan, success_url, cancel_url } = c.req.valid('json')

	const [workspace] = await db
		.select({ id: workspaces.id, settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)

	if (!workspace) {
		return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	}

	// authMiddleware only proves membership. Starting a subscription binds the
	// workspace to a recurring charge, so it takes the same human admin/owner
	// gate the other ownership-sensitive routes use - which also keeps agents
	// holding a workspace-scoped API key (MCP) out of the payment surface.
	// Checked after the existence lookup so a missing workspace still 404s.
	if (!(await isWorkspaceHumanAdminOrOwner(db, c.get('actorId'), workspaceId))) {
		return c.json(
			createApiError('FORBIDDEN', 'Only workspace owners/admins can manage billing'),
			403,
		)
	}

	// Existing billing.stripe_customer_id (if any) lets us reuse the same
	// Stripe Customer across plan changes — otherwise Stripe would create a
	// new customer for every checkout, and our customer→workspace map (kept
	// in settings.billing) would point at a stale id.
	const settingsParse = workspaceSettingsSchema.partial().safeParse(workspace.settings ?? {})
	const existingCustomerId = settingsParse.success
		? (settingsParse.data.billing?.stripe_customer_id ?? null)
		: null

	let stripeEnv: ReturnType<typeof readStripeEnv>
	try {
		stripeEnv = readStripeEnv()
	} catch (err) {
		logger.error('Stripe is not configured', {
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Stripe is not configured'), 500)
	}

	const stripe = getStripeClient(stripeEnv)
	try {
		const session = await createCheckoutSession(
			stripe,
			{
				workspaceId,
				plan,
				successUrl: success_url,
				cancelUrl: cancel_url,
				existingCustomerId,
			},
			stripeEnv,
		)
		if (!session.url) {
			logger.error('Stripe checkout session missing url', { sessionId: session.id })
			return c.json(createApiError('INTERNAL_ERROR', 'Stripe returned no checkout url'), 500)
		}
		return c.json({ url: session.url, session_id: session.id }, 200)
	} catch (err) {
		logger.error('Stripe checkout session creation failed', {
			workspaceId,
			plan,
			error: err instanceof Error ? err.message : String(err),
		})
		return c.json(createApiError('INTERNAL_ERROR', 'Failed to create checkout session'), 500)
	}
})

// ── Card step: save a card for the 7-day trial, no charge ────────────────────────────────────────
// A workspace that signed up through the card step (trial-card-percent flag) waits for a card.
// setup hands the browser a Stripe card-setup secret and the public key; start reads the finished
// setup back from Stripe, refuses a plain card that already had a trial, and starts the 7 days.

const trialSetupResponseSchema = z.object({
	client_secret: z.string(),
	publishable_key: z.string(),
})

// Exactly one of the two: a finished card setup, or a promo code. The handler checks that, so the
// schema stays a plain object.
const trialStartBodySchema = z.object({
	setup_intent_id: z.string().min(1).max(255).optional(),
	promo_code: z.string().min(1).max(100).optional(),
})

const trialPromoCheckBodySchema = z.object({
	code: z.string().min(1).max(100),
})

const trialPromoCheckResponseSchema = z.object({
	// One answer for a wrong, expired, switched-off or used-up code, so a guess learns nothing.
	valid: z.boolean(),
	// Days the trial lasts with this code, for the page to say; null when the code is not valid.
	// Only wording: the length is read again on the server when the trial starts.
	trial_days: z.number().int().positive().nullable(),
})

const trialStartResponseSchema = z.object({
	trial_state: z.literal('started'),
	// Unix seconds.
	trial_ends_at: z.number().int().nullable(),
})

const trialSetupRoute = createRoute({
	method: 'post',
	path: '/trial/setup',
	'x-viewer-policy': 'writer',
	tags: ['billing'],
	summary: 'Start a Stripe card setup (no charge) for a workspace waiting for its trial card',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Secret for the browser card form',
			content: { 'application/json': { schema: trialSetupResponseSchema } },
		},
		400: {
			description: 'The card setup is not finished or does not belong to this workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Caller is not a human workspace admin or owner',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description:
				'The workspace is not waiting for a card, or the card already started a free trial (code TRIAL_CARD_ALREADY_USED)',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Stripe is not configured or failed',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

const trialStartRoute = createRoute({
	method: 'post',
	path: '/trial/start',
	'x-viewer-policy': 'writer',
	tags: ['billing'],
	summary:
		"Start the trial from a finished card setup (7 days), or from a promo code with no card (the code's length)",
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: trialStartBodySchema } }, required: true },
	},
	responses: {
		200: {
			description: 'The trial has started',
			content: { 'application/json': { schema: trialStartResponseSchema } },
		},
		400: {
			description: 'The card setup is not finished or does not belong to this workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Caller is not a human workspace admin or owner',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description:
				'The workspace is not waiting for a card, or the card already started a free trial (code TRIAL_CARD_ALREADY_USED)',
			content: { 'application/json': { schema: errorSchema } },
		},
		429: {
			description: 'Too many promo code tries',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Stripe is not configured or failed',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

const trialPromoCheckRoute = createRoute({
	method: 'post',
	path: '/trial/promo/check',
	'x-viewer-policy': 'writer',
	tags: ['billing'],
	summary: 'Check a promo code for the trial. Looks only; nothing is used up.',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: { 'application/json': { schema: trialPromoCheckBodySchema } },
			required: true,
		},
	},
	responses: {
		200: {
			description: 'Whether the code could start a trial with no card right now',
			content: { 'application/json': { schema: trialPromoCheckResponseSchema } },
		},
		403: {
			description: 'Caller is not a human workspace admin or owner',
			content: { 'application/json': { schema: errorSchema } },
		},
		409: {
			description: 'The workspace is not waiting for a card',
			content: { 'application/json': { schema: errorSchema } },
		},
		429: {
			description: 'Too many promo code tries',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

// Same gate as checkout: authMiddleware only proves membership, and a card binds the workspace to
// a payer, so a human admin or owner does it. Agent keys never reach the payment surface.
const TRIAL_FORBIDDEN_MESSAGE = 'Only workspace owners/admins can manage billing'

// What a failed card step means for the caller. Kept apart from c.json so each handler answers
// with a status the route declares.
function trialFailure(err: unknown) {
	if (err instanceof TrialCardAlreadyUsedError) {
		return {
			status: 409 as const,
			body: {
				error: {
					code: ApiErrorCode.TRIAL_CARD_ALREADY_USED,
					message: err.message,
					suggestion: 'Choose a plan to keep going, or add a different card.',
				},
			},
		}
	}
	if (err instanceof TrialPromoCodeInvalidError) {
		return {
			status: 400 as const,
			body: {
				error: {
					code: ApiErrorCode.TRIAL_PROMO_CODE_INVALID,
					message: err.message,
					suggestion: 'Check the code, or remove it and add a card instead.',
				},
			},
		}
	}
	if (err instanceof TrialCardError) {
		return { status: err.status, body: createApiError(err.code, err.message) }
	}
	logger.error('Trial card step failed', {
		error: err instanceof Error ? err.message : String(err),
	})
	return {
		status: 500 as const,
		body: createApiError('INTERNAL_ERROR', 'Could not save the card. Try again.'),
	}
}

app.openapi(trialSetupRoute, async (c) => {
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	if (!(await isWorkspaceHumanAdminOrOwner(c.get('db'), c.get('actorId'), workspaceId))) {
		return c.json(createApiError('FORBIDDEN', TRIAL_FORBIDDEN_MESSAGE), 403)
	}
	const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY?.trim()
	if (!publishableKey) {
		logger.error('STRIPE_PUBLISHABLE_KEY is not set, so the card step cannot start')
		return c.json(createApiError('INTERNAL_ERROR', 'Stripe is not configured'), 500)
	}
	try {
		const { clientSecret } = await createTrialSetup({
			db: c.get('db'),
			stripe: getStripeClient(),
			workspaceId,
		})
		return c.json({ client_secret: clientSecret, publishable_key: publishableKey }, 200)
	} catch (err) {
		const failure = trialFailure(err)
		switch (failure.status) {
			case 400:
				return c.json(failure.body, 400)
			case 404:
				return c.json(failure.body, 404)
			case 409:
				return c.json(failure.body, 409)
			default:
				return c.json(failure.body, 500)
		}
	}
})

function promoCallerIp(c: { req: { raw: Request; header(name: string): string | undefined } }) {
	const socketIp = (c.req.raw as unknown as { remoteAddress?: string }).remoteAddress
	return extractClientIp(socketIp, c.req.header('X-Forwarded-For'))
}

function promoRateLimited(retryAfterMs: number) {
	return {
		retryAfter: String(Math.ceil(retryAfterMs / 1000)),
		body: createApiError('RATE_LIMITED', 'Too many promo code tries. Wait a minute and try again.'),
	}
}

app.openapi(trialPromoCheckRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { code } = c.req.valid('json')
	if (!(await isWorkspaceHumanAdminOrOwner(db, c.get('actorId'), workspaceId))) {
		return c.json(createApiError('FORBIDDEN', TRIAL_FORBIDDEN_MESSAGE), 403)
	}
	const limit = hitPromoRateLimit(c.get('actorId'), promoCallerIp(c))
	if (!limit.allowed) {
		const limited = promoRateLimited(limit.retryAfterMs)
		c.header('Retry-After', limited.retryAfter)
		return c.json(limited.body, 429)
	}
	// Only a workspace that is waiting for its card has a use for a code, so any other state is
	// refused before the code is looked at.
	const [row] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	const billing = workspaceSettingsSchema.partial().safeParse(row?.settings ?? {})
	if (!row || !billing.success || billing.data.billing?.trial_state !== 'awaiting_card') {
		return c.json(createApiError('CONFLICT', 'This workspace is not waiting for a card'), 409)
	}
	const trialDays = await promoCodeTrialDays(db, code)
	return c.json({ valid: trialDays !== null, trial_days: trialDays }, 200)
})

app.openapi(trialStartRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { setup_intent_id, promo_code } = c.req.valid('json')
	if (!(await isWorkspaceHumanAdminOrOwner(db, c.get('actorId'), workspaceId))) {
		return c.json(createApiError('FORBIDDEN', TRIAL_FORBIDDEN_MESSAGE), 403)
	}
	// A code is the only way past the card step, so the request must bring a card setup or a code.
	if (Boolean(setup_intent_id) === Boolean(promo_code)) {
		return c.json(
			createApiError('BAD_REQUEST', 'Send either a finished card setup or a promo code'),
			400,
		)
	}
	if (promo_code) {
		const limit = hitPromoRateLimit(c.get('actorId'), promoCallerIp(c))
		if (!limit.allowed) {
			const limited = promoRateLimited(limit.retryAfterMs)
			c.header('Retry-After', limited.retryAfter)
			return c.json(limited.body, 429)
		}
	}
	try {
		const onStarted = () => startWelcomeAfterTrial(db, workspaceId, c.get('actorId'))
		const { trialEndsAt } = promo_code
			? await startTrialWithPromo({
					db,
					workspaceId,
					actorId: c.get('actorId'),
					code: promo_code,
					onStarted,
				})
			: await startTrial({
					db,
					stripe: getStripeClient(),
					workspaceId,
					actorId: c.get('actorId'),
					setupIntentId: setup_intent_id as string,
					// The welcome was held back at sign-up so no session started before the card.
					onStarted,
				})
		return c.json({ trial_state: 'started' as const, trial_ends_at: trialEndsAt }, 200)
	} catch (err) {
		const failure = trialFailure(err)
		switch (failure.status) {
			case 400:
				return c.json(failure.body, 400)
			case 404:
				return c.json(failure.body, 404)
			case 409:
				return c.json(failure.body, 409)
			default:
				return c.json(failure.body, 500)
		}
	}
})

async function startWelcomeAfterTrial(db: Database, workspaceId: string, ownerActorId: string) {
	if (shouldSkipOnboardingKickoff()) return
	const [row] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	const chiefOfStaffId = (row?.settings as { default_agent_id?: string | null } | undefined)
		?.default_agent_id
	if (chiefOfStaffId) await startChiefOfStaffWelcome(db, workspaceId, ownerActorId, chiefOfStaffId)
}

// The schema only takes the widest range any currency allows. The exact
// min/max for the chosen currency is checked in the handler, otherwise this
// check would cap EUR/DKK callers at the USD maximum.
const BUY_CREDITS_WIDEST_MIN_MINOR = Math.min(
	CREDIT_TOPUP_MIN_USD * 100,
	...Object.values(CREDIT_TOPUP_BOUNDS_MINOR).map((b) => b.min),
)
const BUY_CREDITS_WIDEST_MAX_MINOR = Math.max(
	CREDIT_TOPUP_MAX_USD * 100,
	...Object.values(CREDIT_TOPUP_BOUNDS_MINOR).map((b) => b.max),
)

const buyCreditsBodySchema = z.object({
	amount_usd_cents: z
		.number()
		.int()
		.min(BUY_CREDITS_WIDEST_MIN_MINOR)
		.max(BUY_CREDITS_WIDEST_MAX_MINOR),
	success_url: z.string().url(),
	cancel_url: z.string().url(),
	/**
	 * Optional currency for the top-up (custom-amount top-up uses the
	 * maskin_credits_custom Price). EUR/DKK amounts are checked against the
	 * per-currency bounds from CREDIT_TOPUP_BOUNDS_MINOR (spec Delta 1b);
	 * USD or no currency keeps the $10 to $500 range.
	 */
	currency: z.enum(['usd', 'eur', 'dkk']).optional(),
})

const buyCreditsRoute = createRoute({
	method: 'post',
	path: '/credits/checkout',
	'x-viewer-policy': 'writer',
	tags: ['billing'],
	summary: 'Start a Stripe Checkout session for a one-time usage-credits top-up',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: { 'application/json': { schema: buyCreditsBodySchema } },
			required: true,
		},
	},
	responses: {
		200: {
			description: 'Checkout session created',
			content: { 'application/json': { schema: checkoutResponseSchema } },
		},
		400: {
			description: 'Workspace is not eligible to buy usage credits',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Caller is not permitted to manage billing for this workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: {
			description: 'Stripe misconfigured or upstream failure',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

// Closed: the pricing bet (Magnus, 9 Nov 2026) has no top-up. At 100% of a plan
// work waits for the next period. Existing balances are still honoured when
// spending (`canUseCreditBalance`) and credited by the webhook if a checkout
// opened earlier still completes; only starting a new one is shut. The route and
// its schema stay so older clients get this 404 and not an unknown-route error.
app.openapi(buyCreditsRoute, async (c) => {
	return c.json(createApiError('NOT_FOUND', 'Credit top-up is not available'), 404)
})

const cancelRoute = createRoute({
	method: 'post',
	path: '/cancel',
	'x-viewer-policy': 'writer',
	tags: ['billing'],
	summary: 'Downgrade to Free by cancelling the active Maskin subscription',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Subscription cancelled, plan set to Free',
			content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
		},
		403: {
			description: 'Caller is not permitted to manage billing for this workspace',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
		500: { description: 'Stripe error', content: { 'application/json': { schema: errorSchema } } },
	},
})

app.openapi(cancelRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const [workspace] = await db
		.select({
			id: workspaces.id,
			settings: workspaces.settings,
			enterpriseGranted: workspaces.enterpriseGranted,
			billingOwnerId: workspaces.billingOwnerId,
		})
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)

	if (!workspace) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)

	// Cancelling destroys the workspace's paid subscription outright, so it is
	// restricted to the billing owner - the actor whose card is on file -
	// matching the transfer-ownership gate in routes/workspaces.ts. Older rows
	// predate `billing_owner_id`; those fall back to the human admin/owner
	// check rather than being left open to every member.
	const callerId = c.get('actorId')
	// The billing owner branch below ignores the role, so a viewer who holds billing ownership
	// (transfer-ownership does not look at the new owner's role) would pass it.
	assertWorkspaceWriterRole(c.get('workspaceRole'))
	const authorized = workspace.billingOwnerId
		? workspace.billingOwnerId === callerId
		: await isWorkspaceHumanAdminOrOwner(db, callerId, workspaceId)
	if (!authorized) {
		return c.json(
			createApiError('FORBIDDEN', 'Only the billing owner can cancel the subscription'),
			403,
		)
	}

	const settings = (workspace.settings ?? {}) as WorkspaceSettings
	const billing = settings.billing

	if (hasActivePaidPlan({ billing })) {
		const subscriptionId = billing?.stripe_subscription_id
		if (!subscriptionId) {
			return c.json(createApiError('INTERNAL_ERROR', 'No active subscription id'), 500)
		}
		let stripeEnv: ReturnType<typeof readStripeEnv>
		try {
			stripeEnv = readStripeEnv()
		} catch {
			return c.json(createApiError('INTERNAL_ERROR', 'Stripe is not configured'), 500)
		}
		try {
			await cancelActivePaidSubscription(getStripeClient(stripeEnv), subscriptionId)
		} catch (err) {
			logger.error('Stripe cancel failed', { workspaceId, error: String(err) })
			return c.json(createApiError('INTERNAL_ERROR', 'Failed to cancel subscription'), 500)
		}
	}

	const downgraded = billingAfterCancel(billing, isEnterprise(workspace))
	if (downgraded) {
		await db
			.update(workspaces)
			.set({ settings: { ...settings, billing: downgraded }, updatedAt: new Date() })
			.where(eq(workspaces.id, workspaceId))
		// The web app refetches usage as soon as this returns; a read cached within
		// the cache TTL would still show the paid plan.
		evictBillingUsage(workspaceId)

		// Audit + real-time, per the "events logged on every mutation" rule.
		// A cancellation is the single most disputable billing action; without
		// this row there is no record of who cancelled or when, and no SSE
		// invalidation to refresh the billing UI off the stale plan.
		await recordEvent(db, {
			workspaceId,
			actorId: callerId,
			action: 'workspace_billing_canceled',
			entityType: 'workspace',
			entityId: workspaceId,
			data: {
				plan_before: billing?.plan ?? null,
				plan_after: downgraded.plan ?? null,
				status_before: billing?.status ?? null,
				status_after: downgraded.status ?? null,
				stripe_subscription_id: billing?.stripe_subscription_id ?? null,
			},
		})
	}

	logger.info('Plan downgraded to Free', { workspaceId })
	return c.json({ ok: true as const }, 200)
})

// ── Daily budget (bet: A daily token budget, slice 1a) ──────────────────────
// One daily target per workspace, stored at settings.daily_budget. It reports
// only: nothing reads stop_share or holds work yet.

const getDailyBudgetRoute = createRoute({
	method: 'get',
	path: '/daily-budget',
	tags: ['billing'],
	summary: 'The workspace daily target, as a percent of the plan',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'Current daily target (null when off), in percent of the plan',
			content: { 'application/json': { schema: dailyBudgetResponseSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

const setDailyBudgetRoute = createRoute({
	method: 'put',
	path: '/daily-budget',
	'x-viewer-policy': 'writer',
	tags: ['billing'],
	summary: 'Set the workspace daily target, or switch it off with null',
	request: {
		headers: workspaceIdHeader,
		body: {
			content: { 'application/json': { schema: setDailyBudgetSchema } },
			required: true,
		},
	},
	responses: {
		200: {
			description: 'Daily target stored',
			content: { 'application/json': { schema: dailyBudgetResponseSchema } },
		},
		403: {
			description: 'Caller is not a human workspace admin or owner',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

/** The stored target (as saved, maybe in an older unit) and the plan limit a percent is a share of. */
async function readStoredDailyBudget(db: Database, workspaceId: string) {
	const [workspace] = await db
		.select({
			id: workspaces.id,
			settings: workspaces.settings,
			enterpriseGranted: workspaces.enterpriseGranted,
			billingOwnerId: workspaces.billingOwnerId,
		})
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!workspace) return null
	const parsed = storedDailyBudgetSchema.safeParse(
		(workspace.settings as Record<string, unknown> | null)?.daily_budget,
	)
	return {
		dailyBudget: parsed.success ? parsed.data : null,
		capCents: resolveWorkspaceCapCents(workspace),
	}
}

/** The response both routes return: the target in percent, plus what became of an older one. */
function dailyBudgetResponse(
	stored: NonNullable<Awaited<ReturnType<typeof readStoredDailyBudget>>>,
) {
	const { budget, earlier } = stored.dailyBudget
		? toPercentBudget(stored.dailyBudget, stored.capCents)
		: { budget: null, earlier: null }
	return {
		daily_budget: budget,
		earlier_target: earlier,
		plan_limit_known: stored.capCents !== null,
	}
}

app.openapi(getDailyBudgetRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const stored = await readStoredDailyBudget(db, workspaceId)
	if (!stored) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	return c.json(dailyBudgetResponse(stored), 200)
})

app.openapi(setDailyBudgetRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const { daily_budget: next } = c.req.valid('json')

	const before = await readStoredDailyBudget(db, workspaceId)
	if (!before) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)

	// Spend controls sit next to plan changes, so they take the same human
	// admin/owner gate (agents holding a workspace API key stay out).
	if (!(await isWorkspaceHumanAdminOrOwner(db, actorId, workspaceId))) {
		return c.json(
			createApiError('FORBIDDEN', 'Only workspace owners/admins can set the daily budget'),
			403,
		)
	}

	// Atomic key write: a read-modify-write of the whole settings object could
	// drop a concurrent change to another key (a Stripe webhook, a PATCH).
	await db
		.update(workspaces)
		.set({
			settings: next
				? sql`jsonb_set(coalesce(${workspaces.settings}, '{}'::jsonb), '{daily_budget}', ${JSON.stringify(next)}::jsonb)`
				: sql`coalesce(${workspaces.settings}, '{}'::jsonb) - 'daily_budget'`,
			updatedAt: new Date(),
		})
		.where(eq(workspaces.id, workspaceId))

	await recordEvent(db, {
		workspaceId,
		actorId,
		action: 'workspace_daily_budget_updated',
		entityType: 'workspace',
		entityId: workspaceId,
		data: { before: before.dailyBudget, after: next },
	})

	return c.json(dailyBudgetResponse({ dailyBudget: next, capCents: before.capCents }), 200)
})

// ── Auto top-up ─────────────────────────────────────────────────────────────
// One rule per workspace at settings.auto_top_up: when the credit balance falls
// under `threshold_cents`, charge the saved card `amount_cents` (USD cents).
// The charge itself lives in lib/auto-top-up.ts and runs after a debit commits.
// Kroner are always approximate: a fixed $50 = 349 DKK reference, no live rate.

const getAutoTopUpRoute = createRoute({
	method: 'get',
	path: '/auto-top-up',
	tags: ['billing'],
	summary: 'The auto top-up rule and whether the last automatic charge failed',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			description: 'The rule (null until one has been saved)',
			content: { 'application/json': { schema: autoTopUpResponseSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

const setAutoTopUpRoute = createRoute({
	method: 'put',
	path: '/auto-top-up',
	'x-viewer-policy': 'writer',
	tags: ['billing'],
	summary: 'Save the auto top-up rule (also clears a failed state and retries on the next debit)',
	request: {
		headers: workspaceIdHeader,
		body: { content: { 'application/json': { schema: autoTopUpRuleSchema } }, required: true },
	},
	responses: {
		200: {
			description: 'Rule saved',
			content: { 'application/json': { schema: autoTopUpResponseSchema } },
		},
		400: {
			description:
				'Workspace cannot be charged automatically yet, or auto top-up is closed on plans',
			content: { 'application/json': { schema: errorSchema } },
		},
		403: {
			description: 'Caller is not a human workspace admin or owner',
			content: { 'application/json': { schema: errorSchema } },
		},
		404: {
			description: 'Workspace not found',
			content: { 'application/json': { schema: errorSchema } },
		},
	},
})

type StoredAutoTopUp = {
	enabled?: boolean
	threshold_cents?: number
	amount_cents?: number
	status?: 'ok' | 'failed'
	failure_reason?: string | null
	failed_at?: number | null
	last_charged_at?: number | null
}

function autoTopUpView(settings: unknown) {
	const raw = (settings as { auto_top_up?: StoredAutoTopUp } | null)?.auto_top_up
	if (!raw || typeof raw.threshold_cents !== 'number' || typeof raw.amount_cents !== 'number') {
		return { auto_top_up: null }
	}
	const parsed = autoTopUpResponseSchema.shape.auto_top_up.safeParse({
		enabled: raw.enabled === true,
		threshold_cents: raw.threshold_cents,
		amount_cents: raw.amount_cents,
		threshold_dkk_approx: usdCentsToApproxDkk(raw.threshold_cents),
		amount_dkk_approx: usdCentsToApproxDkk(raw.amount_cents),
		status: raw.status === 'failed' ? 'failed' : 'ok',
		failure_reason: raw.failure_reason ?? null,
		failed_at: raw.failed_at ?? null,
		last_charged_at: raw.last_charged_at ?? null,
	})
	return { auto_top_up: parsed.success ? parsed.data : null }
}

app.openapi(getAutoTopUpRoute, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const [workspace] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!workspace) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)
	return c.json(autoTopUpView(workspace.settings), 200)
})

app.openapi(setAutoTopUpRoute, async (c) => {
	const db = c.get('db')
	const actorId = c.get('actorId')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')
	const rule = c.req.valid('json')

	const [workspace] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	if (!workspace) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)

	// It spends the workspace's card with nobody present: same human admin/owner
	// gate as buying credits and the daily budget.
	if (!(await isWorkspaceHumanAdminOrOwner(db, actorId, workspaceId))) {
		return c.json(
			createApiError('FORBIDDEN', 'Only workspace owners/admins can manage auto top-up'),
			403,
		)
	}

	// Turning it on needs a Stripe customer (a card from a subscription or a first
	// top-up) and a workspace that can be billed. Turning it off is always allowed.
	const billing = (
		workspace.settings as { billing?: { stripe_customer_id?: string; status?: string } } | null
	)?.billing
	if (rule.enabled) {
		// The pricing bet has no top-up: at 100% a plan waits for next month. A rule that was
		// already saved is left alone, so switching the flag off brings it back.
		if (autoTopUpClosedForPlans()) {
			return c.json(
				createApiError(
					'BAD_REQUEST',
					'Automatic top-up is not available on a plan. At 100% your plan waits for next month.',
				),
				400,
			)
		}
		const blocked = billing?.status === 'past_due' || billing?.status === 'canceled'
		if (!billing?.stripe_customer_id || blocked || (await isEnterpriseWorkspace(db, workspaceId))) {
			return c.json(
				createApiError(
					'BAD_REQUEST',
					'Auto top-up needs a saved card: subscribe or buy credits once first',
				),
				400,
			)
		}
	}

	// Atomic key write on settings.auto_top_up (the same way the daily budget is
	// written): a whole-settings save could undo a concurrent debit or webhook.
	// Merged over the stored value so a charge that is in flight keeps its claim;
	// saving the rule clears a failed state.
	const next = JSON.stringify({
		...rule,
		status: 'ok',
		failure_reason: null,
		failed_at: null,
	})
	const [updated] = await db
		.update(workspaces)
		.set({
			settings: sql`jsonb_set(coalesce(${workspaces.settings}, '{}'::jsonb), '{auto_top_up}', coalesce(${workspaces.settings}->'auto_top_up', '{}'::jsonb) || ${next}::jsonb, true)`,
			updatedAt: new Date(),
		})
		.where(eq(workspaces.id, workspaceId))
		.returning({ settings: workspaces.settings })

	await recordEvent(db, {
		workspaceId,
		actorId,
		action: AUTO_TOP_UP_EVENT.updated,
		entityType: 'workspace',
		entityId: workspaceId,
		data: {
			before: autoTopUpView(workspace.settings).auto_top_up,
			after: autoTopUpView(updated?.settings).auto_top_up,
		},
	})

	return c.json(autoTopUpView(updated?.settings), 200)
})

export default app
