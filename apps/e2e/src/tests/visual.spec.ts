import { argosScreenshot } from '@argos-ci/playwright'
import { expect, test } from '../fixtures/auth.fixture'

// Visual regression snapshots via Argos CI.
// These run in CI alongside functional specs; Argos compares against baselines
// from the previous passing run and posts a status check with a diff gallery.
//
// Dark mode: the app uses JS class-based theming (index.html FOUC script reads
// localStorage 'maskin-theme' and adds .dark to <html> before first paint).
// page.emulateMedia({ colorScheme }) has no effect when theme is 'light' or 'dark'
// (only matters for the 'system' setting). We set localStorage via addInitScript
// instead so the FOUC script picks it up on navigation.

async function waitForApp(page: import('@playwright/test').Page) {
	await page.waitForLoadState('load')
	// Brief settle after load — SSE connection prevents networkidle from ever firing
	await page.waitForTimeout(300)
}

async function setTheme(page: import('@playwright/test').Page, theme: 'light' | 'dark') {
	await page.addInitScript((t) => localStorage.setItem('maskin-theme', t), theme)
}

test.describe('Visual — For You (workspace landing)', () => {
	test('light mode', async ({ page, account }) => {
		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}`)
		await waitForApp(page)
		await argosScreenshot(page, 'for-you-light')
	})

	test('dark mode', async ({ page, account }) => {
		await setTheme(page, 'dark')
		await page.goto(`/${account.workspaceId}`)
		await waitForApp(page)
		await argosScreenshot(page, 'for-you-dark')
	})

	test('mobile 375px', async ({ page, account }) => {
		await page.setViewportSize({ width: 375, height: 812 })
		await page.goto(`/${account.workspaceId}`)
		await waitForApp(page)
		await argosScreenshot(page, 'for-you-mobile-375')
	})
})

test.describe('Visual — Objects list', () => {
	test('light mode', async ({ page, account }) => {
		await setTheme(page, 'light')
		await page.goto(`/${account.workspaceId}/objects`)
		await waitForApp(page)
		await argosScreenshot(page, 'objects-list-light')
	})

	test('dark mode', async ({ page, account }) => {
		await setTheme(page, 'dark')
		await page.goto(`/${account.workspaceId}/objects`)
		await waitForApp(page)
		await argosScreenshot(page, 'objects-list-dark')
	})

	test('mobile 375px', async ({ page, account }) => {
		await page.setViewportSize({ width: 375, height: 812 })
		await page.goto(`/${account.workspaceId}/objects`)
		await waitForApp(page)
		await argosScreenshot(page, 'objects-list-mobile-375')
	})
})

// Baselines for the rebuilt object-detail static shell (bet/object-detail:
// header identity row, h1 title, body) across the ship-gate viewports in both
// themes — 6 shots covering the three breakpoint modes with a seeded bet on
// the page so the shell has real content to render. The legacy properties
// sidebar it replaces for this surface (Sheet at 375, off-canvas at 768, 288
// px inline at 1024) was removed in this bet per the page enumeration.
test.describe('Visual — Object detail (static shell)', () => {
	const viewports = [
		{ width: 375, height: 812, label: 'mobile-375' },
		{ width: 768, height: 1024, label: 'tablet-768' },
		{ width: 1024, height: 768, label: 'desktop-1024' },
	]

	for (const vp of viewports) {
		for (const mode of ['light', 'dark'] as const) {
			test(`${vp.label} ${mode}`, async ({ page, account }) => {
				await setTheme(page, mode)
				await page.setViewportSize({ width: vp.width, height: vp.height })
				const bet = await account.api.createObject(account.workspaceId, {
					type: 'bet',
					title: 'Object detail shell visual',
					status: 'active',
					content: 'Hypothesis line so the body carries real content.',
				})
				await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
				await waitForApp(page)
				// Wait for the static title heading to hydrate before snapshotting
				// so the hero row isn't captured mid-render.
				await page.getByRole('heading', { level: 1, name: 'Object detail shell visual' }).waitFor({
					state: 'visible',
					timeout: 10_000,
				})
				await argosScreenshot(page, `object-detail-shell-${vp.label}-${mode}`)
			})
		}
	}
})
