#!/usr/bin/env node
/**
 * Enforces the billing-cap literal contract.
 *
 * TRIAL_HARD_CAP_DEFAULT_TOKENS, PRO_HARD_CAP_DEFAULT_TOKENS, and
 * TEAM_HARD_CAP_DEFAULT_TOKENS are the single source of truth in:
 *
 *   1. apps/dev/src/lib/billing-defaults.ts            (source of truth — TS)
 *   2. .env.example                                    (operator-facing default)
 *   3. apps/web/src/__tests__/components/settings/
 *      billing-section.test.tsx                        (frontend pinned literals)
 *   4. apps/web/src/components/settings/
 *      billing-section.tsx                             (CAP_DEFAULTS — plan card copy)
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

const errors = []
const observed = []

// Site 1 — apps/dev/src/lib/billing-defaults.ts (source of truth)
// All three cap values are read from here; downstream sites are compared against them.
const expected = { trial: 0, pro: 0, team: 0 }
{
	const path = 'apps/dev/src/lib/billing-defaults.ts'
	const source = read(path)
	const trialMatch = source.match(/TRIAL_HARD_CAP_DEFAULT_TOKENS\s*=\s*([\d_]+)/)
	const proMatch = source.match(/PRO_HARD_CAP_DEFAULT_TOKENS\s*=\s*([\d_]+)/)
	const teamMatch = source.match(/TEAM_HARD_CAP_DEFAULT_TOKENS\s*=\s*([\d_]+)/)
	if (!trialMatch || !proMatch || !teamMatch) {
		errors.push(`${path}: could not find TRIAL/PRO/TEAM_HARD_CAP_DEFAULT_TOKENS literals`)
	} else {
		expected.trial = Number(stripUnderscores(trialMatch[1]))
		expected.pro = Number(stripUnderscores(proMatch[1]))
		expected.team = Number(stripUnderscores(teamMatch[1]))
		observed.push({ path, trial: expected.trial, pro: expected.pro, team: expected.team })
	}
}

// Site 2 — .env.example
{
	const path = '.env.example'
	const source = read(path)
	const proMatch = source.match(/^MASKIN_PRO_HARD_CAP_TOKENS=([\d_]+)/m)
	const teamMatch = source.match(/^MASKIN_TEAM_HARD_CAP_TOKENS=([\d_]+)/m)
	if (!proMatch || !teamMatch) {
		errors.push(`${path}: could not find MASKIN_PRO/TEAM_HARD_CAP_TOKENS entries`)
	} else {
		const pro = Number(stripUnderscores(proMatch[1]))
		const team = Number(stripUnderscores(teamMatch[1]))
		observed.push({ path, pro, team })
		if (pro !== expected.pro) {
			errors.push(`${path}: pro cap ${pro} ≠ expected ${expected.pro}`)
		}
		if (team !== expected.team) {
			errors.push(`${path}: team cap ${team} ≠ expected ${expected.team}`)
		}
	}
}

// Site 3 — apps/web/src/__tests__/components/settings/billing-section.test.tsx
//
// The web test pins `hard_cap_tokens` literals in several places (trial cap +
// the Pro and Team upgrade flows). Rather than match a brittle index of
// occurrences, we enforce:
//
//   - every `hard_cap_tokens: <number>` literal is one of {trial, pro, team}
//   - the Pro and Team caps each appear at least once
//
// This catches both drift (a Pro literal silently becoming 32_500_000) and
// stray values (a fourth allowed cap creeping in).
{
	const path = 'apps/web/src/__tests__/components/settings/billing-section.test.tsx'
	const source = read(path)
	const ALLOWED = new Set([expected.trial, expected.pro, expected.team])
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
	if (!seen.has(expected.pro)) {
		errors.push(`${path}: missing Pro cap (${expected.pro}) — frontend no longer pins it`)
	}
	if (!seen.has(expected.team)) {
		errors.push(`${path}: missing Team cap (${expected.team}) — frontend no longer pins it`)
	}
	observed.push({
		path,
		proPinned: seen.has(expected.pro),
		teamPinned: seen.has(expected.team),
	})
}

// Site 4 — apps/web/src/components/settings/billing-section.tsx (CAP_DEFAULTS)
//
// Drives the token counts shown in the plan comparison cards via
// formatTokens(CAP_DEFAULTS.<plan>) — must match the backend source of truth.
{
	const path = 'apps/web/src/components/settings/billing-section.tsx'
	const source = read(path)
	const trialMatch = source.match(/CAP_DEFAULTS\s*=\s*\{[^}]*trial:\s*([\d_]+)/)
	const proMatch = source.match(/CAP_DEFAULTS\s*=\s*\{[^}]*pro:\s*([\d_]+)/)
	const teamMatch = source.match(/CAP_DEFAULTS\s*=\s*\{[^}]*team:\s*([\d_]+)/)
	if (!trialMatch || !proMatch || !teamMatch) {
		errors.push(`${path}: could not find CAP_DEFAULTS trial/pro/team literals`)
	} else {
		const trial = Number(stripUnderscores(trialMatch[1]))
		const pro = Number(stripUnderscores(proMatch[1]))
		const team = Number(stripUnderscores(teamMatch[1]))
		observed.push({ path, trial, pro, team })
		if (trial !== expected.trial) {
			errors.push(`${path}: trial cap ${trial} ≠ expected ${expected.trial}`)
		}
		if (pro !== expected.pro) {
			errors.push(`${path}: pro cap ${pro} ≠ expected ${expected.pro}`)
		}
		if (team !== expected.team) {
			errors.push(`${path}: team cap ${team} ≠ expected ${expected.team}`)
		}
	}
}

if (errors.length > 0) {
	console.error('Billing-cap literal contract VIOLATED:')
	for (const e of errors) console.error(`  - ${e}`)
	console.error('\nObserved values:')
	for (const o of observed) console.error(`  ${JSON.stringify(o)}`)
	console.error('\nFix by updating all four sites to the same numbers. See')
	console.error('apps/dev/src/lib/billing-defaults.ts for the source of truth.')
	process.exit(1)
}

console.log(
	`verify-billing-cap-literals: OK — trial=${expected.trial}, pro=${expected.pro}, team=${expected.team} across 4 sites`,
)
