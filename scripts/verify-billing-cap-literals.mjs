#!/usr/bin/env node
/**
 * Enforces the billing-cap literal contract for all five plans (trial, starter,
 * pro, team, ultra).
 *
 * The source of truth is packages/shared/src/plan-pricing.ts: the monthly price
 * and the included usage of each plan in whole kroner, plus the one fixed rate
 * (DKK_PER_USD). Every hard cap in USD cents is derived from those, and the
 * places below are compared against the derived numbers:
 *
 *   1. packages/shared/src/plan-pricing.ts             (source of truth — TS)
 *   2. apps/dev/src/lib/billing-defaults.ts            (caps must be derived, never typed in)
 *   3. .env.example                                    (operator-facing trial default; the paid
 *                                                       caps are code-only, not env)
 *   4. apps/web/src/__tests__/components/settings/
 *      billing-section.test.tsx                        (frontend pinned literals)
 *   5. apps/web/src/components/settings/
 *      billing-section.tsx and
 *      apps/web/src/components/billing/plan-picker.tsx (must read prices and included usage from
 *                                                       the shared file, not carry a copy)
 *
 * A bumper who edits one but forgets to grep the others silently drifts prod
 * away from `.env.example` and the frontend tests. JSDoc cross-references are
 * the weakest enforcement available — this script is the CI tripwire.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const stripUnderscores = (s) => s.replace(/_/g, '')

const read = (relPath) => readFileSync(resolve(repoRoot, relPath), 'utf8')

const ALL_PLANS = ['trial', 'starter', 'pro', 'team', 'ultra']
const PAID_PLANS = ['starter', 'pro', 'team', 'ultra']

const errors = []
const observed = []

/** Read `{ a: 1, b: 2 }` literal assigned to `name` into an object of numbers, or null. */
function readNumberMap(source, name) {
	const block = source.match(new RegExp(`${name}\\s*=\\s*\\{([^}]*)\\}`))
	if (!block) return null
	const out = {}
	for (const m of block[1].matchAll(/(\w+)\s*:\s*([\d_]+)/g)) {
		out[m[1]] = Number(stripUnderscores(m[2]))
	}
	return out
}

// Site 1 — packages/shared/src/plan-pricing.ts (source of truth)
let rate = 0
const included = {}
const price = {}
const expected = {}
{
	const path = 'packages/shared/src/plan-pricing.ts'
	const source = read(path)
	const rateMatch = source.match(/DKK_PER_USD\s*=\s*([\d_.]+)/)
	const includedMap = readNumberMap(source, 'INCLUDED_USAGE_DKK')
	const priceMap = readNumberMap(source, 'PLAN_PRICE_DKK')
	if (!rateMatch || !includedMap || !priceMap) {
		errors.push(`${path}: could not find DKK_PER_USD, INCLUDED_USAGE_DKK and PLAN_PRICE_DKK`)
	} else {
		rate = Number(stripUnderscores(rateMatch[1]))
		for (const plan of ALL_PLANS) {
			if (typeof includedMap[plan] !== 'number') {
				errors.push(`${path}: INCLUDED_USAGE_DKK has no ${plan} entry`)
				continue
			}
			included[plan] = includedMap[plan]
			expected[plan] = Math.round((included[plan] / rate) * 100)
		}
		for (const plan of PAID_PLANS) {
			if (typeof priceMap[plan] !== 'number') {
				errors.push(`${path}: PLAN_PRICE_DKK has no ${plan} entry`)
				continue
			}
			price[plan] = priceMap[plan]
			// Included usage is a fifth of the price, in whole kroner (99 kr gives 20).
			if (included[plan] !== Math.round(price[plan] / 5)) {
				errors.push(
					`${path}: ${plan} includes ${included[plan]} kr but a fifth of ${price[plan]} kr is ${Math.round(price[plan] / 5)}`,
				)
			}
		}
		if (!(rate > 0)) errors.push(`${path}: DKK_PER_USD must be positive, got ${rate}`)
		observed.push({ path, rate, included, price, capCents: expected })
	}
}

// Site 2 — apps/dev/src/lib/billing-defaults.ts
//
// Each cap must be derived from the included kroner through dkkToUsdCents, so
// there is no second place to type a dollar number into.
{
	const path = 'apps/dev/src/lib/billing-defaults.ts'
	const source = read(path)
	for (const plan of ALL_PLANS) {
		const name = `${plan.toUpperCase()}_HARD_CAP_DEFAULT_USD_CENTS`
		const m = source.match(new RegExp(`${name}\\s*=\\s*([^\\n]+)`))
		const wanted = `dkkToUsdCents(INCLUDED_USAGE_DKK.${plan})`
		if (!m) {
			errors.push(`${path}: could not find ${name}`)
		} else if (m[1].trim() !== wanted) {
			errors.push(`${path}: ${name} must be ${wanted}, found ${m[1].trim()}`)
		}
	}
	observed.push({ path, derivedCaps: ALL_PLANS.length })
}

