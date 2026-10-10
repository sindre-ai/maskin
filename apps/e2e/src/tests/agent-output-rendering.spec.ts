import { expect, test } from '../fixtures/auth.fixture'
import { installChatMocks } from '../helpers/chat.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

const RICH_MARKDOWN = [
	'Here is a **bold** summary and _italic_ nuance.',
	'',
	'- alpha',
	'- beta',
	'- gamma',
	'',
	'```ts',
	'const x: number = 1',
	'```',
].join('\n')

for (const viewport of SHIP_GATE_VIEWPORTS) {
	test.describe(`Agent output rendering — ${viewport.label}`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } })

		test('chat transcript wraps assistant markdown in .agent-output with styled prose', async ({
			page,
			account,
		}) => {
			await installChatMocks(page, {
				workspaceId: account.workspaceId,
				humanActorId: account.actorId,
				humanActorName: 'E2E Test User',
				streamEvents: [
					{
						type: 'assistant',
						message: {
							id: 'msg-rich-render',
							content: [{ type: 'text', text: RICH_MARKDOWN }],
						},
					},
				],
			})

			await page.goto(`/${account.workspaceId}`)

			await page.getByRole('button', { name: 'Open chat' }).click()
			await expect(page.getByRole('heading', { name: 'Chat' })).toBeVisible({
				timeout: 10_000,
			})

			const input = page.getByPlaceholder('Message agents')
			await expect(input).toBeEnabled({ timeout: 10_000 })
			await input.fill('please respond with rich markdown')
			await input.press('Enter')

			// The rich markdown streams into the transcript wrapped in .agent-output.
			const wrapper = page.locator('.agent-output', { hasText: 'bold' }).first()
			await expect(wrapper).toBeVisible({ timeout: 10_000 })

			// Inline strong/em resolve to real markdown elements — not plain text.
			await expect(wrapper.locator('strong', { hasText: 'bold' })).toBeVisible()
			await expect(wrapper.locator('em', { hasText: 'italic' })).toBeVisible()

			// Lists survive the render pipeline.
			await expect(wrapper.locator('li', { hasText: 'alpha' })).toBeVisible()
			await expect(wrapper.locator('li', { hasText: 'beta' })).toBeVisible()
			await expect(wrapper.locator('li', { hasText: 'gamma' })).toBeVisible()

			// Code block renders with the muted background the .agent-output pre rule sets.
			const pre = wrapper.locator('pre').first()
			await expect(pre).toBeVisible()
			await expect(pre).toContainText('const x: number = 1')
			// The .agent-output pre rule paints a border; verify the resolved style
			// is a visible 1px border (not the empty string that plain <pre> renders with).
			const borderWidth = await pre.evaluate((el) => window.getComputedStyle(el).borderTopWidth)
			expect(borderWidth).toBe('1px')

			// The paragraph-color override is what fixed the low-contrast bug —
			// paragraph text must NOT still be inheriting muted-foreground under the wrapper.
			const paragraph = wrapper.locator('p', { hasText: 'bold' }).first()
			const paragraphColor = await paragraph.evaluate((el) => window.getComputedStyle(el).color)
			// Compare against the foreground token resolved on the same document.
			const foregroundColor = await page.evaluate(() => {
				const probe = document.createElement('div')
				probe.style.color = 'var(--foreground)'
				document.body.appendChild(probe)
				const c = window.getComputedStyle(probe).color
				probe.remove()
				return c
			})
			expect(paragraphColor).toBe(foregroundColor)
		})
	})
}
