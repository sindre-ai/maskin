#!/usr/bin/env node
/**
 * Enforces the three-site billing-cap literal contract.
 *
 * STARTER_HARD_CAP_DEFAULT_TOKENS and PRO_HARD_CAP_DEFAULT_TOKENS appear in:
 *
 *   1. apps/dev/src/lib/billing-defaults.ts            (source of truth — TS)
 *   2. .env.example                                    (operator-facing default)
 *   3. apps/web/src/__tests__/components/settings/
 *      billing-section.test.tsx                        (frontend pinned literals)
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

const expected = {
	starter: 32_000_000,
	pro: 96_000_000,
}

// `100_000` is the trial-plan cap pinned in the web test's `baseUsage` and is
// the only non-Starter/Pro `hard_cap_tokens` literal that's allowed to appear.
// Anything else means a stray value has slipped in.
const TRIAL_CAP = 100_000

const errors = []
const observed = []

// Site 1 — apps/dev/src/lib/billing-defaults.ts
{
	const path = 'apps/dev/src/lib/billing-defaults.ts'
	const source = read(path)
	const starterMatch = source.match(/STARTER_HARD_CAP_DEFAULT_TOKENS\s*=\s*([\d_]+)/)
	const proMatch = source.match(/PRO_HARD_CAP_DEFAULT_TOKENS\s*=\s*([\d_]+)/)
	if (!starterMatch || !proMatch) {
		errors.push(`${path}: could not find STARTER/PRO_HARD_CAP_DEFAULT_TOKENS literals`)
	} else {
		const starter = Number(stripUnderscores(starterMatch[1]))
		const pro = Number(stripUnderscores(proMatch[1]))
		observed.push({ path, starter, pro })
		if (starter !== expected.starter) {
			errors.push(`${path}: starter cap ${starter} ≠ expected ${expected.starter}`)
		}
		if (pro !== expected.pro) {
			errors.push(`${path}: pro cap ${pro} ≠ expected ${expected.pro}`)
		}
	}
}

// Site 2 — .env.example
{
	const path = '.env.example'
	const source = read(path)
	const starterMatch = source.match(/^MASKIN_STARTER_HARD_CAP_TOKENS=([\d_]+)/m)
	const proMatch = source.match(/^MASKIN_PRO_HARD_CAP_TOKENS=([\d_]+)/m)
	if (!starterMatch || !proMatch) {
		errors.push(`${path}: could not find MASKIN_STARTER/PRO_HARD_CAP_TOKENS entries`)
	} else {
		const starter = Number(stripUnderscores(starterMatch[1]))
		const pro = Number(stripUnderscores(proMatch[1]))
		observed.push({ path, starter, pro })
		if (starter !== expected.starter) {
			errors.push(`${path}: starter cap ${starter} ≠ expected ${expected.starter}`)
		}
		if (pro !== expected.pro) {
			errors.push(`${path}: pro cap ${pro} ≠ expected ${expected.pro}`)
		}
	}
}

// Site 3 — apps/web/src/__tests__/components/settings/billing-section.test.tsx
//
// The web test pins `hard_cap_tokens` literals in several places (trial cap +
// the Starter and Pro upgrade flows). Rather than match a brittle index of
// occurrences, we enforce:
//
//   - every `hard_cap_tokens: <number>` literal is one of {trial, starter, pro}
//   - the Starter and Pro caps each appear at least once
//
// This catches both drift (a Starter literal silently becoming 32_500_000) and
// stray values (a fourth allowed cap creeping in).
{
	const path = 'apps/web/src/__tests__/components/settings/billing-section.test.tsx'
	const source = read(path)
	const ALLOWED = new Set([TRIAL_CAP, expected.starter, expected.pro])
	const seen = new Set()
	let foundAny = false
	for (const match of source.matchAll(/hard_cap_tokens:\s*([\d_]+)/g)) {
		foundAny = true
		const value = Number(stripUnderscores(match[1]))
		seen.add(value)
		if (!ALLOWED.has(value)) {
			errors.push(
				`${path}: hard_cap_tokens literal ${value} is not one of ${[...ALLOWED].join(', ')}`,
			)
		}
	}
	if (!foundAny) {
		errors.push(`${path}: no hard_cap_tokens literals found — has the test been renamed?`)
	}
	if (!seen.has(expected.starter)) {
		errors.push(`${path}: missing Starter cap (${expected.starter}) — frontend no longer pins it`)
	}
	if (!seen.has(expected.pro)) {
		errors.push(`${path}: missing Pro cap (${expected.pro}) — frontend no longer pins it`)
	}
	observed.push({
		path,
		starterPinned: seen.has(expected.starter),
		proPinned: seen.has(expected.pro),
	})
}

if (errors.length > 0) {
	console.error('Billing-cap literal contract VIOLATED:')
	for (const e of errors) console.error(`  - ${e}`)
	console.error('\nObserved values:')
	for (const o of observed) console.error(`  ${JSON.stringify(o)}`)
	console.error('\nFix by updating all three sites to the same numbers. See')
	console.error('apps/dev/src/lib/billing-defaults.ts for the source of truth.')
	process.exit(1)
}

console.log(
	`verify-billing-cap-literals: OK — starter=${expected.starter}, pro=${expected.pro} across 3 sites`,
)
