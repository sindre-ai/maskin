import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Preview cards for every kind of thing an agent hands a person: a LinkedIn message or post
 * (an object with a `metadata.kind`), and files (an HTML page, a markdown document, a
 * picture). In chat, a message that links to one draws it; on For You, a card about one
 * shows it above the buttons. Real API for the objects and files; the For You list is mocked
 * so the card is deterministic, as in foryou-email-preview.
 */

// A 1x1 transparent PNG.
const PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const HTML_PAGE =
	'<!doctype html><html><body><h1 id="page-heading">Launch page heading</h1><p>Rendered by the sandbox.</p></body></html>'
const MARKDOWN = '# Rollout plan\n\n- ship the card\n- watch the feed\n'

async function assertNoHorizontalOverflow(page: Page, label: string) {
	await page.waitForTimeout(200)
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
	}))
	expect(scrollWidth, `${label}: page overflows horizontally`).toBeLessThanOrEqual(innerWidth + 1)
}

async function chatWithAgentMessage(
	account: { api: TestAPI; workspaceId: string },
	content: (workspaceId: string) => string,
) {
	// Posted by a second agent actor: only the non-own branch of MessageBubble renders previews.
	const agent = await account.api.createAgentActor(`Preview Cards QA ${Date.now()}`)
	await account.api.addWorkspaceMember(account.workspaceId, agent.id)
	const conversation = await account.api.createConversation(account.workspaceId, {
		title: 'E2E preview cards',
		participant_actor_ids: [agent.id],
		initial_message: 'Opening the thread',
	})
	await new TestAPI(agent.api_key).postConversationMessage(conversation.id, account.workspaceId, {
		content: content(account.workspaceId),
	})
	return conversation
}

test.describe('Chat — drafts a message links to', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`a LinkedIn message shows where it goes and is approved from the card @ ${vp.label}`, async ({
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
			const conversation = await chatWithAgentMessage(
				account,
				(ws) => `Here is the [draft](/${ws}/objects/${draft.id}).`,
			)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const thread = page.getByTestId('thread-messages')
			await expect(thread).toBeVisible({ timeout: 10_000 })

			// The chip says what it is, not "task".
			await expect(thread.getByText('LinkedIn message', { exact: true })).toBeVisible({
				timeout: 10_000,
			})
			await expect(thread.getByText('Merethe Aas', { exact: true }).first()).toBeVisible()
			await expect(thread.getByText(/Hvad arbejder I med/)).toBeVisible()

			await thread.getByRole('button', { name: 'Approve' }).click()
			await expect(thread.getByText('Approved, waiting for send', { exact: true })).toBeVisible()
			await expect(thread.getByRole('button', { name: 'Approve' })).toHaveCount(0)

			for (const colorScheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme })
				await expect(thread.getByText('Approved, waiting for send', { exact: true })).toBeVisible()
			}
			await assertNoHorizontalOverflow(page, vp.label)
		})

		test(`a link that stands alone is replaced by its card, in the message @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const draft = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'DM to Torben Hertel',
				status: 'todo',
				content: 'Hej Torben, har du set vores oplaeg?',
				metadata: { kind: 'linkedin_message', to: 'Torben Hertel' },
			})
			const conversation = await chatWithAgentMessage(
				account,
				(ws) =>
					`Ready for you.\n\nDraft: [Message to Torben](/${ws}/objects/${draft.id})\n\nTell me if it needs changes.`,
			)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const thread = page.getByTestId('thread-messages')
			await expect(thread.getByText('DM to Torben Hertel')).toBeVisible({ timeout: 10_000 })

			// The text link is gone: the card took its place, between the two paragraphs.
			await expect(thread.getByRole('link', { name: 'Message to Torben' })).toHaveCount(0)
			await expect(thread.getByText('Draft:', { exact: false })).toHaveCount(0)
			const order = await thread.evaluate((el) => {
				const text = (node: Element) => node.textContent ?? ''
				const parts = Array.from(el.querySelectorAll('p, [aria-expanded]'))
				const at = (needle: string) => parts.findIndex((node) => text(node).includes(needle))
				return [at('Ready for you.'), at('DM to Torben Hertel'), at('Tell me if it needs changes.')]
			})
			expect(order[0]).toBeGreaterThanOrEqual(0)
			expect(order[1]).toBeGreaterThan(order[0])
			expect(order[2]).toBeGreaterThan(order[1])
			// Drawn once: the card is not repeated under the message.
			await expect(thread.getByText('DM to Torben Hertel')).toHaveCount(1)
			await assertNoHorizontalOverflow(page, vp.label)
		})

		test(`a LinkedIn post shows only the post and where it is published @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const post = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'Post: the handoff problem',
				status: 'todo',
				content:
					'Account: sebk_personal\nVoice: sebastian-voice\n\n--- POST ---\nMost agent demos fail on the handoff.\n\n--- MEDIA ---\nnone',
				metadata: { content_type: 'linkedin_post', scheduled_date: '2026-10-27' },
			})
			const conversation = await chatWithAgentMessage(
				account,
				(ws) => `The [post](/${ws}/objects/${post.id}) is ready.`,
			)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const thread = page.getByTestId('thread-messages')
			await expect(thread.getByText('LinkedIn post', { exact: true })).toBeVisible({
				timeout: 10_000,
			})
			await expect(thread.getByText('Most agent demos fail on the handoff.')).toBeVisible()
			// Exact: the card's property line under the title also reads "Scheduled date: …".
			await expect(thread.getByText('Scheduled', { exact: true })).toBeVisible()
			await expect(thread.getByText('2026-10-27', { exact: true })).toBeVisible()
			// The header above the copy is not what goes out, so it is not on the card.
			await expect(thread.getByText('Voice: sebastian-voice')).toHaveCount(0)
			await expect(thread.getByText('--- POST ---')).toHaveCount(0)
			await assertNoHorizontalOverflow(page, vp.label)
		})
	}
})

