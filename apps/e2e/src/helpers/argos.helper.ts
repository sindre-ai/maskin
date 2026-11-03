import { type ArgosScreenshotOptions, argosScreenshot } from '@argos-ci/playwright'
import type { Page } from '@playwright/test'

/**
 * Argos visual-regression uploads are opt-in, not a required part of CI.
 *
 * The free-plan screenshot quota is shared across every shard of every run, so
 * once it is exhausted the upload fails for reasons that have nothing to do
 * with the code under test. Rather than let that decide whether a PR is green,
 * Argos only runs where it is explicitly switched on (`ARGOS_ENABLED=true`
 * with a token present) — see `.github/workflows/ci.yml`, where that is set for
 * pushes to `main` only.
 */
export function isArgosEnabled(): boolean {
	return process.env.ARGOS_ENABLED === 'true' && Boolean(process.env.ARGOS_TOKEN)
}

/**
 * Wraps argosScreenshot so it is a no-op when Argos is disabled, and so an
 * upload failure (quota, outage, auth) can't fail the test when it is enabled —
 * unlike the reporter hooks, argosScreenshot() is awaited directly inside test
 * bodies, so a rejection here fails the test itself.
 */
export async function safeArgosScreenshot(
	page: Page,
	name: string,
	options?: ArgosScreenshotOptions,
) {
	if (!isArgosEnabled()) return
	try {
		await argosScreenshot(page, name, options)
	} catch (error) {
		console.error(`[argos] screenshot "${name}" failed, continuing without upload:`, error)
	}
}
