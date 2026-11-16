import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// A 1x1 PNG: the card draws any image the browser can decode.
const PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

test.describe('Chat — a draft shows everything that goes out with its text', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`a LinkedIn post shows its three images as a carousel at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const ws = account.workspaceId

			const slides = []
			for (const n of [1, 2, 3]) {
				slides.push(
					await account.api.createFile(ws, {
						name: `slide-${n}.png`,
						mime_type: 'image/png',
						content: PNG,
						encoding: 'base64',
					}),
				)
			}
			// Listed in this order on purpose: slide 3 first. The card follows the list.
			const listed = [slides[2], slides[0], slides[1]]
			const post = await account.api.createObject(ws, {
				type: 'task',
				title: 'Carousel post',
				status: 'todo',
				content: 'Three slides on why oversight is real or cosmetic.',
				metadata: {
					kind: 'linkedin_post',
					account: 'Maskin',
					attachment_file_ids: listed.map((f) => f.id),
				},
			})

			const agent = await account.api.createAgentActor(`Media QA Agent ${Date.now()}`)
			await account.api.addWorkspaceMember(ws, agent.id)
			const conversation = await account.api.createConversation(ws, {
				title: 'E2E preview media',
				participant_actor_ids: [agent.id],
				initial_message: 'Opening the thread',
			})
			await new TestAPI(agent.api_key).postConversationMessage(conversation.id, ws, {
				content: `Here is the [post](/${ws}/objects/${post.id}) for approval.`,
			})
			await page.goto(`/${ws}/chats/${conversation.id}`)

			const thread = page.getByTestId('thread-messages')
			const media = thread.getByRole('region', { name: 'Media, 3 items' })
			await expect(media).toBeVisible({ timeout: 10_000 })
			await expect(media.getByText('1 / 3')).toBeVisible()
			// The first slide is the first file listed, and never a file id.
			await expect(media.getByRole('img', { name: 'slide-3.png' })).toBeVisible()
			await expect(media).not.toContainText(listed[0].id)

			// Controls are plain buttons, reachable on touch.
			await media.getByRole('button', { name: 'Next' }).click()
			await expect(media.getByText('2 / 3')).toBeVisible()
			await expect(media.getByRole('img', { name: 'slide-1.png' })).toBeVisible()
			await media.press('ArrowRight')
			await expect(media.getByText('3 / 3')).toBeVisible()
			await expect(media.getByRole('button', { name: 'Next' })).toBeDisabled()
			await media.press('ArrowLeft')
			await expect(media.getByText('2 / 3')).toBeVisible()

			// The post reads text, then slides, then Approve: media after the text and above the button.
			const text = await thread
				.getByText('Three slides on why oversight is real or cosmetic.')
				.boundingBox()
			const mediaBox = await media.boundingBox()
			const approveBox = await thread.getByRole('button', { name: 'Approve draft' }).boundingBox()
			expect(text && mediaBox && text.y < mediaBox.y).toBe(true)
			expect(mediaBox && approveBox && mediaBox.y < approveBox.y).toBe(true)
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)

			for (const colorScheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme })
				await expect(media).toBeVisible()
				await expect(media.getByRole('button', { name: 'Previous' })).toBeVisible()
			}
		})
	}
})
