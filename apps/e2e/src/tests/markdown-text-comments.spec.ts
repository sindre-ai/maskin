import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'

// Bet "Rich Markdown editor across Maskin", Slice B: comments on selected text in
// a markdown file, behind the rich-markdown-editor flag. A comment is a draft
// carrying a text anchor; the highlight is an editor decoration, never saved in
// the file.
//
// createFile persists bytes to S3/SeaweedFS, which the verify-e2e CI job does
// not provision (postgres only), same as markdown-file-editor.spec.ts. The specs
// run end to end locally against a dev stack with real storage.

const FIXTURE = [
	'# Quarterly review notes',
	'',
	'The quick brown fox jumps over the lazy dog. This is a plain sentence.',
	'',
	'- first item in a list',
	'- second item in a list',
	'',
	'Another paragraph: the quick brown fox again, so the quote repeats.',
	'',
	'```js',
	'const answer = 42',
	'```',
	'',
].join('\n')

const PLACEHOLDER = 'Add a comment…'
const ORPHAN_NOTE = 'The commented text was edited. The comment is kept here.'

async function select(page: Page, text: string, nth = 0) {
	await page.evaluate(
		({ text, nth }) => {
			const root = document.querySelector('.ProseMirror') as HTMLElement
			const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
			let seen = 0
			for (let node = walker.nextNode(); node; node = walker.nextNode()) {
				const at = node.textContent?.indexOf(text) ?? -1
				if (at < 0) continue
				if (seen++ < nth) continue
				root.focus()
				const range = document.createRange()
				range.setStart(node, at)
				range.setEnd(node, at + text.length)
				const selection = window.getSelection()
				selection?.removeAllRanges()
				selection?.addRange(range)
				return
			}
			throw new Error(`text not found: ${text}`)
		},
		{ text, nth },
	)
}

async function openFile(page: Page, workspaceId: string, fileId: string) {
	await page.goto(`/${workspaceId}/files/${fileId}`)
	await expect(page.locator('.ProseMirror')).toBeVisible({ timeout: 10000 })
}

/** Select text, choose Comment, type a comment and press Save draft. */
async function addDraft(page: Page, text: string, comment: string, nth = 0) {
	await select(page, text, nth)
	await page.getByRole('button', { name: 'Comment', exact: true }).click()
	const dialog = page.getByRole('dialog', { name: 'Comment on selected text' })
	await dialog.getByPlaceholder(PLACEHOLDER).fill(comment)
	await dialog.getByRole('button', { name: 'Save draft' }).click()
	await expect(dialog).toHaveCount(0)
}

/** Post the draft in the panel, so it is a saved comment that survives a reload. */
async function postDraft(page: Page) {
	await page.locator('[data-comment-draft]').getByRole('button', { name: 'Save draft' }).click()
	await expect(page.locator('[data-comment-draft]')).toHaveCount(0)
}

