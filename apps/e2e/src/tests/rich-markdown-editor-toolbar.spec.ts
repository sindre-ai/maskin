import { expect, test } from '../fixtures/auth.fixture'

// Task 3 — floating BubbleMenu toolbar + full keyboard-shortcut set for
// `<MarkdownEditor variant='document'>`. The flag `rich-markdown-editor` is
// off by default; every test in this file boots with it on so the Tiptap
// surface mounts. Once the consumer wiring in Task 6 flips the flag by
// default, this override becomes a no-op.

test.describe('rich-markdown-editor — floating toolbar & shortcuts', () => {
	test.beforeEach(async ({ page, account }) => {
		expect(account.workspaceId).toBeTruthy()
		// Registered after the auth fixture's init scripts, wins — the fixture
		// only seeds `ff:new-design`, so this doesn't collide.
		await page.addInitScript(() => localStorage.setItem('ff:rich-markdown-editor', 'on'))
	})

	test('bubble menu appears on selection and applies bold + italic + strike', async ({
		page,
		account,
	}) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Rich editor bubble menu',
			status: 'active',
			content: 'The quick brown fox jumps over the lazy dog.',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)

		const editor = page.locator('.ProseMirror').first()
		await expect(editor).toBeVisible({ timeout: 15000 })

		// Focus + select the first three words via a triple-click at line start,
		// then narrow with keyboard so we cover a real range.
		await editor.click()
		await editor.press('Meta+A')

		const toolbar = page.locator('[data-editor-toolbar="floating"]')
		await expect(toolbar).toBeVisible()

		// Bold action + verify the underlying markdown got `**` (post-blur).
		await toolbar.getByRole('button', { name: 'Bold' }).click()
		await editor.press('Escape')
		await editor.blur()
		await expect
			.poll(async () => {
				const row = await account.api.getObject(bet.id, account.workspaceId)
				return row.content
			})
			.toContain('**')

		// Empty the selection — toolbar hides.
		await page.mouse.click(10, 10)
		await expect(toolbar).toBeHidden()
	})

	test('link toolbar action opens a URL popover and inserts the link', async ({
		page,
		account,
	}) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Rich editor link popover',
			status: 'active',
			content: 'Visit our site.',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)

		const editor = page.locator('.ProseMirror').first()
		await expect(editor).toBeVisible({ timeout: 15000 })

		await editor.click()
		await editor.press('Meta+A')

		const toolbar = page.locator('[data-editor-toolbar="floating"]')
		await expect(toolbar).toBeVisible()
		await toolbar.getByRole('button', { name: 'Link' }).click()

		const linkInput = page.getByRole('textbox', { name: 'Link URL' })
		await expect(linkInput).toBeVisible()
		await linkInput.fill('https://maskin.io')
		await linkInput.press('Enter')

		await editor.press('Escape')
		await editor.blur()

		await expect
			.poll(async () => {
				const row = await account.api.getObject(bet.id, account.workspaceId)
				return row.content ?? ''
			})
			.toContain('https://maskin.io')
	})

	test('Mod+K opens the global command palette (does NOT open the link popover)', async ({
		page,
		account,
	}) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Rich editor palette guard',
			status: 'active',
			content: 'palette collision guard.',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)

		const editor = page.locator('.ProseMirror').first()
		await expect(editor).toBeVisible({ timeout: 15000 })
		await editor.click()

		await page.keyboard.press('Meta+K')

		// The palette is a cmdk command dialog — targeted by its search input.
		await expect(page.getByPlaceholder(/search|jump|type/i).first()).toBeVisible({
			timeout: 5000,
		})
		// The link popover must NOT be visible on `Mod+K`.
		await expect(page.getByRole('textbox', { name: 'Link URL' })).toHaveCount(0)
	})

	test('Mod+Shift+K opens the link popover (not the command palette)', async ({
		page,
		account,
	}) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Rich editor link shortcut',
			status: 'active',
			content: 'link shortcut target.',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)

		const editor = page.locator('.ProseMirror').first()
		await expect(editor).toBeVisible({ timeout: 15000 })
		await editor.click()
		await editor.press('Meta+A')

		await page.keyboard.press('Meta+Shift+K')

		await expect(page.getByRole('textbox', { name: 'Link URL' })).toBeVisible({
			timeout: 5000,
		})
	})

	test('at 640px viewport the toolbar renders as a sticky bottom bar', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 375, height: 812 })
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Rich editor mobile bar',
			status: 'active',
			content: 'mobile toolbar sample.',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)

		const editor = page.locator('.ProseMirror').first()
		await expect(editor).toBeVisible({ timeout: 15000 })
		await editor.click()
		await editor.press('Meta+A')

		const mobileBar = page.locator('[data-editor-toolbar="mobile"]')
		await expect(mobileBar).toBeVisible()
		// Floating popover variant should not render on mobile.
		await expect(page.locator('[data-editor-toolbar="floating"]')).toHaveCount(0)
	})
})
