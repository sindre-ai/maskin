import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { VIEWPORTS } from '../helpers/viewports'

test.describe('Chat — a link to a settings page draws as a gear chip', () => {
	for (const vp of [VIEWPORTS.mobile, VIEWPORTS.desktop]) {
		test(`a settings link in a sentence and alone on a line is a chip, never a card, at ${vp.width}px`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const ws = account.workspaceId
			const agent = await account.api.createAgentActor(`Settings chip QA Agent ${Date.now()}`)
			await account.api.addWorkspaceMember(ws, agent.id)
			const conversation = await account.api.createConversation(ws, {
				title: 'E2E settings chip',
				participant_actor_ids: [agent.id],
				initial_message: 'Opening the thread',
			})
			await new TestAPI(agent.api_key).postConversationMessage(conversation.id, ws, {
				content: [
					`You can add the server under [the MCP page](/${ws}/settings/mcp) and then invite people from [members](/${ws}/settings/members), which is a longer sentence so the chips sit in the middle of the line and wrap with it at a narrow width.`,
					`[Settings](/${ws}/settings)`,
					`[Billing](/${ws}/settings/billing)`,
					`[not a section](/${ws}/settings/nope) and [too deep](/${ws}/settings/keychain/new)`,
				].join('\n\n'),
			})
			await page.goto(`/${ws}/chats/${conversation.id}`)

			const thread = page.getByTestId('thread-messages')
			const mcp = thread.getByRole('link', { name: 'Settings: MCP' })
			await expect(mcp).toBeVisible({ timeout: 10_000 })
			await expect(mcp).toHaveAttribute('href', `/${ws}/settings/mcp`)
			await expect(thread.getByRole('link', { name: 'Settings: Members' })).toBeVisible()
			// Alone on its line it is still a chip in the text, not a card.
			await expect(thread.getByRole('link', { name: 'Settings: General' })).toBeVisible()
			await expect(thread.getByRole('link', { name: 'Settings: Billing' })).toBeVisible()
			await expect(thread.locator('[data-linked-card]')).toHaveCount(0)
			// The author's link text is replaced by the section name.
			await expect(thread.getByText('the MCP page', { exact: true })).toHaveCount(0)
			// An unknown section and a deeper path stay plain links.
			await expect(thread.getByRole('link', { name: 'not a section' })).toBeVisible()
			await expect(thread.getByRole('link', { name: 'too deep' })).toBeVisible()
			// No preview opens on hover.
			await mcp.hover()
			await expect(page.locator('[data-linked-preview]')).toHaveCount(0)
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)

			for (const colorScheme of ['light', 'dark'] as const) {
				await page.evaluate(
					(dark) => document.documentElement.classList.toggle('dark', dark),
					colorScheme === 'dark',
				)
				await page.waitForTimeout(400)
				await page.screenshot({
					path: `test-results/linked-settings-${vp.width}-${colorScheme}.png`,
				})
			}

			// A tap goes to the page, in the same tab.
			await mcp.click()
			await expect(page).toHaveURL(new RegExp(`/${ws}/settings/mcp$`))
		})
	}
})