test.describe('Chat — files a message links to', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`an HTML page, a markdown document and a picture draw as themselves @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const html = await account.api.createFile(account.workspaceId, {
				name: 'launch-page.html',
				mime_type: 'text/html',
				content: HTML_PAGE,
				encoding: 'utf8',
			})
			const markdown = await account.api.createFile(account.workspaceId, {
				name: 'rollout-plan.md',
				mime_type: 'text/markdown',
				content: MARKDOWN,
				encoding: 'utf8',
			})
			const image = await account.api.createFile(account.workspaceId, {
				name: 'hero.png',
				mime_type: 'image/png',
				content: PNG_BASE64,
				encoding: 'base64',
			})
			const conversation = await chatWithAgentMessage(
				account,
				(ws) =>
					`The [page](/${ws}/files/${html.id}), the [plan](/${ws}/files/${markdown.id}) and the [image](/${ws}/files/${image.id}).`,
			)

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const thread = page.getByTestId('thread-messages')
			await expect(thread).toBeVisible({ timeout: 10_000 })

			// The picture is the preview, so it is open without a click.
			await expect(thread.getByRole('img', { name: 'hero.png' })).toBeVisible({ timeout: 10_000 })

			// The page and the document are folded until the header is clicked.
			await expect(thread.getByText(/^HTML( page)?$/).filter({ visible: true })).toBeVisible()
			await expect(thread.getByText('Markdown', { exact: true })).toBeVisible()
			await expect(thread.getByTitle('Preview of launch-page.html')).toHaveCount(0)

			await thread.getByRole('button', { name: /Expand preview of launch-page.html/ }).click()
			const frame = page.frameLocator('iframe[title="Preview of launch-page.html"]')
			await expect(frame.locator('#page-heading')).toHaveText('Launch page heading', {
				timeout: 10_000,
			})
			// The page runs in a sandbox that cannot reach the app.
			await expect(page.locator('iframe[title="Preview of launch-page.html"]')).toHaveAttribute(
				'sandbox',
				'allow-scripts',
			)

			await thread.getByRole('button', { name: /Expand preview of rollout-plan.md/ }).click()
			await expect(thread.getByRole('heading', { name: 'Rollout plan' })).toBeVisible()
			await expect(thread.getByText('ship the card')).toBeVisible()

			for (const colorScheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme })
				await expect(thread.getByRole('heading', { name: 'Rollout plan' })).toBeVisible()
			}
			await assertNoHorizontalOverflow(page, vp.label)
		})
	}
})

test.describe('For You — a card about a file', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`shows the page itself above the buttons @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const html = await account.api.createFile(account.workspaceId, {
				name: 'launch-page.html',
				mime_type: 'text/html',
				content: HTML_PAGE,
				encoding: 'utf8',
			})
			const createdAt = new Date(Date.now() - 3_600_000).toISOString()
			const decision = {
				title: 'Ship the launch page?',
				summary: 'The page has 3 sections and passed the review. I changed nothing since.',
				ask: 'This goes live on the public site, so I will not publish it alone.',
				options: [
					{ label: 'Hold', consequences: ['Nothing is published', 'The page waits'] },
					{
						label: 'Publish it',
						recommended: true,
						consequences: ['Goes live now', 'Can be unpublished'],
					},
				],
				draft: {
					file_id: html.id,
					label: 'Launch page',
					file: {
						id: html.id,
						name: html.name,
						mime_type: 'text/html',
						size_bytes: html.sizeBytes,
					},
				},
			}
			await page.route('**/api/for-you*', async (route) => {
				if (route.request().method() !== 'GET') return route.fallback()
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						items: [
							{
								notification_id: '00000000-0000-4000-8000-000000000002',
								rank: 1,
								headline: decision.title,
								rationale: null,
								created_at: createdAt,
								entity_type: 'object',
								entity_id: 'task-page',
								session_id: null,
								object: {
									id: 'task-page',
									title: 'Launch page',
									type: 'task',
									status: 'in_review',
									content: '',
									workspaceId: account.workspaceId,
									driver: null,
									metadata: {},
								},
								latest_mention: {
									event_id: 88,
									actor_id: null,
									created_at: createdAt,
									content: decision.title,
									attention: 3,
									decision,
								},
							},
						],
					}),
				})
			})

			await page.goto(`/${account.workspaceId}`)
			const card = page.getByTestId('foryou-feed-card')
			await expect(card).toBeVisible()

			// Open straight away: the reader decides on what the page looks like.
			const frame = card.frameLocator('iframe[title="Preview of launch-page.html"]')
			await expect(frame.locator('#page-heading')).toHaveText('Launch page heading', {
				timeout: 10_000,
			})
			await expect(card.getByRole('button', { name: 'Publish it' })).toBeVisible()
			for (const colorScheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme })
				await expect(card.getByText('launch-page.html')).toBeVisible()
			}
			await assertNoHorizontalOverflow(page, vp.label)
		})
	}
})
