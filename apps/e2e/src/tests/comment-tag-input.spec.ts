import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The object comment box is the shared tag input: a picked name is a chip inside the sentence
// and its id rides the comment; a name that was only typed sends no id.
for (const vp of SHIP_GATE_VIEWPORTS) {
	test.describe(`Object comments — tags inside the text at ${vp.label}`, () => {
		test('a picked tag is sent with its id, a typed @name is not, Backspace removes a chip', async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const ws = account.workspaceId
			const agentName = `Tagcto ${Date.now()}`
			const agent = await account.api.createAgentActor(agentName, ws)
			await account.api.addWorkspaceMember(ws, agent.id)
			const bet = await account.api.createObject(ws, {
				type: 'bet',
				title: 'E2E comment tags bet',
				status: 'opportunity',
			})

			await page.goto(`/${ws}/objects/${bet.id}`)
			const box = page.getByRole('textbox', { name: 'Comment' })
			await expect(box).toBeVisible({ timeout: 10_000 })
			const send = page.getByRole('button', { name: 'Send comment' })
			const posted = () =>
				page.waitForRequest((r) => r.url().endsWith('/api/events') && r.method() === 'POST')

			// A picked chip stays inside the sentence and its id is sent.
			await box.click()
			await box.pressSequentially('cc @Tagcto')
			await page.getByRole('option', { name: new RegExp(agentName) }).click()
			await expect(box.locator('[data-tag-id]')).toHaveCount(1)
			await expect(box).toBeFocused()
			await box.pressSequentially('on the storage call')
			await expect(box.locator('[data-tag-id]')).toHaveCount(1)
			const picked = posted()
			await send.click()
			const body = JSON.parse((await picked).postData() ?? '{}')
			expect(body.content).toBe(`cc @${agentName} on the storage call`)
			expect(body.mentions).toEqual([agent.id])
			await expect(box).toHaveText('')

			// A name that never went through the picker stays plain text and sends no id. Typing
			// through the picker is a computer flow: a phone's sheet takes focus at the "@".
			if (vp.width >= 768) {
				await box.click()
				await box.pressSequentially(`plain @${agentName} typed `)
				const typed = posted()
				await send.click()
				const typedBody = JSON.parse((await typed).postData() ?? '{}')
				expect(typedBody.content).toBe(`plain @${agentName} typed`)
				expect(typedBody.mentions).toBeUndefined()
			}

			// Backspace takes the whole chip, so its id is gone from the next send.
			await box.click()
			await box.pressSequentially('@Tagcto')
			await page.getByRole('option', { name: new RegExp(agentName) }).click()
			await expect(box.locator('[data-tag-id]')).toHaveCount(1)
			await expect(box).toBeFocused()
			await page.keyboard.press('Backspace')
			await page.keyboard.press('Backspace')
			await expect(box.locator('[data-tag-id]')).toHaveCount(0)
			await box.pressSequentially('no tag now')
			const removed = posted()
			await send.click()
			expect(JSON.parse((await removed).postData() ?? '{}').mentions).toBeUndefined()
		})
	})
}
