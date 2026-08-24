import { type ArgosScreenshotOptions, argosScreenshot } from '@argos-ci/playwright'
import type { Page } from '@playwright/test'

// Single source of truth for whether Argos should be exercised at all —
// shared with playwright.config.ts's reporter list. Without a token the
// upload always fails (quota, auth, or a missing-token error from Argos
// itself), so there's no point spending the network round-trip: skip the
// call entirely instead of attempting-then-catching.
export function isArgosEnabled() {
	return Boolean(process.env.ARGOS_TOKEN)
}

/**
 * Wraps argosScreenshot so an upload failure (free-plan screenshot quota,
 * outage, auth) can't fail the test — unlike SafeArgosReporter (which only
 * guards the reporter's own onEnd/onTestEnd hooks), argosScreenshot() is
 * awaited directly inside test bodies, so a rejection here fails the test
 * itself rather than surfacing as an unhandled rejection.
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
