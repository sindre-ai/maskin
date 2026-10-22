import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * For You — an email draft card. The draft is an ordinary object with `metadata.kind =
 * "email"`; the feed hands the card its `preview` (who it goes to, the subject, the exact
 * text). Choosing the option that sends first records the person's approval of the text
 * they saw, then replies to the agent.
 *
 * The curated list is mocked so the surface is deterministic, as in foryou-feed-v4.
 */

const DRAFT_ID = '11111111-1111-4111-8111-111111111111'
const HASH = 'hash-of-the-text-on-the-card'

function emailItem(workspaceId: string, opts: { missing?: string[] } = {}) {
	const missing = opts.missing ?? []
	const preview = {
		kind: 'email',
		label: 'Email',
		provider: 'gmail',
		recipients: missing.includes('To')
			? []
			: [
					{ role: 'to', name: 'Mette Holm', address: 'mette@northwind.dk' },
					{ role: 'cc', name: null, address: 'dan@northwind.dk' },
				],
		subject: 'Thursday works',
		body: 'Hi Mette,\n\nThursday at ten works for us. I will bring the contract.\n\nBest,\nSeb',
		maxLength: 100_000,
		missing,
		warnings: [],
		content_hash: HASH,
		delivery: { state: 'draft' },
	}
	const createdAt = new Date(Date.now() - 2 * 3_600_000).toISOString()
	return {
		entity_type: 'object' as const,
		entity_id: 'task-email',
		unread_count: 1,
		mentioning_unread_count: 1,
		max_unread_attention: 3,
		latest_event_id: 77,
		latest_activity_at: createdAt,
		object: {
			id: 'task-email',
			title: 'Intro email to Northwind',
			type: 'task',
			status: 'in_review',
			content: 'The durable spec, which the card must not show.',
			workspaceId,
			driver: null,
			metadata: {},
		},
		latest_mention: {
			event_id: 77,
			actor_id: null,
			created_at: createdAt,
			content: 'Send the Northwind email?',
			attention: 3,
			decision: {
				title: 'Send the Northwind email?',
				summary: 'Northwind has not heard from us in 14 days. I drafted the reply.',
				ask: 'This goes to a customer in your name, so I will not send it alone.',
				options: [
					{ label: 'Hold', consequences: ['Nothing is sent', 'Northwind keeps waiting'] },
					{
						label: 'Send it',
						recommended: true,
						destructive: true,
						consequences: ['Goes out now', 'Cannot be recalled'],
					},
				],
				draft: { object_id: DRAFT_ID, label: 'Email', body: preview.body, preview },
			},
		},
	}
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
						notification_id: '00000000-0000-4000-8000-000000000001',
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

async function assertNoHorizontalOverflow(page: Page, label: string) {
	await page.waitForTimeout(200)
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
	}))
	expect(scrollWidth, `${label}: page overflows horizontally`).toBeLessThanOrEqual(innerWidth + 1)
}

test.describe('For You — an email draft card', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`shows who, the subject and the exact text @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await mockFeed(page, emailItem(account.workspaceId))
			await page.goto(`/${account.workspaceId}`)

			const card = page.getByTestId('foryou-feed-card')
			await expect(card).toBeVisible()
			const draft = card.getByRole('region', { name: 'Email' })
			await expect(draft.getByText('Mette Holm <mette@northwind.dk>')).toBeVisible()
			await expect(draft.getByText('dan@northwind.dk')).toBeVisible()
			await expect(draft.getByText('Thursday works')).toBeVisible()
			await expect(draft.getByText(/Thursday at ten works for us/)).toBeVisible()
			// The whole message, down to the sign-off, with nothing folded behind "Read all".
			await expect(draft.getByText(/Best,\s+Seb/)).toBeVisible()
			await expect(card.getByRole('button', { name: 'Read all' })).toHaveCount(0)
			// The object's durable spec never reaches the card.
			await expect(card.getByText('The durable spec, which the card must not show.')).toHaveCount(0)
			await assertNoHorizontalOverflow(page, vp.label)
		})
	}

	test('sending records the approval of the text shown, then replies', async ({
		page,
		account,
	}) => {
		await mockFeed(page, emailItem(account.workspaceId))
		const calls: string[] = []
		let approvalBody: unknown = null
		await page.route(`**/api/objects/${DRAFT_ID}/approval`, async (route) => {
			calls.push('approval')
			approvalBody = route.request().postDataJSON()
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ approval_id: 5, preview: {} }),
			})
		})
		let reply: { content?: string } | null = null
		await page.route('**/api/events', async (route) => {
			if (route.request().method() !== 'POST') return route.fallback()
			calls.push('reply')
			reply = route.request().postDataJSON()
			await route.fulfill({
				status: 201,
				contentType: 'application/json',
				body: JSON.stringify({ id: 99, action: 'commented' }),
			})
		})
		await page.goto(`/${account.workspaceId}`)

		await page.getByTestId('foryou-feed-card').getByRole('button', { name: 'Send it' }).click()

		await expect(page.getByTestId('decision-receipt')).toBeVisible()
		await expect.poll(() => reply?.content).toBe('Send it')
		// The approval is bound to the text the person saw, and lands before the agent is told.
		expect(approvalBody).toEqual({ content_hash: HASH })
		expect(calls).toEqual(['approval', 'reply'])
	})

	test('a draft that changed under the reader is not sent', async ({ page, account }) => {
		await mockFeed(page, emailItem(account.workspaceId))
		await page.route(`**/api/objects/${DRAFT_ID}/approval`, async (route) => {
			await route.fulfill({
				status: 409,
				contentType: 'application/json',
				body: JSON.stringify({ error: { code: 'CONFLICT', message: 'The draft changed.' } }),
			})
		})
		let replied = false
		await page.route('**/api/events', async (route) => {
			if (route.request().method() !== 'POST') return route.fallback()
			replied = true
			await route.fulfill({ status: 201, contentType: 'application/json', body: '{}' })
		})
		await page.goto(`/${account.workspaceId}`)

		await page.getByTestId('foryou-feed-card').getByRole('button', { name: 'Send it' }).click()

		await expect(page.getByText("Couldn't send your reply — try again.")).toBeVisible()
		expect(replied).toBe(false)
	})

	for (const scheme of ['light', 'dark'] as const) {
		test(`names what is missing before it can go (${scheme})`, async ({ page, account }) => {
			await page.emulateMedia({ colorScheme: scheme })
			await mockFeed(page, emailItem(account.workspaceId, { missing: ['To'] }))
			await page.goto(`/${account.workspaceId}`)

			await expect(page.getByRole('alert').filter({ hasText: 'Missing: To' })).toBeVisible()
		})
	}
})
