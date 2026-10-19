import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import type { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Bet "Rich Markdown editor across Maskin", Slice A: a markdown file opens as an
// editable document in the file viewer behind the rich-markdown-editor flag.
//
// createFile persists bytes to S3/SeaweedFS, which the verify-e2e CI job does
// not provision (postgres only) — same constraint as file-viewer.spec.ts. The
// specs run end to end locally against a dev stack with real storage.

const HELPER_LINE = 'Edit anywhere. Type / for blocks, select text for formatting or to comment.'
const READ_ONLY_LINE =
	"This file is read-only here. Editing it could change parts you didn't touch."

// A hand-wrapped paragraph, a level 4 heading, star bullets and a setext
// heading. Everything the editor would normalise if it re-saved the whole file.
const FIXTURE = [
	'# Report',
	'',
	'First line of a hand wrapped',
	'paragraph that continues',
	'and ends here.',
	'',
	'* star one',
	'* star two',
	'',
	'Setext heading',
	'--------------',
	'',
	'#### Level four',
	'',
	'Last paragraph here.',
	'',
].join('\n')

async function seedMarkdown(
	api: TestAPI,
	workspaceId: string,
	content: string,
	options: { name?: string; mimeType?: string } = {},
) {
	return api.createFile(workspaceId, {
		name: options.name ?? 'report.md',
		// An agent's .md file often carries a generic type; the editor must still open it.
		mime_type: options.mimeType ?? 'text/plain',
		content,
		encoding: 'utf8',
	})
}

function patchRequests(page: Page): string[] {
	const seen: string[] = []
	page.on('request', (request) => {
		if (request.method() === 'PATCH' && /\/api\/files\//.test(request.url())) {
			seen.push(request.url())
		}
	})
	return seen
}

async function openEditor(page: Page, workspaceId: string, fileId: string) {
	await page.goto(`/${workspaceId}/files/${fileId}`)
	const editor = page.locator('.ProseMirror')
	await expect(editor).toBeVisible({ timeout: 10000 })
	return editor
}

/** Select the first occurrence of a word inside the editor and type over it. */
async function replaceWord(page: Page, from: string, to: string) {
	// Click first so the editor has the focus, then select the word itself.
	await page.locator('.ProseMirror').getByText(from).first().click()
	await page.evaluate((word) => {
		const walker = document.createTreeWalker(
			document.querySelector('.ProseMirror') as Node,
			NodeFilter.SHOW_TEXT,
		)
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const at = node.textContent?.indexOf(word) ?? -1
			if (at < 0) continue
			const range = document.createRange()
			range.setStart(node, at)
			range.setEnd(node, at + word.length)
			const selection = window.getSelection()
			selection?.removeAllRanges()
			selection?.addRange(range)
			return
		}
		throw new Error(`word not found: ${word}`)
	}, from)
	await page.keyboard.type(to)
}

function changedLines(before: string, after: string): string[] {
	const a = before.split('\n')
	const b = after.split('\n')
	const out: string[] = []
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		if (a[i] !== b[i]) out.push(`${a[i] ?? ''} -> ${b[i] ?? ''}`)
	}
	return out
}

