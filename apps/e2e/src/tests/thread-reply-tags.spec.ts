import type { Page, TestInfo } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { VIEWPORTS } from '../helpers/viewports'

// The picture goes into the HTML report as an attachment, like chat-edit-tags.spec.ts.
async function picture(page: Page, testInfo: TestInfo, name: string) {
	await page.waitForTimeout(400)
	await testInfo.attach(name, {
		body: await page.screenshot({ path: `test-results/${name}.png` }),
		contentType: 'image/png',
	})
}

const pane = (page: Page) => page.locator('[aria-label="Thread"]')

test.describe('Chat — thread reply with tags inside the text', () => {
	for (const vp of [VIEWPORTS.mobile, VIEWPORTS.tabletLandscape]) {
		test(`a picked tag is a chip in the reply and sends its id, an unpicked name sends none at ${vp.width}px`, async ({
			page,
			account,
		}, testInfo) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const ws = account.workspaceId
			const stamp = Date.now()
			const dev = await account.api.createAgentActor(`Threaddev ${stamp}`)
			const conv = await account.api.createConversation(ws, {
				title: 'Thread tags',
				participant_actor_ids: [dev.id],
			})
			await account.api.postConversationMessage(conv.id, ws, { content: `Root ${stamp}` })

			await page.goto(`/${ws}/chats/${conv.id}`)
			await page.getByRole('button', { name: 'Reply in thread' }).click()
			const box = pane(page).getByLabel('Reply in thread')
			await expect(box).toBeVisible()

			// Type @, pick the agent, keep typing: the chip sits inside the sentence.
			await box.click()
			await page.keyboard.type('thanks @')
			const option = page.getByRole('option', { name: new RegExp(`Threaddev ${stamp}`) })
			await expect(option).toBeVisible()
			await option.click()
			await expect(box.locator('[data-tag-id]')).toHaveCount(1)
			await page.keyboard.type('go ahead')
			await expect(pane(page).getByLabel('Selected context')).toHaveCount(0)
			await picture(page, testInfo, `thread-reply-chip-${vp.width}`)
			await pane(page).getByRole('button', { name: 'Send message' }).click()

			const reply = pane(page).locator('[data-message-id]').filter({ hasText: 'go ahead' })
			await expect(reply.getByRole('link', { name: `@Threaddev ${stamp}` })).toBeVisible()
			await picture(page, testInfo, `thread-reply-sent-${vp.width}`)

			// A name typed without the picker stays plain text and sends no id.
			await box.click()
			await page.keyboard.type('and x@Threaddev too')
			await pane(page).getByRole('button', { name: 'Send message' }).click()
			await expect(pane(page).locator('[data-message-id]').filter({ hasText: 'too' })).toBeVisible()

			const { messages } = await account.api.listConversationMessages(conv.id, ws)
			const mine = messages.filter((m) => m.actorId !== dev.id && m.threadRootId != null)
			const picked = mine.find((m) => m.content.includes('go ahead'))
			const plain = mine.find((m) => m.content.includes('too'))
			expect(picked?.metadata?.mentions).toEqual([dev.id])
			expect(plain?.metadata?.mentions ?? []).toEqual([])
		})
	}
})
