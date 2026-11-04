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

const vp = VIEWPORTS.desktop

test.describe('Inline tags — design fidelity fixes', () => {
	test.beforeEach(async ({ page }) => {
		await page.setViewportSize({ width: vp.width, height: vp.height })
	})

	test('the edit card is a plain card on the page, and Esc closes the picker before it cancels the edit', async ({
		page,
		account,
	}, testInfo) => {
		const ws = account.workspaceId
		const stamp = Date.now()
		const cto = await account.api.createAgentActor(`Fidcto ${stamp}`, ws)
		await account.api.addWorkspaceMember(ws, cto.id)
		const conv = await account.api.createConversation(ws, {
			title: 'Fidelity edit',
			participant_actor_ids: [cto.id],
		})
		await account.api.postConversationMessage(conv.id, ws, { content: 'please start' })

		await page.goto(`/${ws}/chats/${conv.id}`)
		await page.getByRole('button', { name: 'Edit message' }).first().click()
		const box = page.getByRole('textbox', { name: 'Edit message' })
		await expect(box).toBeVisible()

		// No dark message plate around the card: Save would be black on black.
		await expect(page.locator('.bg-primary').filter({ has: box })).toHaveCount(0)
		await picture(page, testInfo, 'edit-card-plain')

		// First Esc closes the picker only. The edit and the typed text stay.
		await box.press('End')
		await page.keyboard.type(' now @')
		const option = page.getByRole('option', { name: new RegExp(`Fidcto ${stamp}`) })
		await expect(option).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(option).toHaveCount(0)
		await expect(box).toBeVisible()
		await expect(box).toContainText('please start now @')

		// Second Esc cancels the edit.
		await page.keyboard.press('Escape')
		await expect(box).toHaveCount(0)
		await expect(page.getByText('please start').first()).toBeVisible()
	})

	test('a tag of yourself in an object comment is amber, not the brand colour', async ({
		page,
		account,
	}, testInfo) => {
		const ws = account.workspaceId
		const me = await account.api.getActor(account.actorId)
		const bet = await account.api.createObject(ws, {
			type: 'bet',
			title: 'E2E self tag bet',
			status: 'opportunity',
		})
		await account.api.createComment(ws, {
			entity_id: bet.id,
			content: `cc @${me.name} on this`,
			mentions: [account.actorId],
		})

		await page.goto(`/${ws}/objects/${bet.id}`)
		const chip = page.getByRole('button', { name: `@${me.name}` })
		await expect(chip).toBeVisible({ timeout: 10_000 })
		await expect(chip).toHaveClass(/bg-warning\/10/)
		await expect(chip).not.toHaveClass(/bg-brand\/10/)
		await picture(page, testInfo, 'comment-self-tag-amber')
	})

	test('a thread reply keeps the default recipient pill, shows no "You mentioned" row, and a typed tag is no pill', async ({
		page,
		account,
	}, testInfo) => {
		const ws = account.workspaceId
		const stamp = Date.now()
		const names = [`Fidone ${stamp}`, `Fidtwo ${stamp}`]
		const agents = []
		for (const name of names) {
			const agent = await account.api.createAgentActor(name, ws)
			await account.api.addWorkspaceMember(ws, agent.id)
			agents.push(agent)
		}
		const conv = await account.api.createConversation(ws, {
			title: 'Fidelity thread',
			participant_actor_ids: agents.map((a) => a.id),
		})
		await account.api.postConversationMessage(conv.id, ws, { content: `Root ${stamp}` })

		await page.goto(`/${ws}/chats/${conv.id}`)
		await page.getByRole('button', { name: 'Reply in thread' }).click()
		const pane = page.locator('[aria-label="Thread"]')
		const box = pane.getByLabel('Reply in thread')
		await expect(box).toBeVisible()

		const pills = pane.getByRole('button', { name: /^Remove mention / })
		await expect(pills).toHaveCount(1)
		const pillName = (await pills.getAttribute('aria-label')) ?? ''
		const other = names.find((n) => !pillName.includes(n)) as string
		expect(other).toBeTruthy()

		// Tag the agent who is not the recipient, inside the sentence.
		await box.click()
		await page.keyboard.type('thanks @')
		await page.getByRole('option', { name: new RegExp(other) }).click()
		await expect(box.locator('[data-tag-id]')).toHaveCount(1)
		await page.keyboard.type('can you pick this up?')
		// The typed tag is a chip, not a pill: still only the recipient pill under the box.
		await expect(pills).toHaveCount(1)
		await picture(page, testInfo, 'thread-reply-before-send')

		await pane.getByRole('button', { name: 'Send message' }).click()
		const sent = pane.locator('[data-message-id]').filter({ hasText: 'can you pick this up?' })
		await expect(sent).toBeVisible()
		await expect(sent.getByText(`@${other}`)).toBeVisible()
		await expect(pane.getByText('You mentioned')).toHaveCount(0)
		await expect(pills).toHaveCount(1)
		await picture(page, testInfo, 'thread-reply-after-send')
	})
})
