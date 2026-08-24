import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The `new-design` flag's boundary lives in
// apps/web/src/routes/_authed/$workspaceId.tsx and swaps the whole app shell —
// sidebar, top nav, command palette, mobile bottom bar — between the v2 set and
// the pre-v2 set under components/layout/legacy.
//
// Both sides are driven here through the TEST-ONLY localStorage override
// (`ff:new-design` = 'on' | 'off'), which beats the server response. That is the
// only reason this key exists: it lets one run exercise both code paths without
// provisioning a second actor on the backend's FF_TESTER_ACTOR_IDS list. Real
// testers never touch it — the backend resolves their flag on login.
//
// The auth fixture seeds 'on' for every other spec, so each test here sets its
// own value explicitly rather than relying on the default.
async function setFlag(page: import('@playwright/test').Page, value: 'on' | 'off') {
	await page.addInitScript((v) => {
		localStorage.setItem('ff:new-design', v as string)
	}, value)
}

for (const viewport of SHIP_GATE_VIEWPORTS) {
	test.describe(`new-design flag boundary @ ${viewport.label}`, () => {
		test('renders the v2 shell when the flag is on', async ({ page, account }) => {
			await setFlag(page, 'on')
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}`)

			await expect(page.locator('[data-shell="v2"]')).toBeVisible()
			await expect(page.locator('[data-shell="v1"]')).toHaveCount(0)

			// A real v2-only surface, not just the marker attribute: the workspace
			// search field in the top nav exists only in the v2 header.
			await expect(page.getByLabel('Search the workspace').first()).toBeAttached()
		})

		test('renders the legacy shell when the flag is off', async ({ page, account }) => {
			await setFlag(page, 'off')
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}`)

			await expect(page.locator('[data-shell="v1"]')).toBeVisible()
			await expect(page.locator('[data-shell="v2"]')).toHaveCount(0)

			// The v2-only surfaces are genuinely gone, not merely hidden.
			await expect(page.getByLabel('Search the workspace')).toHaveCount(0)
			await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0)
		})

		test('the flag survives a reload without flashing the other shell', async ({
			page,
			account,
		}) => {
			await setFlag(page, 'off')
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}`)
			await expect(page.locator('[data-shell="v1"]')).toBeVisible()

			await page.reload()
			await expect(page.locator('[data-shell="v1"]')).toBeVisible()
			await expect(page.locator('[data-shell="v2"]')).toHaveCount(0)
		})
	})
}

test.describe('new-design flag boundary — colour modes', () => {
	for (const scheme of ['light', 'dark'] as const) {
		test(`both shells render in ${scheme} mode`, async ({ page, account }) => {
			await page.emulateMedia({ colorScheme: scheme })
			await page.setViewportSize({ width: 1024, height: 768 })

			await setFlag(page, 'on')
			await page.goto(`/${account.workspaceId}`)
			await expect(page.locator('[data-shell="v2"]')).toBeVisible()

			await page.addInitScript(() => {
				localStorage.setItem('ff:new-design', 'off')
			})
			await page.reload()
			await expect(page.locator('[data-shell="v1"]')).toBeVisible()
		})
	}
})
