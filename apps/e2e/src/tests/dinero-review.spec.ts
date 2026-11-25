import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Settings → Dinero review: the log of what the flow did in Dinero, a reversal of a booked item,
// and Approve the books. The flag and the review answers are route-mocked: a test account has no
// Dinero connection, and the flag is on only for named testers. The routes themselves (who may call
// them, the counter-posting, the approval record and the lock) run against real Postgres in
// apps/dev/src/__tests__/integration/dinero-review.test.ts.

const item = (over: Record<string, unknown>) => ({
	event_id: 1,
	at: '2026-11-10T09:00:00.000Z',
	tool: 'CreateFinanceVoucher',
	outcome: 'success',
	booked: true,
	voucher_date: '2026-11-10',
	lines: [
		{
			description: 'Group entry',
			amount: 4000,
			account: 1000,
			counter_account: 55000,
			vat_code: null,
		},
	],
	receipt: null,
	result: 'Voucher 1 booked',
	reverses_event_id: null,
	reversed_by_event_id: null,
	can_reverse: true,
	cannot_reverse_because: null,
	...over,
})

const vatLine = {
	vat_code: 'I25',
	direction: 'input',
	rate: 0.25,
	lines: 2,
	amount_incl_vat: 1250,
	vat_amount: 250,
	net_amount: 1000,
	entries: [
		{
			event_id: 1,
			voucher_date: '2026-11-10',
			description: 'Ler, 12 sække',
			account: 2000,
			amount_incl_vat: 1000,
			vat_amount: 200,
			net_amount: 800,
			receipt: { file_name: 'bilag-2.pdf', file_guid: null, reference: 'Bilag 2' },
		},
		{
			event_id: 2,
			voucher_date: '2026-11-11',
			description: 'Glasur',
			account: 2000,
			amount_incl_vat: 250,
			vat_amount: 50,
			net_amount: 200,
			receipt: null,
		},
	],
}

const vatReport = (over: Record<string, unknown> = {}) => ({
	from: '2026-10-24',
	to: '2026-11-23',
	lines: [vatLine],
	totals: { input_vat: 250, output_vat: 0, complete: true, uncalculated_lines: 0 },
	figures_hash: 'a'.repeat(64),
	notice: 'A draft for checking, not the VAT return. Nothing has been filed.',
	...over,
})

const log = (over: Record<string, unknown> = {}) => ({
	from: '2026-10-24',
	to: '2026-11-23',
	items: [item({})],
	figures_hash: 'a'.repeat(64),
	approval: null,
	truncated: false,
	...over,
})

async function mock(
	page: Page,
	state: { log: ReturnType<typeof log>; vat?: ReturnType<typeof vatReport> },
) {
	await page.route('**/api/feature-flags', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ flags: { 'dinero-review-screen': true } }),
		}),
	)
	await page.route('**/api/dinero-review/vat-report?**', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(state.vat ?? vatReport()),
		}),
	)
	await page.route('**/api/dinero-review?**', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(state.log),
		}),
	)
}