test.describe('Markdown file editor in the file viewer', () => {
	test.skip(!!process.env.CI, 'S3/SeaweedFS not available in CI')

	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => {
			localStorage.setItem('ff:rich-markdown-editor', 'on')
		})
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`opens a report.md with a generic type in the editor and saves nothing at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const file = await seedMarkdown(account.api, account.workspaceId, FIXTURE)
			const before = await account.api.getFile(account.workspaceId, file.id)
			const patches = patchRequests(page)

			const editor = await openEditor(page, account.workspaceId, file.id)
			await expect(editor).toHaveAttribute('contenteditable', 'true')
			await expect(page.getByText(HELPER_LINE)).toBeVisible()
			await expect(page.getByRole('button', { name: 'Rendered' })).toBeVisible()
			await expect(page.getByRole('button', { name: 'Source' })).toBeVisible()

			// Give autosave every chance to fire.
			await page.waitForTimeout(1500)
			expect(patches).toEqual([])
			const after = await account.api.getFile(account.workspaceId, file.id)
			expect(after.content).toBe(before.content)
			expect(after.updatedAt).toBe(before.updatedAt)
			expect(after.contentHash).toBe(before.contentHash)
		})
	}

	test('changing one word saves only the block that holds it', async ({ page, account }) => {
		const file = await seedMarkdown(account.api, account.workspaceId, FIXTURE)
		await openEditor(page, account.workspaceId, file.id)

		await replaceWord(page, 'Last', 'Final')
		await expect(page.getByText('Saved')).toBeVisible({ timeout: 5000 })

		const after = await account.api.getFile(account.workspaceId, file.id)
		expect(changedLines(FIXTURE, after.content)).toEqual([
			'Last paragraph here. -> Final paragraph here.',
		])
		// The star bullets, the setext heading and the hand-wrapped paragraph were not touched.
		expect(after.content).toContain('* star one\n* star two')
		expect(after.content).toContain('Setext heading\n--------------')
		expect(after.content).toContain('First line of a hand wrapped\nparagraph that continues\n')
	})

	test('changing a word and changing it back leaves the file byte for byte as it was', async ({
		page,
		account,
	}) => {
		const file = await seedMarkdown(account.api, account.workspaceId, FIXTURE)
		await openEditor(page, account.workspaceId, file.id)
		const before = await account.api.getFile(account.workspaceId, file.id)

		await replaceWord(page, 'Last', 'Final')
		await page.keyboard.press('ControlOrMeta+z')
		await page.waitForTimeout(1500)

		const after = await account.api.getFile(account.workspaceId, file.id)
		expect(after.content).toBe(before.content)
	})

	test('shows the stored markdown, read-only, on the Source tab', async ({ page, account }) => {
		const file = await seedMarkdown(account.api, account.workspaceId, FIXTURE)
		await openEditor(page, account.workspaceId, file.id)

		await page.getByRole('button', { name: 'Source' }).click()

		await expect(page.locator('pre')).toHaveText(FIXTURE.trimEnd())
		await expect(page.locator('.ProseMirror')).toBeHidden()
		await expect(page.getByText(HELPER_LINE)).toBeHidden()
	})

	test('opens a file with front matter read-only, with the banner line and no save', async ({
		page,
		account,
	}) => {
		const content = '---\ntitle: Spec\n---\n\n# Hi\n\nsome text\n'
		const file = await seedMarkdown(account.api, account.workspaceId, content)
		const patches = patchRequests(page)

		await page.goto(`/${account.workspaceId}/files/${file.id}`)

		await expect(page.getByText(READ_ONLY_LINE)).toBeVisible({ timeout: 10000 })
		await expect(page.locator('[contenteditable="true"]')).toHaveCount(0)
		await expect(page.getByText(HELPER_LINE)).toBeHidden()
		await page.waitForTimeout(1000)
		expect(patches).toEqual([])
	})

	test('a stale tab edit against an agent write shows the banner and never overwrites the agent', async ({
		page,
		account,
	}) => {
		const file = await seedMarkdown(account.api, account.workspaceId, FIXTURE)
		await openEditor(page, account.workspaceId, file.id)
		const patches = patchRequests(page)

		// An agent writes through update_file while the tab is open.
		const agentText = '# Report\n\nAn agent rewrote this file.\n'
		await account.api.updateFile(account.workspaceId, file.id, { content: agentText })

		await replaceWord(page, 'Last', 'Final')
		const banner = page.getByRole('alert')
		await expect(banner).toContainText('This file changed while you were editing', {
			timeout: 5000,
		})

		// One refused save, no second one on its own, and the agent's text is still stored.
		await page.waitForTimeout(3000)
		expect(patches).toHaveLength(1)
		const stored = await account.api.getFile(account.workspaceId, file.id)
		expect(stored.content).toBe(agentText)

		// Load the new version shows the agent's text without a save.
		await banner.getByRole('button', { name: 'Load the new version' }).click()
		await expect(page.locator('.ProseMirror')).toContainText('An agent rewrote this file.')
		expect(patches).toHaveLength(1)
	})

	test('keep mine and overwrite needs an explicit click', async ({ page, account }) => {
		const file = await seedMarkdown(account.api, account.workspaceId, FIXTURE)
		await openEditor(page, account.workspaceId, file.id)

		await account.api.updateFile(account.workspaceId, file.id, {
			content: '# Report\n\nAn agent rewrote this file.\n',
		})
		await replaceWord(page, 'Last', 'Final')
		const banner = page.getByRole('alert')
		await expect(banner).toBeVisible({ timeout: 5000 })

		await banner.getByRole('button', { name: 'Keep mine and overwrite' }).click()
		await expect(page.getByRole('alert')).toHaveCount(0, { timeout: 5000 })

		const stored = await account.api.getFile(account.workspaceId, file.id)
		expect(stored.content).toContain('Final paragraph here.')
	})
})
