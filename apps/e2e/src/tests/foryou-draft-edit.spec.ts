import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * For You — editing a draft where it stands. With the flag on, the draft text on the card is
 * a box. Taking the sending option saves the edit to the draft object, then approves the
 * hash of the saved text, then replies to the agent. A draft that changed under the person is
 * not saved or sent, and the card shows the new text.
 *
 * The feed and the draft object are mocked so the surface is deterministic; the object mock
 * keeps its own text and derives the hash from it, so the spec can check the approved hash
 * is the hash of the edited text.
 */

const DRAFT_ID = '22222222-2222-4222-8222-222222222222'
const ORIGINAL = 'Hi Mette,\n\nThursday at ten works for us.\n\nBest,\nSeb'

const hashOf = (text: string) => `hash:${text.trim()}`

function previewOf(text: string) {
	return {
		kind: 'email',
		label: 'Email',
		provider: 'gmail',
		recipients: [{ role: 'to', name: 'Mette Holm', address: 'mette@northwind.dk' }],
		subject: 'Thursday works',
		body: text,
		maxLength: 100_000,
		missing: [],
		warnings: [],
		content_hash: hashOf(text),
		delivery: { state: 'draft' },
	}
}

function emailItem(workspaceId: string) {
	const createdAt = new Date(Date.now() - 2 * 3_600_000).toISOString()
	return {
		entity_type: 'object' as const,
		entity_id: 'task-edit',
		unread_count: 1,
		mentioning_unread_count: 1,
		max_unread_attention: 3,
		latest_event_id: 91,
		latest_activity_at: createdAt,
		object: {
			id: 'task-edit',
			title: 'Intro email to Northwind',
			type: 'task',
			status: 'in_review',
			content: '',
			workspaceId,
			driver: null,
			metadata: {},
		},
		latest_mention: {
			event_id: 91,
			actor_id: null,
			created_at: createdAt,
			content: 'Send the Northwind email?',
			attention: 3,
			decision: {
				title: 'Send the Northwind email?',
				summary: 'Northwind has not heard from us in 14 days.',
				ask: 'This goes to a customer in your name.',
				options: [
					{ label: 'Hold', consequences: ['Nothing is sent'] },
					{
						label: 'Send it',
						recommended: true,
						destructive: true,
						consequences: ['Goes out now'],
					},
				],
				draft: {
					object_id: DRAFT_ID,
					label: 'Email',
					body: ORIGINAL,
					preview: previewOf(ORIGINAL),
				},
			},
		},
	}
}

/** The draft object as the server holds it: PATCH changes its text, GET returns it with a preview. */
async function mockDraftObject(page: Page, workspaceId: string, state: { content: string }) {
	await page.route(`**/api/objects/${DRAFT_ID}`, async (route) => {
		const method = route.request().method()
		if (method === 'PATCH') state.content = route.request().postDataJSON().content
		else if (method !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				id: DRAFT_ID,
				workspaceId,
				type: 'task',
				title: 'Email to Mette',
				status: 'in_review',
				content: state.content,
				metadata: { kind: 'email' },
				preview: previewOf(state.content),
			}),
		})
	})
}

async function mockFeed(page: Page, item: ReturnType<typeof emailItem>) {
	await page.route('**/api/for-you*', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				items: [
					{
						notification_id: '00000000-0000-4000-8000-000000000003',
						rank: 1,
						headline: item.latest_mention.content,
						rationale: null,
						created_at: item.latest_activity_at,
						entity_type: item.entity_type,
						entity_id: item.entity_id,
						session_id: null,
						object: item.object,
						latest_mention: item.latest_mention,
					},
				],
			}),
		})
	})
}

async function mockReply(page: Page, calls: string[]) {
	await page.route('**/api/events', async (route) => {
		if (route.request().method() !== 'POST') return route.fallback()
		calls.push('reply')
		await route.fulfill({ status: 201, contentType: 'application/json', body: '{"id":99}' })
	})
}

test.describe('For You — editing a draft on the card', () => {
	test.beforeEach(async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem('ff:foryou-draft-edit', 'on'))
	})

	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`edit, send: saves the edit and approves its hash @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const state = { content: ORIGINAL }
			await mockDraftObject(page, account.workspaceId, state)
			await mockFeed(page, emailItem(account.workspaceId))
			const calls: string[] = []
			await mockReply(page, calls)
			let approved: { content_hash?: string } | null = null
			await page.route(`**/api/objects/${DRAFT_ID}/approval`, async (route) => {
				calls.push('approval')
				approved = route.request().postDataJSON()
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ approval_id: 6, preview: previewOf(state.content) }),
				})
			})
			await page.goto(`/${account.workspaceId}`)

			const card = page.getByTestId('foryou-feed-card')
			const box = card.getByRole('textbox', { name: 'Edit the text' })
			await expect(box).toHaveValue(ORIGINAL)
			const edited = 'Hi Mette,\n\nThursday at eleven works for us.\n\nBest,\nSeb'
			await box.fill(edited)
			await card.getByRole('button', { name: 'Send it' }).click()

			await expect(page.getByTestId('decision-receipt')).toBeVisible()
			// Saved first, then approved by the hash of exactly the edited text, then the agent is told.
			expect(state.content).toBe(edited)
			expect(approved).toEqual({ content_hash: hashOf(edited) })
			expect(calls).toEqual(['approval', 'reply'])
		})
	}

	test('a draft that changed under the person is not saved or sent', async ({ page, account }) => {
		const state = { content: ORIGINAL }
		await mockDraftObject(page, account.workspaceId, state)
		await mockFeed(page, emailItem(account.workspaceId))
		const calls: string[] = []
		await mockReply(page, calls)
		await page.route(`**/api/objects/${DRAFT_ID}/approval`, async (route) => {
			calls.push('approval')
			await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
		})
		await page.goto(`/${account.workspaceId}`)

		const card = page.getByTestId('foryou-feed-card')
		const box = card.getByRole('textbox', { name: 'Edit the text' })
		await expect(box).toHaveValue(ORIGINAL)
		// The agent rewrites the draft while the person is typing.
		const theirs = 'Hi Mette, can we do Friday instead?'
		state.content = theirs
		await box.fill(`${ORIGINAL}\n\nPS: bring the contract.`)
		await card.getByRole('button', { name: 'Send it' }).click()

		await expect(card.getByText(/changed while you were editing it/)).toBeVisible()
		await expect(box).toHaveValue(theirs)
		expect(state.content).toBe(theirs)
		expect(calls).toEqual([])
	})

	test('with the flag off the text stays read only', async ({ page, account }) => {
		await page.addInitScript(() => localStorage.setItem('ff:foryou-draft-edit', 'off'))
		await mockFeed(page, emailItem(account.workspaceId))
		await page.goto(`/${account.workspaceId}`)

		const card = page.getByTestId('foryou-feed-card')
		await expect(card.getByText(/Thursday at ten works for us/)).toBeVisible()
		await expect(card.getByRole('textbox', { name: 'Edit the text' })).toHaveCount(0)
	})
})
