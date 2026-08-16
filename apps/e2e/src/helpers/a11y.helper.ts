import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { type Page, expect } from '@playwright/test'
import type { AxeResults, Result, RunOptions } from 'axe-core'

const require = createRequire(import.meta.url)
const AXE_SOURCE = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8')

declare global {
	interface Window {
		axe: {
			run: (context?: unknown, options?: RunOptions) => Promise<AxeResults>
		}
	}
}

const DEFAULT_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']
const DEFAULT_BLOCKING_IMPACTS: readonly string[] = ['serious', 'critical']

export interface AxeScanOptions {
	tags?: string[]
	disableRules?: string[]
	blockingImpacts?: readonly string[]
}

/**
 * Injects axe-core into the current page and runs an accessibility scan.
 *
 * Serious + critical violations fail the assertion. Minor + moderate findings
 * are logged to stdout so the Ship Notes can pick them up without blocking
 * the run — they're queued as drift tasks on the owning view bet, not fixed
 * inside the audit itself.
 */
export async function expectNoSeriousA11yViolations(
	page: Page,
	label: string,
	opts: AxeScanOptions = {},
): Promise<Result[]> {
	await page.evaluate(AXE_SOURCE)

	const results = await page.evaluate(
		async ({ tags, disableRules }) => {
			const runOptions: RunOptions = {
				runOnly: { type: 'tag', values: tags },
				resultTypes: ['violations'],
			}
			if (disableRules.length > 0) {
				runOptions.rules = Object.fromEntries(disableRules.map((id) => [id, { enabled: false }]))
			}
			return await window.axe.run(document, runOptions)
		},
		{ tags: opts.tags ?? DEFAULT_TAGS, disableRules: opts.disableRules ?? [] },
	)

	const blocking = opts.blockingImpacts ?? DEFAULT_BLOCKING_IMPACTS
	const serious = results.violations.filter((v) => v.impact && blocking.includes(v.impact))

	if (results.violations.length > 0) {
		const summary = results.violations
			.map(
				(v) =>
					`  [${v.impact}] ${v.id} — ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? '' : 's'})`,
			)
			.join('\n')
		// eslint-disable-next-line no-console
		console.log(`[a11y] ${label} — ${results.violations.length} finding(s):\n${summary}`)
	}

	expect(
		serious,
		`${label}: ${serious.length} serious/critical WCAG AA violation(s):\n${formatViolations(serious)}`,
	).toHaveLength(0)

	return results.violations
}

function formatViolations(violations: Result[]): string {
	return violations
		.map((v) => {
			const nodes = v.nodes
				.slice(0, 3)
				.map((n) => `      · ${n.target.join(' ')} — ${n.failureSummary?.split('\n')[0] ?? ''}`)
				.join('\n')
			const more = v.nodes.length > 3 ? `\n      · …and ${v.nodes.length - 3} more` : ''
			return `    ${v.id} — ${v.help}\n      ${v.helpUrl}\n${nodes}${more}`
		})
		.join('\n')
}

/**
 * Sets the theme in localStorage before the app boots.
 *
 * Must be called *before* `page.goto(...)` so the ThemeProvider picks it up
 * on first paint — the inline script in `apps/web/index.html` applies the
 * `.dark` class before React hydrates and reads the same key.
 */
export async function setThemeBeforeLoad(page: Page, theme: 'light' | 'dark'): Promise<void> {
	await page.addInitScript((value) => {
		localStorage.setItem('maskin-theme', value)
	}, theme)
}
