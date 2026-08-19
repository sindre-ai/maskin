import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// v2 Object detail gate (mockup 1029–1502). The page bar carries a Properties
// toggle and the overflow menu — the shared nav row owns the breadcrumb chain
// for detail routes; the drawer the toggle opens
// holds driver / status / custom fields / subscribed / files. Below the
// document, one Activity heading with a Timeline | Related segmented control,
// and a composer pinned to the bottom of the scroll region.

// Below 768 the drawer is a modal Radix Sheet, which puts the rest of the page
// behind `aria-hidden` — the Properties toggle leaves the accessibility tree
// entirely while it is open, so its `aria-expanded` can only be read on the
// inline (>=768) drawer. Assert the drawer itself on mobile.
async function expectDrawerOpen(page: Page, viewportWidth: number) {
	if (viewportWidth < 768) {
		await expect(page.getByRole('dialog', { name: 'Sidebar' })).toBeVisible()
		return
	}
	await expect(page.getByRole('button', { name: 'Properties', exact: true })).toHaveAttribute(
		'aria-expanded',
		'true',
	)
}

async function expectDrawerClosed(page: Page, viewportWidth: number) {
	if (viewportWidth < 768) {
		await expect(page.getByRole('dialog', { name: 'Sidebar' })).toHaveCount(0)
		return
	}
	await expect(page.getByRole('button', { name: 'Properties', exact: true })).toHaveAttribute(
		'aria-expanded',
		'false',
	)
}

