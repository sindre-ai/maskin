import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Settings → Integrations → Gmail → Review drafts.
 *
 * Gmail's connected state and its draft endpoints are stubbed at the transport: a
 * real connect needs Google consent and a real send would put mail in a live
 * mailbox. The send route itself is covered against Postgres in
 * apps/dev/src/__tests__/integration/integrations-gmail-send.test.ts; this spec
 * owns the dialog, the two-click confirm and what a person sees when the draft
 * changed under them.
 */

const GMAIL = {
	name: 'gmail',
	displayName: 'Gmail',
	authType: 'oauth2',
	externalIdDisplay: 'email',
	events: [],
}

const DRAFT = {
	draft_id: 'draft-1',
	message_id: 'msg-1',
	thread_id: null,
	to: 'ada@example.com',
	cc: '',
	subject: 'Intro from Maskin',
	snippet: 'Hi Ada, a quick note about',
}

function connectedGmail(workspaceId: string) {
	return {
		id: '33333333-3333-3333-3333-333333333333',
		workspaceId,
		provider: 'gmail',
		status: 'active',
		externalId: 'sender@example.com',
		config: {},
		actorId: null,
		createdBy: '44444444-4444-4444-4444-444444444444',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	}
}

async function stubGmail(page: Page, workspaceId: string, drafts = [DRAFT]) {
	await page.route('**/api/integrations/providers', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([GMAIL]) }),
	)
	await page.route(/\/api\/integrations(\?.*)?$/, (route) => {
		if (route.request().method() !== 'GET') return route.continue()
		return route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify([connectedGmail(workspaceId)]),
		})
	})
	await page.route('**/api/integrations/gmail/drafts', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ drafts }),
		}),
	)
}

async function openDrafts(page: Page, workspaceId: string) {
	await page.goto(`/${workspaceId}/settings/integrations`)
	await page.getByRole('button', { name: 'Review drafts' }).click()
	return page.getByRole('dialog')
}

test.describe('Gmail — review and send drafts', () => {
	test('sending takes two clicks and sends the version that was shown', async ({
		page,
		account,
	}) => {
		await stubGmail(page, account.workspaceId)
		const sent: Array<Record<string, unknown> | null> = []
		await page.route('**/api/integrations/gmail/drafts/draft-1/send', async (route) => {
			sent.push(route.request().postDataJSON())
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ message_id: 'sent-1', thread_id: null }),
			})
		})

		const dialog = await openDrafts(page, account.workspaceId)
		await expect(dialog.getByText('Intro from Maskin')).toBeVisible()
		await expect(dialog.getByText('To ada@example.com')).toBeVisible()

		await dialog.getByRole('button', { name: 'Send', exact: true }).click()
		// First click only asks. Nothing has been sent yet.
		expect(sent).toHaveLength(0)
		await expect(dialog.getByText(/Send this to ada@example.com/)).toBeVisible()

		await dialog.getByRole('button', { name: 'Send email' }).click()
		await expect.poll(() => sent.length).toBe(1)
		expect(sent[0]).toEqual({ message_id: 'msg-1' })
	})

	test('cancelling the confirm sends nothing', async ({ page, account }) => {
		await stubGmail(page, account.workspaceId)
		let sends = 0
		await page.route('**/api/integrations/gmail/drafts/draft-1/send', async (route) => {
			sends += 1
			await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
		})

		const dialog = await openDrafts(page, account.workspaceId)
		await dialog.getByRole('button', { name: 'Send', exact: true }).click()
		await dialog.getByRole('button', { name: 'Cancel' }).click()

		await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
		expect(sends).toBe(0)
	})

	test('a draft edited since it was shown is refused and says why', async ({ page, account }) => {
		await stubGmail(page, account.workspaceId)
		await page.route('**/api/integrations/gmail/drafts/draft-1/send', (route) =>
			route.fulfill({
				status: 409,
				contentType: 'application/json',
				body: JSON.stringify({
					error: {
						code: 'CONFLICT',
						message: 'The draft was edited after you opened it. Review it again before sending.',
					},
				}),
			}),
		)

		const dialog = await openDrafts(page, account.workspaceId)
		await dialog.getByRole('button', { name: 'Send', exact: true }).click()
		await dialog.getByRole('button', { name: 'Send email' }).click()

		await expect(dialog.getByText(/edited after you opened it/)).toBeVisible()
	})

	test('shows an empty state when there are no drafts', async ({ page, account }) => {
		await stubGmail(page, account.workspaceId, [])

		const dialog = await openDrafts(page, account.workspaceId)

		await expect(dialog.getByText('No drafts')).toBeVisible()
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`the drafts dialog and its Send controls are reachable at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await stubGmail(page, account.workspaceId)
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const dialog = await openDrafts(page, account.workspaceId)
			const send = dialog.getByRole('button', { name: 'Send', exact: true })
			await expect(send).toBeVisible()
			await send.click()
			await expect(dialog.getByRole('button', { name: 'Send email' })).toBeVisible()
			await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeVisible()

			// The dialog, a sheet on mobile, must not push the page sideways.
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflow).toBeLessThanOrEqual(0)
		})
	}

	for (const scheme of ['light', 'dark'] as const) {
		test(`the Send control is visible in ${scheme} mode`, async ({ page, account }) => {
			await page.emulateMedia({ colorScheme: scheme })
			await stubGmail(page, account.workspaceId)

			const dialog = await openDrafts(page, account.workspaceId)

			await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeVisible()
		})
	}
})
