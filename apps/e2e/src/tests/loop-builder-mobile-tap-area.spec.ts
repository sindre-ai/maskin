import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { installChatMocks } from '../helpers/chat.helper'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// WCAG 2.5.5 / parent bet 44px floor for the /loops/new footer buttons.
const TAP_TARGET_MIN_PX = 44
const EXAMPLE_CHIP = /Notify me weekly with a summary of new customer feedback/i

async function draftAndOpenPlanCard(page: Page, workspaceId: string) {
	await page.goto(`/${workspaceId}/loops/new`)
	await expect(page.getByText(/The loop appears here/i)).toBeVisible({ timeout: 10_000 })
	await page.getByRole('button', { name: EXAMPLE_CHIP }).click()
	await expect(page.getByText('PROPOSED LOOP')).toBeVisible({ timeout: 10_000 })
}

async function measureHeight(page: Page, name: RegExp | string): Promise<number> {
	const el = page.getByRole('button', { name })
	await expect(el).toBeVisible()
	const box = await el.boundingBox()
	if (!box) throw new Error(`no bounding box for ${String(name)}`)
	return box.height
}

for (const viewport of SHIP_GATE_VIEWPORTS) {
	test.describe(`/loops/new footer buttons — ${viewport.label}`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } })

		test('footer buttons meet 44px touch target on mobile', async ({ page, account }) => {
			await installChatMocks(page, {
				workspaceId: account.workspaceId,
				humanActorId: account.actorId,
				humanActorName: account.actorId,
			})
			await draftAndOpenPlanCard(page, account.workspaceId)

			const isMobile = viewport.width < 768

			const adjustHeight = await measureHeight(page, /^adjust$/i)
			const createHeight = await measureHeight(page, /create loop/i)
			const doneHeight = await measureHeight(page, /^done$/i)

			if (isMobile) {
				expect(
					adjustHeight,
					`Adjust must be ≥ ${TAP_TARGET_MIN_PX}px at ${viewport.label}`,
				).toBeGreaterThanOrEqual(TAP_TARGET_MIN_PX)
				expect(
					createHeight,
					`Create loop must be ≥ ${TAP_TARGET_MIN_PX}px at ${viewport.label}`,
				).toBeGreaterThanOrEqual(TAP_TARGET_MIN_PX)
				expect(
					doneHeight,
					`Done must be ≥ ${TAP_TARGET_MIN_PX}px at ${viewport.label}`,
				).toBeGreaterThanOrEqual(TAP_TARGET_MIN_PX)
			}

			await page.getByRole('button', { name: /adjust/i }).click()
			const saveHeight = await measureHeight(page, /^save$/i)
			if (isMobile) {
				expect(
					saveHeight,
					`Save must be ≥ ${TAP_TARGET_MIN_PX}px at ${viewport.label}`,
				).toBeGreaterThanOrEqual(TAP_TARGET_MIN_PX)
			}
			await page.getByRole('button', { name: /^save$/i }).click()

			await page.getByRole('button', { name: /create loop/i }).click()
			await expect(page.getByText('Loop created')).toBeVisible({ timeout: 10_000 })

			const openLoop = page.getByRole('link', { name: /open loop/i })
			await expect(openLoop).toBeVisible()
			const openBox = await openLoop.boundingBox()
			if (!openBox) throw new Error('no bounding box for Open loop')
			if (isMobile) {
				expect(
					openBox.height,
					`Open loop must be ≥ ${TAP_TARGET_MIN_PX}px at ${viewport.label}`,
				).toBeGreaterThanOrEqual(TAP_TARGET_MIN_PX)
			}
		})
	})
}

test.describe('/loops/new footer no regression at 1280px', () => {
	test.use({ viewport: { width: VIEWPORTS.desktopXl.width, height: VIEWPORTS.desktopXl.height } })

	test('footer buttons stay at the compact size on desktop', async ({ page, account }) => {
		await installChatMocks(page, {
			workspaceId: account.workspaceId,
			humanActorId: account.actorId,
			humanActorName: account.actorId,
		})
		await draftAndOpenPlanCard(page, account.workspaceId)

		// At desktop the design keeps the sm (h-9 = 36px) footer height — the
		// mobile min-h override must reset above md.
		const createHeight = await measureHeight(page, /create loop/i)
		expect(createHeight).toBeLessThan(44)
		expect(createHeight).toBeGreaterThanOrEqual(32)
	})
})
