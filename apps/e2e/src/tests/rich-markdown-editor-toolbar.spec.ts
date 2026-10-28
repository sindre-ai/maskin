import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import type { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// Floating selection toolbar + keyboard shortcuts for
// `<MarkdownEditor variant='document'>`. "Mod" is Ctrl on Linux CI and Cmd on a Mac,
// so every chord uses Playwright's ControlOrMeta.

// The command palette's placeholder (see command-palette.tsx).
const PALETTE_PLACEHOLDER = 'Run a command or jump to…'

interface Account {
	workspaceId: string
	api: TestAPI
}

const SAMPLE = 'The quick brown fox jumps over the lazy dog.'

test.describe('rich markdown editor — floating toolbar & shortcuts', () => {
	test.beforeEach(async ({ account }) => {
		expect(account.workspaceId).toBeTruthy()
	})

	async function openEditor(page: Page, account: Account, content = SAMPLE) {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: `Rich editor toolbar ${Date.now()}`,
			status: 'active',
			content,
		})
		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		const editor = page.locator('.ProseMirror').first()
		await expect(editor).toBeVisible({ timeout: 15000 })
		await editor.click()
		return { bet, editor }
	}

	async function savedContent(account: Account, betId: string) {
		const row = await account.api.getObject(betId, account.workspaceId)
		return row.content ?? ''
	}

	test('bubble menu shows exactly the five marks in order and hides on an empty selection', async ({
		page,
		account,
	}) => {
		const { editor } = await openEditor(page, account)
		await editor.press('ControlOrMeta+a')

		const toolbar = page.locator('[data-editor-toolbar="floating"]')
		await expect(toolbar).toBeVisible()
		const labels = await toolbar
			.getByRole('button')
			.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
		expect(labels).toEqual(['Bold', 'Italic', 'Strikethrough', 'Inline code', 'Link'])

		// Collapsing the selection hides the menu.
		await editor.press('ArrowRight')
		await expect(toolbar).toBeHidden()
	})

	test('bubble menu hides when the editor loses focus', async ({ page, account }) => {
		const { editor } = await openEditor(page, account)
		await editor.press('ControlOrMeta+a')
		const toolbar = page.locator('[data-editor-toolbar="floating"]')
		await expect(toolbar).toBeVisible()

		await editor.evaluate((el) => (el as HTMLElement).blur())
		await expect(toolbar).toBeHidden()
	})

	const MARKS = [
		{ name: 'Bold', pattern: /\*\*The quick brown fox jumps over the lazy dog\.\*\*/ },
		{ name: 'Italic', pattern: /(\*|_)The quick brown fox jumps over the lazy dog\.\1/ },
		{ name: 'Strikethrough', pattern: /~~The quick brown fox jumps over the lazy dog\.~~/ },
		{ name: 'Inline code', pattern: /`The quick brown fox jumps over the lazy dog\.`/ },
	]
	for (const mark of MARKS) {
		test(`${mark.name} toolbar button wraps the selection in markdown`, async ({
			page,
			account,
		}) => {
			const { bet, editor } = await openEditor(page, account)
			await editor.press('ControlOrMeta+a')

			const toolbar = page.locator('[data-editor-toolbar="floating"]')
			await expect(toolbar).toBeVisible()
			await toolbar.getByRole('button', { name: mark.name }).click()
			await editor.evaluate((el) => (el as HTMLElement).blur())

			await expect.poll(() => savedContent(account, bet.id)).toMatch(mark.pattern)
		})
	}

	test('link action pre-fills a URL-like selection, edits and removes an existing link', async ({
		page,
		account,
	}) => {
		const { bet, editor } = await openEditor(page, account, 'https://example.com')
		const toolbar = page.locator('[data-editor-toolbar="floating"]')
		const linkInput = page.getByRole('textbox', { name: 'Link URL' })

		// Committing a link hands focus back to the editor a frame after the popover
		// closes, so a blur sent straight away is overtaken by it and the save-on-blur
		// never runs. Wait for that focus to land, then blur.
		const blurAfterCommit = async () => {
			await expect(linkInput).toBeHidden()
			await expect(editor).toBeFocused()
			await editor.evaluate((el) => (el as HTMLElement).blur())
		}
		// A click right after a save can land before the editor takes the selection, so
		// retry until the toolbar shows.
		const selectAll = async () => {
			await expect(async () => {
				await editor.click()
				await editor.press('ControlOrMeta+a')
				await expect(toolbar).toBeVisible({ timeout: 1000 })
			}).toPass({ timeout: 15000 })
		}

		await selectAll()
		await toolbar.getByRole('button', { name: 'Link' }).click()

		// The selection is a URL, so the popover opens pre-filled with it.
		await expect(linkInput).toHaveValue('https://example.com')
		await linkInput.fill('https://maskin.io')
		await linkInput.press('Enter')
		await blurAfterCommit()
		await expect.poll(() => savedContent(account, bet.id)).toContain('](https://maskin.io)')

		// Edit the existing link.
		await selectAll()
		await toolbar.getByRole('button', { name: 'Link' }).click()
		await expect(linkInput).toHaveValue('https://maskin.io')
		await linkInput.fill('https://example.org')
		await linkInput.press('Enter')
		await blurAfterCommit()
		await expect.poll(() => savedContent(account, bet.id)).toContain('](https://example.org)')

		// Remove it.
		await selectAll()
		await toolbar.getByRole('button', { name: 'Link' }).click()
		await page.getByRole('button', { name: 'Remove link' }).click()
		await blurAfterCommit()
		await expect.poll(() => savedContent(account, bet.id)).not.toContain('](https://example.org)')
	})

	test('Mod+K opens the global command palette (does NOT open the link popover)', async ({
		page,
		account,
	}) => {
		const { editor } = await openEditor(page, account)
		await editor.press('ControlOrMeta+a')

		await page.keyboard.press('ControlOrMeta+k')

		await expect(page.getByPlaceholder(PALETTE_PLACEHOLDER)).toBeVisible({ timeout: 5000 })
		await expect(page.getByRole('textbox', { name: 'Link URL' })).toHaveCount(0)
	})

	test('Mod+Shift+K opens the link popover (not the command palette)', async ({
		page,
		account,
	}) => {
		const { editor } = await openEditor(page, account)
		await editor.press('ControlOrMeta+a')

		await page.keyboard.press('ControlOrMeta+Shift+K')

		await expect(page.getByRole('textbox', { name: 'Link URL' })).toBeVisible({ timeout: 5000 })
		await expect(page.getByPlaceholder(PALETTE_PLACEHOLDER)).toHaveCount(0)
	})

	test('Alt+F10 moves focus into the toolbar and Escape returns it to the editor', async ({
		page,
		account,
	}) => {
		const { editor } = await openEditor(page, account)
		await editor.press('ControlOrMeta+a')
		const toolbar = page.locator('[data-editor-toolbar="floating"]')
		await expect(toolbar).toBeVisible()

		await page.keyboard.press('Alt+F10')
		await expect(toolbar.getByRole('button', { name: 'Bold' })).toBeFocused()
		// The menu stays up while focus is inside it.
		await expect(toolbar).toBeVisible()

		await page.keyboard.press('ArrowRight')
		await expect(toolbar.getByRole('button', { name: 'Italic' })).toBeFocused()

		await page.keyboard.press('Escape')
		await expect(editor).toBeFocused()
	})

	const SHORTCUTS = [
		{ keys: 'ControlOrMeta+b', selector: 'strong' },
		{ keys: 'ControlOrMeta+i', selector: 'em' },
		{ keys: 'ControlOrMeta+Shift+X', selector: 's' },
		{ keys: 'ControlOrMeta+e', selector: 'code' },
		{ keys: 'ControlOrMeta+Alt+1', selector: 'h1' },
		{ keys: 'ControlOrMeta+Alt+2', selector: 'h2' },
		{ keys: 'ControlOrMeta+Alt+3', selector: 'h3' },
		{ keys: 'ControlOrMeta+Shift+7', selector: 'ol' },
		{ keys: 'ControlOrMeta+Shift+8', selector: 'ul:not([data-type="taskList"])' },
		{ keys: 'ControlOrMeta+Shift+9', selector: 'ul[data-type="taskList"]' },
		{ keys: 'ControlOrMeta+Shift+B', selector: 'blockquote' },
	]
	for (const shortcut of SHORTCUTS) {
		test(`${shortcut.keys} applies ${shortcut.selector}`, async ({ page, account }) => {
			const { editor } = await openEditor(page, account)
			await editor.press('ControlOrMeta+a')

			await page.keyboard.press(shortcut.keys)

			await expect(editor.locator(shortcut.selector).first()).toBeVisible()
		})
	}

	test('Mod+Z and Mod+Shift+Z undo and redo a mark', async ({ page, account }) => {
		const { editor } = await openEditor(page, account)
		await editor.press('ControlOrMeta+a')
		await page.keyboard.press('ControlOrMeta+b')
		await expect(editor.locator('strong')).toBeVisible()

		await page.keyboard.press('ControlOrMeta+z')
		await expect(editor.locator('strong')).toHaveCount(0)

		await page.keyboard.press('ControlOrMeta+Shift+Z')
		await expect(editor.locator('strong')).toBeVisible()
	})

	test('Shift+Enter inserts a hard break and Backspace at the start of a heading makes it a paragraph', async ({
		page,
		account,
	}) => {
		const { editor } = await openEditor(page, account, '## Heading text')
		await editor.press('ControlOrMeta+Home')
		await expect(editor.locator('h2')).toBeVisible()
		await page.keyboard.press('Backspace')
		await expect(editor.locator('h2')).toHaveCount(0)
		await expect(editor.locator('p').first()).toContainText('Heading text')

		await editor.press('End')
		await page.keyboard.press('Shift+Enter')
		await expect(editor.locator('p br').first()).toBeAttached()
	})

	for (const viewport of [VIEWPORTS.tabletPortrait, VIEWPORTS.tabletLandscape]) {
		test(`above 640px the floating menu is used, not the mobile bar (${viewport.label})`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const { editor } = await openEditor(page, account)
			await editor.press('ControlOrMeta+a')

			await expect(page.locator('[data-editor-toolbar="floating"]')).toBeVisible()
			await expect(page.locator('[data-editor-toolbar="mobile"]')).toHaveCount(0)
		})
	}

	test(`at 640px and below a sticky format bar replaces the floating menu (${SHIP_GATE_VIEWPORTS[0].label})`, async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 375, height: 812 })
		const { editor } = await openEditor(page, account)

		// The bar is up as soon as the editor is focused: no selection needed.
		const bar = page.locator('[data-editor-toolbar="mobile"]')
		await expect(bar).toBeVisible()
		await expect(page.locator('[data-editor-toolbar="floating"]')).toHaveCount(0)

		const labels = await bar
			.getByRole('button')
			.evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
		expect(labels).toEqual([
			'Bold',
			'Italic',
			'Strikethrough',
			'Inline code',
			'Link',
			'Insert block',
		])

		// With no on-screen keyboard the bar sits flush with the bottom edge.
		const box = await bar.boundingBox()
		expect(box).not.toBeNull()
		expect(Math.round((box?.y ?? 0) + (box?.height ?? 0))).toBe(812)

		// Tapping a format button formats the word and keeps the editor focused.
		await editor.press('ControlOrMeta+a')
		await bar.getByRole('button', { name: 'Bold' }).click()
		await expect(editor.locator('strong')).toBeVisible()
		await expect(editor).toBeFocused()
	})

	test('the mobile bar slash button types a slash at the caret', async ({ page, account }) => {
		await page.setViewportSize({ width: 375, height: 812 })
		const { editor } = await openEditor(page, account, '')
		const bar = page.locator('[data-editor-toolbar="mobile"]')
		await expect(bar).toBeVisible()

		await bar.getByRole('button', { name: 'Insert block' }).click()
		await expect(editor).toContainText('/')
	})

	test('the mobile bar slash button adds a space first when the caret follows a word', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 375, height: 812 })
		const { editor } = await openEditor(page, account, 'hello')
		await editor.press('End')
		const bar = page.locator('[data-editor-toolbar="mobile"]')
		await expect(bar).toBeVisible()

		await bar.getByRole('button', { name: 'Insert block' }).click()
		// "hello/" would be mid-word and never open the slash menu.
		await expect(editor).toContainText('hello /')
	})
})
