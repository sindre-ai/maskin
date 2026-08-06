import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The global header's two former icon buttons ("Create new" + "Open chat")
// were merged into a single "New" menu (layout/header.tsx). Coverage:
//   1. The menu renders every entry point at all three ship-gate viewports.
//   2. Each entry point actually does the right thing (chat panel, object
//      creation seeded to the right subtype, agent/loop creation, command
//      palette).
//   3. Object-detail pages keep the button but hide "Create an object".
//
// Other pages (Objects list, Loops, Agents, Triggers) may render their own
// contextual "New" button in the page body — locators here scope to the
// global `header` element to target this menu specifically.

function headerNewTrigger(page: Page) {
	return page.locator('header').getByRole('button', { name: /^new$/i })
}

test.describe('Header New menu', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders all entry points at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await page.goto(`/${account.workspaceId}`)

			await headerNewTrigger(page).click()

			await expect(page.getByRole('menuitem', { name: /new chat/i })).toBeVisible()
			await expect(page.getByText('Create an object')).toBeVisible()
			await expect(page.getByRole('menuitem', { name: /^new task$/i })).toBeVisible()
			await expect(page.getByRole('menuitem', { name: /^new insight$/i })).toBeVisible()
			await expect(page.getByRole('menuitem', { name: /^new bet$/i })).toBeVisible()
			await expect(page.getByRole('menuitem', { name: /new loop/i })).toBeVisible()
			await expect(page.getByRole('menuitem', { name: /new agent/i })).toBeVisible()
			await expect(page.getByRole('menuitem', { name: /find a past conversation/i })).toBeVisible()
		})
	}

	test('New chat opens the chat panel', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}`)

		await headerNewTrigger(page).click()
		await page.getByRole('menuitem', { name: /new chat/i }).click()

		await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible({ timeout: 10000 })
	})

	test('New task opens CreatePicker seeded to the task subtype', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}`)

		await headerNewTrigger(page).click()
		await page.getByRole('menuitem', { name: /^new task$/i }).click()

		// Seeded with a defaultType, so the picker skips the type-selector step
		// and goes straight to the title input.
		await expect(page.getByPlaceholder('What are you creating?')).toBeVisible()
		await expect(page.getByRole('radiogroup', { name: 'Type' })).toHaveCount(0)
	})

	test('New loop opens CreatePicker for a trigger', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}`)

		await headerNewTrigger(page).click()
		await page.getByRole('menuitem', { name: /new loop/i }).click()

		const dialog = page.getByRole('dialog')
		await expect(dialog.getByText('New trigger')).toBeVisible()
		await expect(page.getByPlaceholder('What are you creating?')).toBeVisible()
	})

	test('New agent opens CreatePicker for an agent', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}`)

		await headerNewTrigger(page).click()
		await page.getByRole('menuitem', { name: /new agent/i }).click()

		const dialog = page.getByRole('dialog')
		await expect(dialog.getByText('New agent')).toBeVisible()
		await expect(page.getByPlaceholder('What are you creating?')).toBeVisible()
	})

	test('Find a past conversation opens the command palette', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}`)

		await headerNewTrigger(page).click()
		await page.getByRole('menuitem', { name: /find a past conversation/i }).click()

		await expect(page.getByPlaceholder('Search objects, navigate...')).toBeVisible()
	})

	test('hides "Create an object" but keeps the menu on an object-detail page', async ({
		page,
		account,
	}) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Header New menu object-detail check',
			status: 'signal',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		await expect(page.getByPlaceholder('Untitled')).toHaveValue(
			'Header New menu object-detail check',
			{ timeout: 10000 },
		)

		await expect(headerNewTrigger(page)).toBeVisible()
		await headerNewTrigger(page).click()

		await expect(page.getByRole('menuitem', { name: /new chat/i })).toBeVisible()
		await expect(page.getByText('Create an object')).toHaveCount(0)
		await expect(page.getByRole('menuitem', { name: /^new task$/i })).toHaveCount(0)
	})
})
