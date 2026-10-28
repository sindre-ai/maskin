import type { Page, Request } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Object description on the rich editor (bet 666e3c4a), flag on. The editor
// saves only the blocks the person touched, opens text it cannot split safely
// read-only, and refuses a rewrite that would lose something. One PATCH per
// blur, nothing sent when nothing changed.

const READ_ONLY_BANNER =
	"This description is read-only here. Editing it could change parts you didn't touch."

const AGENT_DESCRIPTION = `# Weekly pipeline review

Summary of what moved this week. Numbers come from the **billing** dashboard.

## What changed

- Signups up 12 percent week over week
- Trial-to-paid conversion held at 4.1 percent
- Two enterprise leads moved to *negotiation*

## Snippet

\`\`\`js
const total = items.reduce((sum, item) => sum + item.value, 0)
console.log(total)
\`\`\`

## Numbers

| Metric | Last week | This week |
|---|---|---|
| Signups | 210 | 235 |
| Paid | 9 | 10 |

## Next steps

- [ ] Follow up with the two enterprise leads
- [x] Send the weekly summary
- [ ] Review churn reasons
`

const READ_ONLY_CASES: Array<[label: string, content: string, cause: string]> = [
	['front matter', '---\ntitle: Spec\nowner: agent\n---\n\n# Spec\n\nBody.\n', 'front_matter'],
	[
		'raw HTML',
		'# Notes\n\nIntro.\n\n<details>\n<summary>More</summary>\n\nhidden\n\n</details>\n',
		'raw_html',
	],
	['an HTML comment', '# Notes\n\nIntro.\n\n<!-- agent note -->\n\nOutro.\n', 'raw_html'],
	['a footnote', '# Notes\n\nA claim.[^1]\n\n[^1]: The source.\n', 'footnote'],
	[
		'a link reference definition',
		'# Notes\n\nSee [docs][ref].\n\n[ref]: https://example.com\n',
		'link_reference',
	],
]

async function openDescription(page: Page, workspaceId: string, objectId: string) {
	await page.addInitScript(() => {
		localStorage.setItem('ff:rich-markdown-editor', 'on')
	})
	await page.goto(`/${workspaceId}/objects/${objectId}`)
}

function watchObjectWrites(page: Page, objectId: string) {
	const writes: Request[] = []
	page.on('request', (request) => {
		if (request.method() === 'PATCH' && request.url().includes(`/api/objects/${objectId}`)) {
			writes.push(request)
		}
	})
	return writes
}

async function editor(page: Page) {
	const pm = page.locator('.ProseMirror[contenteditable="true"]').first()
	await expect(pm).toBeVisible({ timeout: 15000 })
	return pm
}

async function leaveEditor(page: Page) {
	// The title field is the nearest other focus target on the page.
	await page.locator('textarea').first().click()
}

