import { expect, test } from '../fixtures/auth.fixture'
import { createTestActor } from '../helpers/api.helper'
import { grantPlanHeadroom } from '../helpers/plan.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The ⌘K launcher: typing a teammate's name puts their direct message first, with the last
// message under the name, and Enter opens it. The no-chat-yet row ("Start a chat") is covered by
// the component test: the chat list makes every pair's direct message on load, so a spec cannot
// rely on one being missing.

for (const vp of SHIP_GATE_VIEWPORTS) {
	test.describe(`Launcher direct message at ${vp.label}`, () => {
		test.use({ viewport: { width: vp.width, height: vp.height } })

		test('a teammate name lists their direct message first and Enter opens it', async ({
			page,
			account,
		}) => {
			// A trial workspace allows a single human seat; this needs two.
			await grantPlanHeadroom(account.apiKey, account.workspaceId)
			const word = `Quokkamate${Date.now()}`
			const teammate = await createTestActor({ name: `${word} Teammate` })
			await account.api.addHumanByInvite(account.workspaceId, teammate)

			// A chat titled with the same word must not outrank the direct message.
			await account.api.createConversation(account.workspaceId, {
				title: `${word} planning`,
				participant_actor_ids: [teammate.id],
			})
			const dm = await account.api.createConversation(account.workspaceId, {
				title: teammate.name,
				participant_actor_ids: [teammate.id],
				direct: true,
				initial_message: 'Booked the room for ten',
			})

			await page.goto(`/${account.workspaceId}`)
			await page.keyboard.press('Control+k')
			const palette = page.getByRole('dialog', { name: 'Command palette' })
			await expect(palette).toBeVisible({ timeout: 15_000 })
			await page.getByRole('combobox', { name: 'Search or run a command' }).fill(word)

			const first = palette.getByRole('option').first()
			await expect(first).toContainText(`${word} Teammate`, { timeout: 20_000 })
			await expect(first).toContainText('You: Booked the room for ten')
			// The kind column is the full word from 640px, DM below it.
			await expect(
				first.getByText(vp.width < 640 ? 'DM' : 'DIRECT MESSAGE', { exact: true }),
			).toBeVisible()
			expect((await first.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(
				vp.width < 1024 ? 44 : 0,
			)

			await page.keyboard.press('Enter')
			await expect(page).toHaveURL(new RegExp(`/chats/${dm.id}`))
			await expect(palette).toBeHidden()
		})
	})
}