// Site 3 — .env.example
//
// Only the trial cap is env-configurable. The paid caps come from the shared
// pricing file; a MASKIN_<PLAN>_HARD_CAP_USD_CENTS entry here would be dead
// config that implies otherwise (a stale prod value of it once pinned Pro
// workspaces at $20).
{
	const path = '.env.example'
	const source = read(path)
	const trialMatch = source.match(/^MASKIN_TRIAL_HARD_CAP_USD_CENTS=([\d_]+)/m)
	if (!trialMatch) {
		errors.push(`${path}: could not find MASKIN_TRIAL_HARD_CAP_USD_CENTS entry`)
	} else {
		const trial = Number(stripUnderscores(trialMatch[1]))
		observed.push({ path, trial })
		if (trial !== expected.trial) {
			errors.push(`${path}: trial cap ${trial} ≠ expected ${expected.trial}`)
		}
	}
	if (/^MASKIN_(STARTER|PRO|TEAM|ULTRA)_HARD_CAP_USD_CENTS=/m.test(source)) {
		errors.push(
			`${path}: MASKIN_<PLAN>_HARD_CAP_USD_CENTS must not be set — paid caps are code-only`,
		)
	}
}

// Site 4 — apps/web/src/__tests__/components/settings/billing-section.test.tsx
//
// The web test pins `hard_cap_usd_cents` literals. Rather than match a brittle
// index of occurrences, we enforce:
//
//   - every `hard_cap_usd_cents: <number>` literal is one of the five caps
//   - every distinct cap appears at least once, so each plan is pinned
//
// This catches both drift (a Pro literal silently becoming 2_500) and stray
// values (a sixth allowed cap creeping in).
{
	const path = 'apps/web/src/__tests__/components/settings/billing-section.test.tsx'
	const source = read(path)
	const ALLOWED = new Set(Object.values(expected))
	const seen = new Set()
	let foundAny = false
	for (const match of source.matchAll(/hard_cap_usd_cents:\s*([\d_]+)/g)) {
		foundAny = true
		const value = Number(stripUnderscores(match[1]))
		seen.add(value)
		if (!ALLOWED.has(value)) {
			errors.push(
				`${path}: hard_cap_usd_cents literal ${value} is not one of ${[...ALLOWED].join(', ')}`,
			)
		}
	}
	if (!foundAny) {
		errors.push(`${path}: no hard_cap_usd_cents literals found — has the test been renamed?`)
	}
	for (const plan of ALL_PLANS) {
		if (!seen.has(expected[plan])) {
			errors.push(`${path}: missing ${plan} cap (${expected[plan]}) — frontend no longer pins it`)
		}
	}
	observed.push({ path, pinned: [...seen].sort((a, b) => a - b) })
}

// Site 5 — web files that show prices and included usage must read them from
// the shared file instead of carrying their own copy.
for (const path of [
	'apps/web/src/components/settings/billing-section.tsx',
	'apps/web/src/components/billing/plan-picker.tsx',
]) {
	const source = read(path)
	if (!source.includes('PLAN_PRICE_DKK')) {
		errors.push(`${path}: must read prices from PLAN_PRICE_DKK in @maskin/shared`)
	}
	if (/CAP_DEFAULTS/.test(source)) {
		errors.push(`${path}: CAP_DEFAULTS is gone — included usage comes from INCLUDED_USAGE_DKK`)
	}
}
{
	const path = 'apps/web/src/components/settings/billing-section.tsx'
	if (!read(path).includes('INCLUDED_USAGE_DKK')) {
		errors.push(`${path}: must read included usage from INCLUDED_USAGE_DKK in @maskin/shared`)
	}
}

if (errors.length > 0) {
	console.error('Billing-cap literal contract VIOLATED:')
	for (const e of errors) console.error(`  - ${e}`)
	console.error('\nObserved values:')
	for (const o of observed) console.error(`  ${JSON.stringify(o)}`)
	console.error('\nFix by updating all sites to the same numbers. See')
	console.error('packages/shared/src/plan-pricing.ts for the source of truth.')
	process.exit(1)
}

console.log(
	`verify-billing-cap-literals: OK — ${ALL_PLANS.map((p) => `${p}=${expected[p]}`).join(', ')} (USD cents, ${rate} kr per USD) across 5 sites`,
)
