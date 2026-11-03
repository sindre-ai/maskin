import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { VIEWPORTS } from '../helpers/viewports'

test.describe('Chat — a linked chat draws as a chat chip and card', () => {
	for (const vp of [VIEWPORTS.mobile, VIEWPORTS.desktop]) {
		test(`one message mixes a chat card, a chat chip and an unavailable chat at ${vp.width}px`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const ws = account.workspaceId
			const agent = await account.api.createAgentActor(`Unfurl QA Agent ${Date.now()}`)
			await account.api.addWorkspaceMember(ws, agent.id)

			// A chat you are in, with a last message and pinned: in the sidebar's list, so a full card.
			const pinned = await account.api.createConversation(ws, {
				title: 'Launch plan',
				participant_actor_ids: [agent.id],
				initial_message: 'Opening the thread',
			})
			await new TestAPI(agent.api_key).postConversationMessage(pinned.id, ws, {
				content: 'The pricing page is **live** and the checkout works',
			})
			await account.api.updateConversationMe(pinned.id, ws, { pinned: true })

			// An archived chat is not in the default list, so it is read by id: no last message.
			const archived = await account.api.createConversation(ws, {
				title: 'Old retro',
				participant_actor_ids: [agent.id],
				initial_message: 'Last words',
			})
			await account.api.updateConversationMe(archived.id, ws, { archived: true })

			// A chat you are not in: it reads the same as a deleted one.
			const stranger = await account.api.createAgentActor(`Stranger Agent ${Date.now()}`)
			await account.api.addWorkspaceMember(ws, stranger.id)
			const hidden = await new TestAPI(stranger.api_key).createConversation(ws, {
				title: 'Secret plans',
				participant_actor_ids: [],
				initial_message: 'Not for you',
			})

			const host = await account.api.createConversation(ws, {
				title: 'E2E linked chats',
				participant_actor_ids: [agent.id],
				initial_message: 'Opening the thread',
			})
			await new TestAPI(agent.api_key).postConversationMessage(host.id, ws, {
				content: [
					`The plan is in [this chat](/${ws}/chats/${pinned.id}), the retro in [that one](/${ws}/chats/${archived.id}), and [this](/${ws}/chats/${hidden.id}) is not yours.`,
					`[the plan](/${ws}/chats/${pinned.id})`,
				].join('\n\n'),
			})
			await page.goto(`/${ws}/chats/${host.id}`)

			const thread = page.getByTestId('thread-messages')
			// The link alone on its line is a card with the chat's own title and its last message.
			const card = thread.locator('[data-linked-card]', { hasText: 'Launch plan' })
			await expect(card).toBeVisible({ timeout: 10_000 })
			await expect(card).toContainText('Chat')
			await expect(card).toContainText('Pinned')
			await expect(card).toContainText('The pricing page is live and the checkout works')
			await expect(card).toContainText('People')
			await expect(card).not.toContainText(/unread/i)
			await expect(thread.getByText('the plan', { exact: true })).toHaveCount(0)

			// The same chat linked in the sentence is a chip, as it is drawn as a card already.
			const chip = thread.getByRole('link', { name: 'Chat: Launch plan' }).first()
			await expect(chip).toBeVisible()
			// A chat read by id shows as a chip with its title, and one you are not in says so.
			await expect(thread.getByRole('link', { name: 'Chat: Old retro' })).toBeVisible()
			await expect(thread.getByText('Chat not available')).toBeVisible()
			await expect(thread).not.toContainText('Secret plans')

			const box = await card.boundingBox()
			expect(box?.width ?? 0).toBeLessThanOrEqual(460)
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)

			const preview = page.locator('[data-linked-preview]')
			if (vp.width === VIEWPORTS.desktop.width) {
				// A pointer device at 640px or wider: hover opens the same card as a preview.
				await thread.getByRole('link', { name: 'Chat: Old retro' }).hover()
				await expect(preview).toBeVisible()
				await expect(preview).toContainText('Old retro')
				await expect(preview).toContainText('Archived')
				await expect(preview).not.toContainText('Last words')
				await chip.hover()
				await expect(preview).toContainText('Launch plan')
				await expect(preview.getByRole('button', { name: 'Copy link' })).toBeVisible()
				for (const colorScheme of ['light', 'dark'] as const) {
					await page.evaluate(
						(dark) => document.documentElement.classList.toggle('dark', dark),
						colorScheme === 'dark',
					)
					// Colours ease over 180ms; let them settle before the picture.
					await page.waitForTimeout(400)
					await page.screenshot({ path: `test-results/linked-chat-${vp.width}-${colorScheme}.png` })
				}
				await page.mouse.move(5, 5)
				await expect(preview).toHaveCount(0)
			} else {
				await chip.hover()
				await expect(preview).toHaveCount(0)
				await page.screenshot({ path: `test-results/linked-chat-${vp.width}-light.png` })
				await page.evaluate(() => document.documentElement.classList.add('dark'))
				await page.waitForTimeout(400)
				await page.screenshot({ path: `test-results/linked-chat-${vp.width}-dark.png` })
			}
		})
	}
})
