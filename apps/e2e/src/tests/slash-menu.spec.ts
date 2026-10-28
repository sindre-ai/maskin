import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'

// Slash-command menu in the document-variant rich editor (bet 666e3c4a).
// The editor sits behind the rich-markdown-editor flag; the client-side test
// override turns it on without provisioning a tester actor.

const BLOCKS: Array<[title: string, description: string]> = [
	['Heading', 'Section title'],
	['Subheading', 'Smaller title'],
	['Bulleted list', 'Simple list'],
	['Numbered list', 'Ordered steps'],
	['Checklist', 'Tick items off'],
	['Quote', 'Call out a passage'],
	['Code block', 'Monospace, keeps spacing'],
	['Divider', 'Horizontal rule'],
]

async function openEditor(page: Page, workspaceId: string, objectId: string) {
	await page.addInitScript(() => {
		localStorage.setItem('ff:rich-markdown-editor', 'on')
	})
	await page.goto(`/${workspaceId}/objects/${objectId}`)
	const editor = page.locator('.ProseMirror').first()
	await expect(editor).toBeVisible({ timeout: 15000 })
	return editor
}

test.describe('Slash-command menu (document variant)', () => {
	test('an empty description shows the new placeholder', async ({ page, account }) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Slash menu placeholder',
			status: 'opportunity',
		})
		const editor = await openEditor(page, account.workspaceId, bet.id)
		await expect(editor.locator('p.is-editor-empty')).toHaveAttribute(
			'data-placeholder',
			'Add a description. Type / for blocks.',
		)
	})

	test('opens on / at line start, lists the eight blocks, and closes on Escape', async ({
		page,
		account,
	}) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Slash menu rows',
			status: 'opportunity',
		})
		const editor = await openEditor(page, account.workspaceId, bet.id)
		await editor.click()
		await page.keyboard.type('/')

		const menu = page.getByRole('dialog', { name: 'Insert block' })
		await expect(menu).toBeVisible()
		await expect(menu).toContainText('Blocks')
		await expect(menu).not.toContainText('Filter')
		expect((await menu.boundingBox())?.width).toBe(262)

		const rows = menu.getByRole('option')
		await expect(rows).toHaveCount(8)
		for (const [index, [title, description]] of BLOCKS.entries()) {
			await expect(rows.nth(index)).toContainText(title)
			await expect(rows.nth(index)).toContainText(description)
		}
		await expect(menu.getByRole('option', { name: /Table|Link|Heading 1/ })).toHaveCount(0)

		await page.keyboard.press('Escape')
		await expect(menu).toBeHidden()
		// The typed slash stays in the document.
		await expect(editor).toContainText('/')
	})

	test('announces the highlighted row when the arrow keys move it', async ({ page, account }) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Slash menu announce',
			status: 'opportunity',
		})
		const editor = await openEditor(page, account.workspaceId, bet.id)
		await editor.click()
		await page.keyboard.type('/')

		const menu = page.getByRole('dialog', { name: 'Insert block' })
		await expect(menu.getByRole('status')).toHaveText('Heading, Section title, 1 of 8')
		await page.keyboard.press('ArrowDown')
		await expect(menu.getByRole('status')).toHaveText('Subheading, Smaller title, 2 of 8')
	})

	test('shows only the query in bold when nothing matches', async ({ page, account }) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Slash menu no match',
			status: 'opportunity',
		})
		const editor = await openEditor(page, account.workspaceId, bet.id)
		await editor.click()
		await page.keyboard.type('/zzz')

		const menu = page.getByRole('dialog', { name: 'Insert block' })
		await expect(menu).toContainText('No matches for zzz')
		await expect(menu.locator('.font-semibold', { hasText: 'zzz' })).toHaveText('zzz')
	})

	test('does not open on / in the middle of a word', async ({ page, account }) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Slash menu mid-word',
			status: 'opportunity',
		})
		const editor = await openEditor(page, account.workspaceId, bet.id)
		await editor.click()
		await page.keyboard.type('and/or')
		await expect(page.getByRole('dialog', { name: 'Insert block' })).toHaveCount(0)
		await page.keyboard.type(' /')
		await expect(page.getByRole('dialog', { name: 'Insert block' })).toBeVisible()
	})

	test('filters by title and old names, and arrow keys plus Enter insert', async ({
		page,
		account,
	}) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Slash menu filter',
			status: 'opportunity',
		})
		const editor = await openEditor(page, account.workspaceId, bet.id)
		await editor.click()
		await page.keyboard.type('/blockquote')

		const menu = page.getByRole('dialog', { name: 'Insert block' })
		await expect(menu.getByRole('option')).toHaveCount(1)
		await expect(menu.getByRole('option').first()).toContainText('Quote')
		await page.keyboard.press('Enter')
		await expect(editor.locator('blockquote')).toHaveCount(1)
		await expect(menu).toBeHidden()
	})

	test('Heading inserts a level 2 heading', async ({ page, account }) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Slash menu heading',
			status: 'opportunity',
		})
		const editor = await openEditor(page, account.workspaceId, bet.id)
		await editor.click()
		await page.keyboard.type('/')
		await page
			.getByRole('option', { name: /^Heading/ })
			.first()
			.click()
		await page.keyboard.type('Section')
		await expect(editor.locator('h2')).toHaveText('Section')
		await expect(editor.locator('h1')).toHaveCount(0)
	})

	test('inserts a bulleted list, a code block and a divider', async ({ page, account }) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Slash menu blocks',
			status: 'opportunity',
		})
		const editor = await openEditor(page, account.workspaceId, bet.id)
		await editor.click()

		await page.keyboard.type('/bullet')
		await page.keyboard.press('Enter')
		await page.keyboard.type('first item')
		await expect(editor.locator('ul li')).toHaveText('first item')

		// Enter twice leaves the list.
		await page.keyboard.press('Enter')
		await page.keyboard.press('Enter')
		await page.keyboard.type('/divider')
		await page.keyboard.press('Enter')
		await expect(editor.locator('hr')).toHaveCount(1)

		// Code block opens a second step, defaulting to plain text.
		await page.keyboard.type('/code')
		await page.keyboard.press('Enter')
		const languages = page.getByRole('dialog', { name: 'Insert block' })
		await expect(languages).toContainText('Language')
		await expect(languages.getByRole('option').first()).toHaveText('Plain text')
		await expect(languages.getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
		await page.keyboard.press('Enter')
		await expect(editor.locator('pre code')).toHaveCount(1)
		await page.keyboard.type('const a = 1')
		await expect(editor.locator('pre code')).toContainText('const a = 1')
	})

	test('Backspace on an empty query closes the menu and keeps the slash', async ({
		page,
		account,
	}) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Slash menu backspace',
			status: 'opportunity',
		})
		const editor = await openEditor(page, account.workspaceId, bet.id)
		await editor.click()
		await page.keyboard.type('/')
		const menu = page.getByRole('dialog', { name: 'Insert block' })
		await expect(menu).toBeVisible()
		await page.keyboard.press('Backspace')
		await expect(menu).toBeHidden()
		await expect(editor).toContainText('/')
	})

	test('opens as the Insert block bottom sheet at 640px', async ({ page, account }) => {
		await page.setViewportSize({ width: 640, height: 900 })
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Slash menu mobile',
			status: 'opportunity',
		})
		const editor = await openEditor(page, account.workspaceId, bet.id)
		await editor.click()
		await page.keyboard.type('/')

		const sheet = page.getByRole('dialog', { name: 'Insert block' })
		await expect(sheet).toBeVisible()
		await expect(sheet).toContainText('Insert block')
		await expect(sheet.getByRole('option')).toHaveCount(8)
		const box = await sheet.boundingBox()
		expect(box?.width).toBe(640)
		expect((box?.y ?? 0) + (box?.height ?? 0)).toBeCloseTo(900, 0)

		await sheet.getByRole('option', { name: /Quote/ }).click()
		await expect(editor.locator('blockquote')).toHaveCount(1)
		await expect(sheet).toBeHidden()
	})
})