test.describe('Object description on the rich editor', () => {
	test('opening and blurring with no edit sends nothing and leaves the body unchanged', async ({
		page,
		account,
	}) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'No-edit open',
			status: 'opportunity',
			content: AGENT_DESCRIPTION,
		})
		const writes = watchObjectWrites(page, bet.id)
		await openDescription(page, account.workspaceId, bet.id)
		const pm = await editor(page)
		await pm.locator('p').first().click()
		await leaveEditor(page)
		await page.waitForTimeout(500)

		expect(writes).toHaveLength(0)
		const stored = await account.api.getObject(bet.id, account.workspaceId)
		expect(stored.content).toBe(AGENT_DESCRIPTION)
	})

	test('changing one word saves a PATCH that differs from the stored text in that block only', async ({
		page,
		account,
	}) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'One word',
			status: 'opportunity',
			content: AGENT_DESCRIPTION,
		})
		const writes = watchObjectWrites(page, bet.id)
		await openDescription(page, account.workspaceId, bet.id)
		const pm = await editor(page)
		await pm.locator('p').first().click()
		await page.keyboard.press('End')
		await page.keyboard.type(' Reviewed.')
		await leaveEditor(page)
		await expect.poll(() => writes.length).toBe(1)

		const sent = JSON.parse(writes[0]?.postData() ?? '{}') as { content: string }
		const before = AGENT_DESCRIPTION.split('\n')
		const after = sent.content.split('\n')
		expect(after).toHaveLength(before.length)
		const changed = before.flatMap((line, index) => (line === after[index] ? [] : [index]))
		expect(changed).toEqual([2])
		expect(after[2]).toBe(`${before[2]} Reviewed.`)
		// The untouched table keeps its original separator row and the file its final newline.
		expect(sent.content).toContain('|---|---|---|')
		expect(sent.content.endsWith('\n')).toBe(true)
	})

	for (const [label, content, cause] of READ_ONLY_CASES) {
		test(`a description with ${label} opens read-only and sends nothing`, async ({
			page,
			account,
		}) => {
			const task = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: `Read-only ${cause}`,
				status: 'todo',
				content,
			})
			const writes = watchObjectWrites(page, task.id)
			await openDescription(page, account.workspaceId, task.id)
			await expect(page.getByText(READ_ONLY_BANNER)).toBeVisible({ timeout: 15000 })
			await expect(page.locator('.ProseMirror[contenteditable="true"]')).toHaveCount(0)

			await leaveEditor(page)
			await page.waitForTimeout(500)
			expect(writes).toHaveLength(0)
			expect((await account.api.getObject(task.id, account.workspaceId)).content).toBe(content)
		})
	}

	test('a rewrite that would drop a link title is refused and the stored text stays', async ({
		page,
		account,
	}) => {
		const content =
			'# Notes\n\nA paragraph with a [titled link](https://example.com/a "the link title") inside it.\n\nAnother paragraph that stays.\n'
		const task = await account.api.createObject(account.workspaceId, {
			type: 'task',
			title: 'Link title',
			status: 'todo',
			content,
		})
		const writes = watchObjectWrites(page, task.id)
		await openDescription(page, account.workspaceId, task.id)
		const pm = await editor(page)
		await pm.locator('p').first().click()
		await page.keyboard.press('End')
		await page.keyboard.type(' More.')
		await leaveEditor(page)

		await expect(page.getByRole('alert')).toContainText("Couldn't save your changes")
		await page.waitForTimeout(500)
		expect(writes).toHaveLength(0)
		expect((await account.api.getObject(task.id, account.workspaceId)).content).toBe(content)
	})

	test('an empty description shows the placeholder', async ({ page, account }) => {
		const task = await account.api.createObject(account.workspaceId, {
			type: 'task',
			title: 'Empty description',
			status: 'todo',
		})
		await openDescription(page, account.workspaceId, task.id)
		const pm = await editor(page)
		await expect(pm.locator('p.is-editor-empty')).toHaveAttribute(
			'data-placeholder',
			'Add a description. Type / for blocks.',
		)
	})

	test('Enter starts a new paragraph and blur sends one PATCH with the new text', async ({
		page,
		account,
	}) => {
		const task = await account.api.createObject(account.workspaceId, {
			type: 'task',
			title: 'Enter and blur',
			status: 'todo',
		})
		const writes = watchObjectWrites(page, task.id)
		await openDescription(page, account.workspaceId, task.id)
		const pm = await editor(page)
		await pm.click()
		await page.keyboard.type('First line')
		await page.keyboard.press('Enter')
		await page.keyboard.type('Second line')
		expect(writes).toHaveLength(0)
		await leaveEditor(page)

		await expect.poll(() => writes.length).toBe(1)
		const sent = JSON.parse(writes[0]?.postData() ?? '{}') as { content: string }
		expect(sent.content).toBe('First line\n\nSecond line\n')
	})

	test('pasting a large agent markdown blob renders its blocks and saves the same text', async ({
		page,
		account,
	}) => {
		const task = await account.api.createObject(account.workspaceId, {
			type: 'task',
			title: 'Paste blob',
			status: 'todo',
		})
		const writes = watchObjectWrites(page, task.id)
		await openDescription(page, account.workspaceId, task.id)
		const pm = await editor(page)
		await pm.click()
		await pm.evaluate((node, text) => {
			const data = new DataTransfer()
			data.setData('text/plain', text)
			node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
		}, AGENT_DESCRIPTION)

		await expect(pm.locator('h1')).toHaveText('Weekly pipeline review')
		await expect(pm.locator('h2')).toHaveCount(4)
		await expect(pm.locator('pre code')).toContainText('const total')
		await expect(pm.locator('table')).toHaveCount(1)
		await expect(pm.locator('input[type="checkbox"]')).toHaveCount(3)
		await leaveEditor(page)

		await expect.poll(() => writes.length).toBe(1)
		const sent = JSON.parse(writes[0]?.postData() ?? '{}') as { content: string }
		// Pasted blocks are new to the editor, so it writes them in its own style:
		// the table separator row is padded and a checkbox keeps one extra space.
		// Everything else is the pasted text.
		const normalise = (text: string) =>
			text.replace(/\| --- \| --- \| --- \|/g, '|---|---|---|').replace(/^(- \[[ x]\]) +/gm, '$1 ')
		expect(normalise(sent.content)).toBe(AGENT_DESCRIPTION)
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`the read-only banner and the editor fit at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const task = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'Viewport fit',
				status: 'todo',
				content: READ_ONLY_CASES[0]?.[1],
			})
			await openDescription(page, account.workspaceId, task.id)
			const banner = page.getByText(READ_ONLY_BANNER)
			await expect(banner).toBeVisible({ timeout: 15000 })
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)
		})
	}
})
