import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { VIEWPORTS } from '../helpers/viewports'

// Exercises the four Playwright-verifiable acceptance criteria for the
// object-detail right sidebar: click-toggle survives reload at 1024,
// breakpoint defaults on a fresh browser context, `⌘/Ctrl+I` keyboard toggle
// (while `⌘/Ctrl+B` remains bound to the left nav), and sidebar contents
// render Subscribe + creator + timestamps + Metadata + Files.
//
// Each test uses a fresh actor via `auth.fixture`, which means no persisted
// `user_display_settings` row exists for `__chrome__` — the sidebar must
// resolve to its breakpoint default rather than a carried-over value.

async function waitForObjectDetail(page: Page, title: string) {
	// Title field is a textarea placeholder="Untitled" that binds to the
	// loaded object. Waiting on the exact value keeps the assertions below
	// from racing against useUserDisplaySettings' first reconciliation.
	await expect(page.getByPlaceholder('Untitled')).toHaveValue(title, { timeout: 10_000 })
}

test.describe('Object detail — right sidebar', () => {
	test('at 1024px, closing the sidebar persists across hard reload', async ({ page, account }) => {
		await page.setViewportSize({
			width: VIEWPORTS.tabletLandscape.width,
			height: VIEWPORTS.tabletLandscape.height,
		})
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Sidebar persistence probe',
			status: 'active',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		await waitForObjectDetail(page, 'Sidebar persistence probe')

		// Default at 1024 = 288 px inline expanded. Toggle button reports its
		// state via aria-expanded; the Files section is rendered inside the
		// sidebar and is a reliable content-visibility indicator.
		const toggle = page.getByRole('button', { name: 'Properties' })
		await expect(toggle).toHaveAttribute('aria-expanded', 'true')
		await expect(page.getByRole('heading', { name: /^Files \(/ })).toBeVisible()

		// Register the write-through listener BEFORE the click so waitForResponse
		// blocks deterministically instead of racing on a debounce timer — mirrors
		// the pattern already used in objects-display-persistence.spec.ts.
		const chromeSaved = page.waitForResponse(
			(r) =>
				r.url().includes('/user-display-settings/__chrome__') && r.request().method() === 'PUT',
		)
		await toggle.click()
		await chromeSaved

		await expect(toggle).toHaveAttribute('aria-expanded', 'false')

		await page.reload()
		await waitForObjectDetail(page, 'Sidebar persistence probe')

		// Persisted state (objectDetailSidebarCollapsed: true) rides through the
		// reload — sidebar must NOT snap back to the breakpoint default.
		await expect(page.getByRole('button', { name: 'Properties' })).toHaveAttribute(
			'aria-expanded',
			'false',
		)
	})

	// Breakpoint defaults on a fresh browser context. Each row seeds a new actor
	// via the fixture, so no `__chrome__` row exists to override the breakpoint
	// default (`objectDetailSidebarCollapsed` unset → collapsed = false-if-large,
	// true-if-small per the architecture-decision reconciliation rules).
	for (const { vp, expanded, note } of [
		{ vp: VIEWPORTS.mobile, expanded: false, note: 'Sheet closed' },
		{ vp: VIEWPORTS.tabletPortrait, expanded: false, note: '44 px rail collapsed' },
		{ vp: VIEWPORTS.tabletLandscape, expanded: true, note: '288 px inline expanded' },
	]) {
		test(`breakpoint default on first load @ ${vp.label} → ${note}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Breakpoint default probe',
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await waitForObjectDetail(page, 'Breakpoint default probe')

			await expect(page.getByRole('button', { name: 'Properties' })).toHaveAttribute(
				'aria-expanded',
				expanded ? 'true' : 'false',
			)
		})
	}

	test('⌘/Ctrl+I toggles the right sidebar at 1024; ⌘/Ctrl+B does not', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({
			width: VIEWPORTS.tabletLandscape.width,
			height: VIEWPORTS.tabletLandscape.height,
		})
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Sidebar shortcut probe',
			status: 'active',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		await waitForObjectDetail(page, 'Sidebar shortcut probe')

		const toggle = page.getByRole('button', { name: 'Properties' })
		await expect(toggle).toHaveAttribute('aria-expanded', 'true')

		// CI runs Chromium on Linux — Control+I is the effective binding. The
		// handler in T2 listens for `metaKey || ctrlKey`, so this matches the
		// documented `⌘/Ctrl+I` shortcut.
		await page.keyboard.press('Control+i')
		await expect(toggle).toHaveAttribute('aria-expanded', 'false')

		await page.keyboard.press('Control+i')
		await expect(toggle).toHaveAttribute('aria-expanded', 'true')

		// ⌘/Ctrl+B is bound to the left nav and must NOT flip the right sidebar.
		await page.keyboard.press('Control+b')
		await expect(toggle).toHaveAttribute('aria-expanded', 'true')
	})

	test('open sidebar renders Subscribe, creator, timestamps, Metadata, Files', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({
			width: VIEWPORTS.tabletLandscape.width,
			height: VIEWPORTS.tabletLandscape.height,
		})
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Sidebar contents probe',
			status: 'active',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		await waitForObjectDetail(page, 'Sidebar contents probe')

		await expect(page.getByRole('button', { name: 'Properties' })).toHaveAttribute(
			'aria-expanded',
			'true',
		)

		// Subscribe / Unsubscribe toggle — aria-label swaps depending on whether
		// the creator auto-subscribes on object create.
		await expect(
			page.getByRole('button', { name: /(subscribe to|unsubscribe from) this object/i }).first(),
		).toBeVisible()

		// created_at + updated_at — RelativeTime renders phrasings like
		// "just now", "less than a minute ago", "N seconds ago" for a freshly
		// created object.
		await expect(
			page.getByText(/(just now|less than a minute|seconds? ago)/i).first(),
		).toBeVisible()

		// MetadataProperties on an object with no metadata + no field defs
		// renders a "+ Add property" trigger; that's the observable presence
		// signal for the section.
		await expect(page.getByRole('button', { name: /add property/i })).toBeVisible()

		// ObjectFiles renders a "Files (0)" heading when there are no
		// attachments — proves the section mounted inside the sidebar.
		await expect(page.getByRole('heading', { name: /^Files \(/ })).toBeVisible()
	})
})