test.describe('Settings — Dinero review', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`shows the log, and Reverse and Approve are reachable at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await mock(page, { log: log() })
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/settings/dinero-review`)
			await page.waitForLoadState('load')

			await expect(page.getByRole('heading', { name: 'Dinero review' })).toBeVisible()
			await expect(page.getByText('Booked a finance voucher')).toBeVisible()
			await expect(page.getByRole('button', { name: 'Reverse', exact: true })).toBeVisible()
			await expect(page.getByRole('button', { name: 'Approve the books' })).toBeVisible()
		})
	}

	test('reversing asks first, then sends the item to Dinero', async ({ page, account }) => {
		await mock(page, { log: log() })
		let body: unknown = null
		await page.route('**/api/dinero-review/reverse', async (route) => {
			body = route.request().postDataJSON()
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ outcome: 'success', message: 'ok', reversal_event_id: 2 }),
			})
		})
		await page.goto(`/${account.workspaceId}/settings/dinero-review`)
		await page.getByRole('button', { name: 'Reverse', exact: true }).click()
		await expect(page.getByText('A booked voucher cannot be deleted in Dinero.')).toBeVisible()
		await page.getByRole('button', { name: 'Reverse in Dinero' }).click()
		await expect.poll(() => body).toEqual({ event_id: 1 })
	})

	test('approving sends the hash of the figures that were shown', async ({ page, account }) => {
		await mock(page, { log: log() })
		let body: unknown = null
		await page.route('**/api/dinero-review/approve', async (route) => {
			body = route.request().postDataJSON()
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(log()),
			})
		})
		await page.goto(`/${account.workspaceId}/settings/dinero-review`)
		await page.getByRole('button', { name: 'Approve the books' }).first().click()
		await page.getByRole('dialog').getByRole('button', { name: 'Approve the books' }).click()
		await expect
			.poll(() => body)
			.toEqual({ from: '2026-10-24', to: '2026-11-23', figures_hash: 'a'.repeat(64) })
	})

	test('an approved period is closed: no Reverse, Approve is off', async ({ page, account }) => {
		await mock(page, {
			log: log({
				approval: {
					approved_by: '00000000-0000-4000-8000-000000000001',
					approved_at: '2026-11-23T10:00:00.000Z',
					figures_hash: 'a'.repeat(64),
				},
			}),
		})
		await page.goto(`/${account.workspaceId}/settings/dinero-review`)
		await expect(page.getByRole('status')).toContainText('The period is closed')
		await expect(page.getByRole('button', { name: 'Reverse', exact: true })).toHaveCount(0)
		await expect(page.getByRole('button', { name: 'Approve the books' })).toBeDisabled()
	})

	test('before approval there is no filing hand-off, and it says why', async ({
		page,
		account,
	}) => {
		await mock(page, { log: log() })
		await page.goto(`/${account.workspaceId}/settings/dinero-review`)
		await expect(
			page.getByText('The filing hand-off is available after you approve the books.'),
		).toBeVisible()
		await expect(page.getByRole('button', { name: 'Get the filing hand-off' })).toHaveCount(0)
	})

	test('after approval the hand-off shows figures and steps, and never says filed', async ({
		page,
		account,
	}) => {
		await mock(page, {
			log: log({
				approval: {
					approved_by: '00000000-0000-4000-8000-000000000001',
					approved_at: '2026-11-23T10:00:00.000Z',
					figures_hash: 'a'.repeat(64),
				},
			}),
		})
		let body: unknown = null
		await page.route('**/api/dinero-review/filing-handoff', async (route) => {
			body = route.request().postDataJSON()
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					from: '2026-10-24',
					to: '2026-11-23',
					approved_by: '00000000-0000-4000-8000-000000000001',
					approved_at: '2026-11-23T10:00:00.000Z',
					figures_hash: 'a'.repeat(64),
					figures: [vatLine],
					figures_note: 'These are not the VAT return.',
					steps: ['Open Dinero and go to its own VAT filing.'],
					year_end_steps: ['Only if the company is an ApS: open the year-end.'],
					notice: 'Nothing has been filed. You file in Dinero with your own MitID.',
				}),
			})
		})
		await page.goto(`/${account.workspaceId}/settings/dinero-review`)
		await page.getByRole('button', { name: 'Get the filing hand-off' }).click()
		await expect(page.getByRole('region', { name: 'Filing hand-off' })).toContainText(
			'VAT I25: 1.250,00 incl. VAT, VAT 250,00, 2 lines',
		)
		await expect(page.getByText('Open Dinero and go to its own VAT filing.')).toBeVisible()
		await expect(page.getByText('Nothing has been filed.')).toBeVisible()
		expect(body).toEqual({ from: '2026-10-24', to: '2026-11-23' })
	})

	test('the VAT report shows totals per code and the receipt behind every line', async ({
		page,
		account,
	}) => {
		await mock(page, { log: log() })
		await page.goto(`/${account.workspaceId}/settings/dinero-review`)
		await expect(page.getByRole('heading', { name: 'VAT report (draft)' })).toBeVisible()
		const row = page.getByTestId('vat-code-I25')
		await expect(row).toContainText('1.250,00')
		await expect(row).toContainText('250,00')
		await page.getByText('Show the 2 lines and their receipts').click()
		await expect(page.getByTestId('vat-line-1')).toContainText('Receipt: bilag-2.pdf')
		await expect(page.getByTestId('vat-line-2')).toContainText('Receipt: not in the log')
		await expect(page.getByTestId('vat-line-1').getByRole('link')).toHaveAttribute(
			'href',
			'#dinero-item-1',
		)
		await expect(page.getByText('Numina import: Not yet.')).toBeVisible()
	})

	test('the spreadsheet download asks the server for the same period', async ({
		page,
		account,
	}) => {
		await mock(page, { log: log() })
		let url = ''
		await page.route('**/api/dinero-review/vat-report/csv?**', async (route) => {
			url = route.request().url()
			await route.fulfill({
				status: 200,
				contentType: 'text/csv',
				body: 'Row;VAT code\r\n',
			})
		})
		await page.goto(`/${account.workspaceId}/settings/dinero-review`)
		const download = page.waitForEvent('download')
		await page.getByRole('button', { name: 'Download spreadsheet' }).click()
		expect((await download).suggestedFilename()).toBe('vat-report-draft-2026-10-24-2026-11-23.csv')
		expect(url).toContain('from=2026-10-24&to=2026-11-23')
	})

	test('an empty period says so', async ({ page, account }) => {
		await mock(page, { log: log({ items: [] }) })
		await page.goto(`/${account.workspaceId}/settings/dinero-review`)
		await expect(
			page.getByText('The flow has not done anything in Dinero in this period.'),
		).toBeVisible()
	})
})