test.describe('Object detail — properties drawer', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`toggle opens the properties drawer at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Drawer bet',
				status: 'active',
				metadata: { priority: 'high' },
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByRole('heading', { level: 1, name: 'Drawer bet' })).toBeVisible({
				timeout: 15000,
			})

			// Scoped to the detail bar — the drawer body and the files table carry
			// their own "…properties" controls.
			const toggle = page
				.locator('main header')
				.first()
				.getByRole('button', { name: 'Properties', exact: true })
			await expect(toggle).toBeVisible()
			await expect(toggle).toHaveAttribute('aria-expanded', 'false')

			await toggle.click()
			// At mobile the drawer is a Sheet, which makes the rest of the page
			// inert — the bar's toggle leaves the a11y tree, so the open state is
			// read off the drawer itself there.
			if (vp.width >= 768) {
				await expect(toggle).toHaveAttribute('aria-expanded', 'true')
			}

			// The drawer's own sections (mockup 1381–1499).
			// The drawer's lowercase row label — distinct from the identity row's
			// "Driver" chip above the title.
			await expect(page.getByText('driver', { exact: true })).toBeVisible()
			await expect(page.getByText('Custom fields')).toBeVisible()
			await expect(page.getByText('Subscribed')).toBeVisible()
			// SUBSCRIBED carries the header note that says where the viewer stands
			// (mockup 1473) — the creator is auto-subscribed — and FILES reads
			// plainly when nothing is attached (mockup 1495), not as a dropzone.
			await expect(page.getByText('everyone here gets timeline updates')).toBeVisible()
			await expect(page.getByText('Nothing attached.')).toBeVisible()

			// No horizontal page scroll with the drawer open.
			const scrollWidth = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(scrollWidth).toBeLessThanOrEqual(0)
		})

		// Ported from the retired ObjectDocument surface onto the shell: the
		// ⌘/Ctrl+⇧+\ chord shares the header button's toggle path, and on
		// non-mobile the open/closed bit is persisted per actor under the
		// `__chrome__` display-settings row, so it survives a reload.
		test(`⌘/Ctrl+⇧+\\ toggles the drawer and the state persists at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Chord bet',
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByRole('heading', { level: 1, name: 'Chord bet' })).toBeVisible({
				timeout: 15000,
			})

			// Scoped to the detail bar — the drawer body and the files table carry
			// their own "…properties" controls.
			const toggle = page
				.locator('main header')
				.first()
				.getByRole('button', { name: 'Properties', exact: true })
			await expect(toggle).toHaveAttribute('aria-expanded', 'false')

			// The drawer's own heading is the open/closed signal that reads the
			// same at every viewport: mobile's Sheet makes the bar inert while it
			// is open, so the toggle's own attribute is unreadable there.
			const drawerHeading = page.getByText('Properties', { exact: true }).last()

			await page.keyboard.press('Control+Shift+Backslash')
			await expect(drawerHeading).toBeInViewport()

			await page.keyboard.press('Control+Shift+Backslash')
			await expect(toggle).toHaveAttribute('aria-expanded', 'false')
			await expect(drawerHeading).not.toBeInViewport()

			// Mobile's drawer is a transient Sheet by design; the persisted bit
			// only governs the inline drawer at >=768.
			if (vp.width >= 768) {
				await page.keyboard.press('Control+Shift+Backslash')
				await expect(toggle).toHaveAttribute('aria-expanded', 'true')
				await page.reload()
				await expect(page.getByRole('heading', { level: 1, name: 'Chord bet' })).toBeVisible({
					timeout: 15000,
				})
				await expect(toggle).toHaveAttribute('aria-expanded', 'true')
			}
		})

		test(`segmented control switches Timeline ⇄ Related at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Segmented bet',
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByRole('heading', { level: 1, name: 'Segmented bet' })).toBeVisible({
				timeout: 15000,
			})

			// One Activity heading, and exactly two tabs — the third "Activity"
			// tab folded into the merged stream (mockup 1138–1143).
			await expect(page.getByText('Activity', { exact: true })).toBeVisible()
			const tabs = page.getByRole('tab')
			await expect(tabs).toHaveCount(2)

			const timeline = page.getByRole('tab', { name: /^Timeline$/ })
			await expect(timeline).toHaveAttribute('aria-selected', 'true')
			// The stream's own filter chips carry per-kind counts.
			await expect(page.getByRole('button', { name: /^All \(\d+\)$/ })).toBeVisible()

			await page.getByRole('tab', { name: /^Related/ }).click()
			await expect(page.getByRole('tab', { name: /^Related/ })).toHaveAttribute(
				'aria-selected',
				'true',
			)
			await expect(page.getByText('No related objects yet')).toBeVisible()

			await timeline.click()
			await expect(timeline).toHaveAttribute('aria-selected', 'true')
		})

		test(`composer stays pinned to the bottom while the document scrolls at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Sticky composer bet',
				status: 'active',
				content: Array.from({ length: 60 }, (_, i) => `Paragraph ${i} of long content.`).join(
					'\n\n',
				),
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			const composer = page.getByPlaceholder(/^Comment/)
			await expect(composer).toBeVisible({ timeout: 15000 })

			await page.mouse.move(vp.width / 2, vp.height / 2)
			await page.mouse.wheel(0, 1200)
			await page.waitForTimeout(300)

			await expect(composer).toBeVisible()
		})
	}

	test('a subscriber row names why they are on it', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		const agent = await account.api.createAgentActor('Relay')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Driven bet',
			status: 'active',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		await expect(page.getByRole('heading', { level: 1, name: 'Driven bet' })).toBeVisible({
			timeout: 15000,
		})

		// Hand the bet to the agent through the hero driver picker.
		await page
			.getByRole('combobox')
			.filter({ hasText: /driver/i })
			.first()
			.click()
		await page.getByRole('option', { name: /Relay/ }).click()
		// The driver chip carries the agent now (mockup 1063–1094). The composer
		// stays a bare bar — the mockup gives it no hint line.
		await expect(page.getByText('Relay').first()).toBeVisible({ timeout: 10000 })
		await expect(page.getByText('Relay is listening')).toHaveCount(0)

		await page
			.locator('main header')
			.first()
			.getByRole('button', { name: 'Properties', exact: true })
			.click()
		// The creator is auto-subscribed, and the row says why they are on it.
		await expect(page.getByText('you', { exact: true })).toBeVisible()
	})
})