test.describe('Comments on selected text in a markdown file', () => {
	test.skip(!!process.env.CI, 'S3/SeaweedFS not available in CI')

	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => {
			localStorage.setItem('ff:rich-markdown-editor', 'on')
		})
	})

	test('offers Comment only inside one paragraph or heading', async ({ page, account }) => {
		const file = await account.api.createFile(account.workspaceId, {
			name: 'notes.md',
			mime_type: 'text/markdown',
			content: FIXTURE,
			encoding: 'utf8',
		})
		await openFile(page, account.workspaceId, file.id)
		const comment = page.getByRole('button', { name: 'Comment', exact: true })

		await select(page, 'lazy dog')
		await expect(comment).toBeVisible()
		await select(page, 'Quarterly')
		await expect(comment).toBeVisible()
		await select(page, 'second item')
		await expect(comment).toHaveCount(0)
		await select(page, 'answer')
		await expect(comment).toHaveCount(0)
	})

	test('compose box: Save draft is disabled until there is text, Esc leaves no draft', async ({
		page,
		account,
	}) => {
		const file = await account.api.createFile(account.workspaceId, {
			name: 'notes.md',
			mime_type: 'text/markdown',
			content: FIXTURE,
			encoding: 'utf8',
		})
		await openFile(page, account.workspaceId, file.id)
		await select(page, 'lazy dog')
		await page.getByRole('button', { name: 'Comment', exact: true }).click()
		const dialog = page.getByRole('dialog', { name: 'Comment on selected text' })
		await expect(dialog).toBeVisible()
		expect((await dialog.boundingBox())?.width).toBe(288)
		await expect(dialog.getByPlaceholder(PLACEHOLDER)).toBeFocused()
		await expect(dialog.getByRole('button', { name: 'Save draft' })).toBeDisabled()
		await page.keyboard.press('Escape')
		await expect(dialog).toHaveCount(0)
		await expect(page.locator('[data-comment-draft]')).toHaveCount(0)
		await expect(page.locator('.maskin-comment-highlight')).toHaveCount(0)
	})

	test('a saved draft carries the anchor, leaves the file bytes alone and survives a reload', async ({
		page,
		account,
	}) => {
		const file = await account.api.createFile(account.workspaceId, {
			name: 'notes.md',
			mime_type: 'text/markdown',
			content: FIXTURE,
			encoding: 'utf8',
		})
		const patches: string[] = []
		page.on('request', (request) => {
			if (request.method() === 'PATCH' && /\/api\/files\//.test(request.url())) {
				patches.push(request.url())
			}
		})
		await openFile(page, account.workspaceId, file.id)

		await addDraft(page, 'lazy dog', 'Is this the right animal?')
		await expect(page.locator('.maskin-comment-highlight')).toHaveText('lazy dog')
		await expect(page.locator('[data-comment-draft]')).toHaveCount(1)
		await postDraft(page)
		await expect(page.getByText('In text', { exact: true })).toBeVisible()

		// The comment row carries text_anchor and a placeholder position, not the legacy selector.
		const response = await page.request.get(`/api/files/${file.id}/comments`, {
			headers: { Authorization: `Bearer ${account.apiKey}`, 'X-Workspace-Id': account.workspaceId },
		})
		const rows = (await response.json()) as Array<{
			selector: string | null
			textAnchor: { quote: string; prefix: string; suffix: string } | null
			positionDoc: { x: number; y: number }
		}>
		expect(rows).toHaveLength(1)
		expect(rows[0]?.selector).toBeNull()
		expect(rows[0]?.textAnchor?.quote).toBe('lazy dog')
		expect(rows[0]?.textAnchor?.prefix.length).toBeLessThanOrEqual(24)
		expect(rows[0]?.textAnchor?.suffix.length).toBeLessThanOrEqual(24)

		// The file is exactly what it was: no PATCH, same bytes, nothing in Source.
		expect(patches).toHaveLength(0)
		const after = await account.api.getFile(account.workspaceId, file.id)
		expect(after.content).toBe(FIXTURE)
		await page.getByText('Source', { exact: true }).click()
		await expect(page.locator('pre.font-mono').first()).toHaveText(FIXTURE.trimEnd())
		await page.getByText('Rendered', { exact: true }).click()

		await page.reload()
		await expect(page.locator('.ProseMirror')).toBeVisible()
		await expect(page.locator('.maskin-comment-highlight')).toHaveText('lazy dog')
	})

	test('picks the right one of two identical quotes', async ({ page, account }) => {
		const file = await account.api.createFile(account.workspaceId, {
			name: 'notes.md',
			mime_type: 'text/markdown',
			content: FIXTURE,
			encoding: 'utf8',
		})
		await openFile(page, account.workspaceId, file.id)
		await addDraft(page, 'quick brown fox', 'Second one', 1)
		await expect(page.locator('.maskin-comment-highlight')).toHaveCount(1)
		await expect(
			page.locator('p', { has: page.locator('.maskin-comment-highlight') }),
		).toContainText('Another paragraph')
	})

	test('survives an unrelated edit, with a one-line byte diff, then shows Orphaned once its passage is deleted', async ({
		page,
		account,
	}) => {
		const file = await account.api.createFile(account.workspaceId, {
			name: 'notes.md',
			mime_type: 'text/markdown',
			content: FIXTURE,
			encoding: 'utf8',
		})
		await openFile(page, account.workspaceId, file.id)
		await addDraft(page, 'lazy dog', 'Check this')
		await postDraft(page)

		// An edit in the heading: only the heading line changes in the saved file.
		await page.locator('.ProseMirror').getByText('Quarterly').click()
		await page.keyboard.press('Home')
		await page.keyboard.type('X')
		await expect(page.getByText('Saved', { exact: true })).toBeVisible({ timeout: 10000 })
		const edited = await account.api.getFile(account.workspaceId, file.id)
		const before = FIXTURE.split('\n')
		const changed = edited.content
			.split('\n')
			.map((line, index) => (line === before[index] ? null : line))
			.filter((line) => line !== null)
		expect(changed).toEqual(['# XQuarterly review notes'])
		await expect(page.locator('.maskin-comment-highlight')).toHaveText('lazy dog')

		// Delete the commented passage: no highlight, the card stays, struck through.
		await select(page, 'lazy dog')
		await page.keyboard.press('Backspace')
		await expect(page.locator('.maskin-comment-highlight')).toHaveCount(0)
		await expect(page.getByText(ORPHAN_NOTE)).toBeVisible()
		await expect(page.getByTestId('comment-quote-orphaned')).toHaveClass(/line-through/)
		await page.getByRole('button', { name: 'Resolve' }).first().click()
		await page.getByRole('tab', { name: /Resolved/ }).click()
		await expect(page.getByText('Check this')).toBeVisible()
	})

	test('clicking a highlight marks its card, and the quote button goes back to the text', async ({
		page,
		account,
	}) => {
		const file = await account.api.createFile(account.workspaceId, {
			name: 'notes.md',
			mime_type: 'text/markdown',
			content: FIXTURE,
			encoding: 'utf8',
		})
		await openFile(page, account.workspaceId, file.id)
		await addDraft(page, 'lazy dog', 'Check this')
		await postDraft(page)
		await page.locator('.ProseMirror').getByText('Quarterly').click()
		await expect(page.locator('[data-comment-card][data-active]')).toHaveCount(0)
		await page.locator('.maskin-comment-highlight').click()
		const card = page.locator('[data-comment-card][data-active]')
		await expect(card).toHaveCount(1)
		await expect(page.locator('.maskin-comment-highlight')).toHaveAttribute(
			'aria-describedby',
			(await card.getAttribute('id')) ?? '',
		)
		await page.getByRole('button', { name: 'Go to commented text' }).click()
		await expect(page.locator('.ProseMirror')).toBeFocused()
	})

	test('mobile: Comment sits on the format bar before the slash button and opens a sheet', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 640, height: 900 })
		const file = await account.api.createFile(account.workspaceId, {
			name: 'notes.md',
			mime_type: 'text/markdown',
			content: FIXTURE,
			encoding: 'utf8',
		})
		await openFile(page, account.workspaceId, file.id)
		await select(page, 'lazy dog')
		const bar = page.locator('[data-editor-toolbar="mobile"]')
		const labels = await bar
			.locator('button')
			.evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))
		expect(labels.slice(-2)).toEqual(['Comment', 'Insert block'])
		await bar.getByRole('button', { name: 'Comment', exact: true }).click()
		const sheet = page.getByRole('dialog', { name: 'Comment on selected text' })
		await expect(sheet).toBeVisible()
		expect((await sheet.getByRole('button', { name: 'Discard' }).boundingBox())?.height).toBe(40)
	})
})
