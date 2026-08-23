import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The v2 create overlay (components/shared/create-picker.tsx). It is a
// ResponsiveDialog — a centred dialog from 768px up, a bottom sheet below it —
// so every assertion here has to hold in both shapes.
//
// The overlay never structures prose itself: picking an object type and
// sending hands the description to a real agent as a conversation, and the
// agent (which holds `get_workspace_schema` + `create_objects`) creates the
// object. So the "created" assertion in this file is that a conversation
// exists carrying the request — not that an object row appeared.

async function openOverlay(page: Page, workspaceId: string) {
	await page.goto(`/${workspaceId}/objects`)
	// The `c` shortcut is bound by the Objects list. With no `?type=` filter it
	// opens the overlay with no type seeded — the greet state.
	await expect(page.getByRole('heading', { name: 'Objects' }).first()).toBeVisible({
		timeout: 30000,
	})
	// Click a non-focusable element so the shortcut lands on the document, not
	// inside a text field (isCreateShortcut deliberately ignores those).
	await page.getByRole('heading', { name: 'Objects' }).first().click()
	await page.keyboard.press('c')
	await expect(page.getByRole('dialog')).toBeVisible()
}

function dialog(page: Page) {
	return page.getByRole('dialog')
}

/** The 5px type spine — a text-free indicator, so it has no accessible name.
 *  It is the first child of the overlay content in both dialog and sheet form. */
function spine(page: Page) {
	return dialog(page).locator('> div').first()
}

/** The type chips are `<label>`s wrapping an `sr-only` radio — the radio itself
 *  is clipped to 1px and sits under its own label, so clicking it never lands.
 *  Drive the label; assert the radio role separately. */
function typeChip(page: Page, label: string) {
	return dialog(page)
		.locator('label')
		.filter({ hasText: new RegExp(`^${label}$`) })
}

test.describe('Create overlay', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`composer, type chips and send are reachable at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await openOverlay(page, account.workspaceId)

			await expect(dialog(page).getByText('Create something — or type freely')).toBeVisible()
			await expect(page.getByRole('button', { name: /just want to talk/i })).toBeVisible()
			await expect(page.getByRole('radio', { name: 'Bet' })).toBeVisible()
			await expect(page.getByRole('dialog').getByLabel('Title', { exact: true })).toBeVisible()
			await expect(page.getByRole('button', { name: 'Pick a type' })).toBeVisible()

			// The overlay must never push the page itself sideways.
			const overflows = await page.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
			)
			expect(overflows).toBe(false)
		})
	}

	test('picking a type and sending hands the description to an agent as a chat', async ({
		page,
		account,
	}) => {
		const agent = await account.api.createAgentActor(`E2E Router ${Date.now()}`)
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)

		await openOverlay(page, account.workspaceId)
		await typeChip(page, 'Bet').click()

		// The type is now a clearable pill, and the body names the type.
		await expect(dialog(page).getByText('New bet')).toBeVisible()
		await expect(page.getByRole('button', { name: /remove bet type/i })).toBeVisible()

		// Routing is knowable before sending — the agent that picks it up.
		await expect(dialog(page).getByText('Routing')).toBeVisible()
		await expect(page.getByRole('combobox', { name: 'Agent that picks this up' })).toBeVisible({
			timeout: 15000,
		})

		await page
			.getByRole('dialog')
			.getByLabel('Title', { exact: true })
			.fill('Weekly digests lift activation for trial teams')

		const send = page.getByRole('button', { name: /^Send to / })
		await expect(send).toBeEnabled()
		await send.click()

		// Lands in the conversation the agent will answer in.
		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/chats/[^/]+$`), {
			timeout: 15000,
		})
		await expect(
			page.getByText('Weekly digests lift activation for trial teams').first(),
		).toBeVisible({ timeout: 15000 })
	})

	test('free text with no type routes to a chat and says so', async ({ page, account }) => {
		const agent = await account.api.createAgentActor(`E2E Talker ${Date.now()}`)
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)

		await openOverlay(page, account.workspaceId)
		await page
			.getByRole('dialog')
			.getByLabel('Title', { exact: true })
			.fill('Catch me up on billing')

		await expect(dialog(page).getByText(/opens it as a chat in/i)).toBeVisible()
		await expect(dialog(page).getByText('picks this up when you send')).toBeVisible({
			timeout: 15000,
		})

		const send = page.getByRole('button', { name: /^Send to / })
		await expect(send).toBeEnabled()
		await send.click()

		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/chats/[^/]+$`), {
			timeout: 15000,
		})
	})

	test('slash opens the type menu and the keyboard selects a row', async ({ page, account }) => {
		await openOverlay(page, account.workspaceId)
		const input = page.getByRole('dialog').getByLabel('Title', { exact: true })
		await input.fill('/')

		const listbox = page.getByRole('listbox', { name: 'Pick a type' })
		await expect(listbox).toBeVisible()
		// Loop / agent / trigger are workspace entities, reachable only here.
		await expect(listbox.getByRole('option', { name: /Loop/ })).toBeVisible()
		await expect(listbox.getByRole('option', { name: /Trigger/ })).toBeVisible()

		await input.press('ArrowDown')
		await input.press('Enter')

		await expect(page.getByRole('listbox')).toHaveCount(0)
		await expect(page.getByRole('button', { name: /remove .* type/i })).toBeVisible()
	})

	test('backspace on an empty input clears the type and brings the chips back', async ({
		page,
		account,
	}) => {
		await openOverlay(page, account.workspaceId)
		await typeChip(page, 'Bet').click()
		await expect(dialog(page).getByText('New bet')).toBeVisible()

		await page.getByRole('dialog').getByLabel('Title', { exact: true }).press('Backspace')

		await expect(dialog(page).getByText('New bet')).toHaveCount(0)
		await expect(page.getByRole('radio', { name: 'Bet' })).toBeVisible()
	})

	test('the greet card routes out to the Chats zero state', async ({ page, account }) => {
		await openOverlay(page, account.workspaceId)
		await page.getByRole('button', { name: /just want to talk/i }).click()

		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/chats/new$`))
		await expect(page.getByRole('heading', { name: 'New chat' })).toBeVisible({ timeout: 10000 })
	})

	for (const scheme of ['light', 'dark'] as const) {
		test(`the spine and the type pill stay visible in ${scheme} mode`, async ({
			page,
			account,
		}) => {
			// The app's theme comes from localStorage (default `light`), so the
			// media emulation alone would not flip it.
			await page.addInitScript((t) => localStorage.setItem('maskin-theme', t), scheme)
			await page.emulateMedia({ colorScheme: scheme })
			await openOverlay(page, account.workspaceId)

			// Neutral spine in the empty state — must still paint, not be transparent.
			const emptyFill = await spine(page).evaluate((el) => getComputedStyle(el).backgroundColor)
			expect(emptyFill).not.toBe('rgba(0, 0, 0, 0)')
			expect(emptyFill).not.toBe('transparent')

			await typeChip(page, 'Bet').click()
			const typedFill = await spine(page).evaluate((el) => getComputedStyle(el).backgroundColor)
			expect(typedFill).not.toBe('rgba(0, 0, 0, 0)')
			expect(typedFill).not.toBe(emptyFill)

			// The pill carries text, so it must be legible against its own tint.
			await expect(page.getByRole('button', { name: /remove bet type/i })).toBeVisible()
			await expect(dialog(page).getByText('New bet')).toBeVisible()
		})
	}
})
