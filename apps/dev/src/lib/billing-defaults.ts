/**
 * Single source of truth for billing-related fallback defaults and the env
 * parsing helper that wraps them. Both `lib/stripe.ts` (boot-time strict read)
 * and `routes/billing.ts` (request-time defensive read) consume this module so
 * the cap literals never drift between code paths, `.env.example`, and the
 * frontend tests that pin the same numbers.
 *
 * `scripts/verify-billing-cap-literals.mjs` runs in CI to enforce the contract
 * — bump the literals here and the script will fail until `.env.example` and
 * `apps/web/src/__tests__/components/settings/billing-section.test.tsx` are
 * updated too.
 */

import { logger } from './logger'

/**
 * Upper bound on parsed env caps. Stripe usage is denominated in tokens; even
 * Pro-tier wholesale consumption would never reach this magnitude in a period.
 * The point of the clamp is purely to reject pathological inputs (`"1e308"`
 * passes `Number.isFinite && > 0` but would silently overflow downstream
 * arithmetic). `MAX_SAFE_INTEGER` is the conservative ceiling.
 *
 * The shape check (`/^\d+$/`) admits arbitrarily long digit strings — once a
 * digit string is ≥ 2^53, the `Number()` coercion silently loses precision,
 * so the post-coercion clamp is what guarantees the final value is bounded.
 * The shape check alone is not enough.
 */
export const MAX_ENV_CAP = Number.MAX_SAFE_INTEGER

/**
 * Length threshold above which a successful clamp is logged as a suspected
 * operator typo. `Number.MAX_SAFE_INTEGER` is 16 digits — any digit string
 * longer than that lost precision before reaching the clamp, which is far more
 * likely a fat-finger (`9999999999999999999`) than a deliberate value.
 */
const SUSPICIOUSLY_LONG_DIGIT_LENGTH = 16

const POSITIVE_INT_SHAPE = /^\d+$/

/**
 * Parse a positive integer from an environment variable, with a strict digits-
 * only shape check (`/^\d+$/`) so `"1e9"`, `"1.5"`, `"96_000_000"`, and
 * scientific-notation magnitudes are rejected before reaching `Number()`.
 * Returns `null` when the var is unset, blank, malformed, or non-positive.
 * Clamps successful parses to `Number.MAX_SAFE_INTEGER`.
 *
 * Leading-zero digit strings (`"01"`) are accepted and decoded as decimal —
 * `Number()` does not honour octal — so ops who wrote `"0X"` defensively get
 * the value they expected, not a silent reject.
 *
 * Warn-logs (no raw value echoed) on two cases ops want to see in logs:
 *   - `kind: 'shape_check_failed'` — the var was set but didn't match `/^\d+$/`
 *     (typo, scientific notation, decimal). The caller falls back to a default
 *     or throws, but the operator's intended value is silently ignored.
 *   - `kind: 'clamp_fired'` — the digit string was so long the clamp swallowed
 *     it. Almost always a fat-finger that would otherwise produce "effectively
 *     unlimited tokens" instead of a configuration error.
 */
export function parsePositiveIntEnv(
	key: string,
	env: NodeJS.ProcessEnv = process.env,
): number | null {
	const raw = env[key]
	if (raw === undefined || raw === '') return null
	if (!POSITIVE_INT_SHAPE.test(raw)) {
		logger.warn('parsePositiveIntEnv rejected env value', {
			key,
			rawLength: raw.length,
			kind: 'shape_check_failed',
		})
		return null
	}
	const n = Number(raw)
	if (!Number.isFinite(n) || n <= 0) return null
	const clamped = Math.min(Math.floor(n), MAX_ENV_CAP)
	if (raw.length > SUSPICIOUSLY_LONG_DIGIT_LENGTH) {
		logger.warn('parsePositiveIntEnv clamped suspiciously long value', {
			key,
			rawLength: raw.length,
			clampedTo: clamped,
			kind: 'clamp_fired',
		})
	}
	return clamped
}

/**
 * Fallback hard caps for paid plans when `billing.hard_cap_tokens` hasn't been
 * populated yet (delayed Stripe webhook, partial state after a webhook
 * failure). Mirrored in `.env.example` and the frontend billing tests — change
 * here and the CI `verify-billing-cap-literals` step will fail until the other
 * sites are updated.
 */
export const TRIAL_HARD_CAP_DEFAULT_TOKENS = 8_000_000
export const PRO_HARD_CAP_DEFAULT_TOKENS = 32_000_000
export const TEAM_HARD_CAP_DEFAULT_TOKENS = 320_000_000

/** Billing periods on paid plans run ~30 days; used when Stripe hasn't written `period_end` yet. */
export const DEFAULT_PERIOD_LENGTH_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Overage billing: once a pro/team workspace with `billing.overage_enabled`
 * exceeds its hard cap, it keeps running and is billed `OVERAGE_BLOCK_PRICE_USD`
 * per `OVERAGE_BLOCK_TOKENS` of additional usage via a Stripe metered price
 * (see `lib/stripe.ts#reportOverageBlock`). The block size is pinned to the
 * Pro cap on purpose — Pro ($20/32M) and Team ($200/320M) already resolve to
 * the same $0.625-per-1M-token rate, so overage at this size is literally
 * "the same rate, no markup" rather than a new number to justify.
 */
export const OVERAGE_BLOCK_TOKENS = PRO_HARD_CAP_DEFAULT_TOKENS
export const OVERAGE_BLOCK_PRICE_USD = 20
