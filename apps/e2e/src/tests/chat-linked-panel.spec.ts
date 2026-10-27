import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The Overview drawer's Items tab: everything the chat's messages link to, worked on in one
 * place. An agent message links a LinkedIn draft, a contact and a markdown file; the drawer
 * counts them, draws the draft as a card with Approve, the contact as the reference card and the
 * file as itself.
 */

async function assertNoHorizontalOverflow(page: Page, label: string) {
	await page.waitForTimeout(200)
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
	}))
	expect(scrollWidth, `${label}: page overflows horizontally`).toBeLessThanOrEqual(innerWidth + 1)
}

test.describe('Chat — Items tab in the Overview drawer', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`lists the draft, the contact and the file a message links to @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const draft = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'DM to Merethe Aas',
				status: 'todo',
				content: 'Hej Merethe, tak for forbindelsen. Hvad arbejder I med lige nu?',
				metadata: { kind: 'linkedin_message', to: 'Merethe Aas' },
			})
			const contact = await account.api.createObject(account.workspaceId, {
				type: 'insight',
				title: 'Storm Forsikring account notes',
				status: 'new',
			})
			const file = await account.api.createFile(account.workspaceId, {
				name: 'rollout-plan.md',
				mime_type: 'text/markdown',
				content: '# Rollout plan\n\n- ship the card\n',
				encoding: 'utf8',
			})
			const agent = await account.api.createAgentActor(`Linked Panel QA ${Date.now()}`)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			const conversation = await account.api.createConversation(account.workspaceId, {
				title: 'E2E linked panel',
				participant_actor_ids: [agent.id],
				initial_message: 'Opening the thread',
			})
			const ws = account.workspaceId
			await new TestAPI(agent.api_key).postConversationMessage(conversation.id, ws, {
				content: `The [draft](/${ws}/objects/${draft.id}), [notes](/${ws}/objects/${contact.id}) and the [plan](/${ws}/files/${file.id}).`,
			})

			await page.goto(`/${ws}/chats/${conversation.id}`)
			await expect(page.getByTestId('thread-messages')).toBeVisible({ timeout: 10_000 })

			await page.getByRole('button', { name: 'Open Overview' }).click()
			const linkedTab = page.getByRole('tab', { name: /Items/ })
			await expect(linkedTab).toBeVisible()
			await expect(linkedTab).toContainText('3')
			await linkedTab.click()

			const list = page.getByRole('list', { name: 'Linked items' })
			await expect(list.getByText('DM to Merethe Aas')).toBeVisible({ timeout: 10_000 })
			await list.getByText('DM to Merethe Aas').click()
			await expect(list.getByRole('button', { name: 'Approve' })).toBeVisible()
			await expect(list.getByText('Storm Forsikring account notes', { exact: true })).toBeVisible()
			await expect(list.getByText('rollout-plan.md')).toBeVisible()
			await expect(list.getByRole('button', { name: 'Jump to message' }).first()).toBeVisible()

			for (const colorScheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme })
				await expect(list.getByRole('button', { name: 'Approve' })).toBeVisible()
			}
			await assertNoHorizontalOverflow(page, vp.label)
		})
	}
})
