/**
 * Single source of truth for billing-related fallback defaults and the env
 * parsing helper that wraps them. Both `lib/stripe.ts` (boot-time strict read)
 * and `routes/billing.ts` (request-time defensive read) consume this module so
 * the `32_000_000` / `96_000_000` literals never drift between the two paths,
 * `.env.example`, and the frontend tests that pin the same numbers.
 */

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

const POSITIVE_INT_SHAPE = /^\d+$/

/**
 * Parse a positive integer from an environment variable, with a strict digits-
 * only shape check (`/^\d+$/`) so `"1e9"`, `"1.5"`, `"96_000_000"`, and
 * scientific-notation magnitudes are rejected before reaching `Number()`.
 * Returns `null` when the var is unset, blank, malformed, or non-positive.
 * Clamps successful parses to `Number.MAX_SAFE_INTEGER`.
 */
export function parsePositiveIntEnv(
	key: string,
	env: NodeJS.ProcessEnv = process.env,
): number | null {
	const raw = env[key]
	if (raw === undefined || raw === '') return null
	if (!POSITIVE_INT_SHAPE.test(raw)) return null
	const n = Number(raw)
	if (!Number.isFinite(n) || n <= 0) return null
	return Math.min(Math.floor(n), MAX_ENV_CAP)
}

/**
 * Fallback hard caps for paid plans when `billing.hard_cap_tokens` hasn't been
 * populated yet (delayed Stripe webhook, partial state after a webhook
 * failure). Mirrored in `.env.example` and the frontend billing tests — change
 * here and grep for the literal before merging if you need to bump them.
 */
export const STARTER_HARD_CAP_DEFAULT_TOKENS = 32_000_000
export const PRO_HARD_CAP_DEFAULT_TOKENS = 96_000_000
