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
		await expect(page.getByRole('heading', { name: 'Objects' })).toBeVisible()
		await argosScreenshot(page, 'objects-list-light')
	})

	test('dark mode', async ({ page, account }) => {
		await setTheme(page, 'dark')
		await page.goto(`/${account.workspaceId}/objects`)
		await expect(page.getByRole('heading', { name: 'Objects' })).toBeVisible()
		await argosScreenshot(page, 'objects-list-dark')
	})

	test('mobile 375px', async ({ page, account }) => {
		await page.setViewportSize({ width: 375, height: 812 })
		await page.goto(`/${account.workspaceId}/objects`)
		await expect(page.getByRole('heading', { name: 'Objects' })).toBeVisible()
		await argosScreenshot(page, 'objects-list-mobile-375')
	})
})
