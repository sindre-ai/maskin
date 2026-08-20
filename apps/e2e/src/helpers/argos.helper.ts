import { type ArgosScreenshotOptions, argosScreenshot } from '@argos-ci/playwright'
import type { Page } from '@playwright/test'

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
	try {
		await argosScreenshot(page, name, options)
	} catch (error) {
		console.error(`[argos] screenshot "${name}" failed, continuing without upload:`, error)
	}
}
