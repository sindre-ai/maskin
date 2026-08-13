import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T1 shell gate — renders the full object-detail shell at each ship-gate
// viewport (375 / 768 / 1024) against a seeded object carrying the fixture
// metadata contract (_ask, _evidence_*, _fold_*): ask banner renders the
// agent's open question, "Answer it ↓" moves focus to the answer control,
// kv rows come from public metadata, the evidence block sits behind its own
// fold, and the document fold expands to its markdown. No horizontal scroll.

const ASK = 'Should we ship this?'
const FOLD_TITLE = 'Research notes'
const FOLD_BODY = 'Details behind the fold.'
const EVIDENCE_QUOTE = 'The numbers support shipping now.'
const EVIDENCE_SOURCE = 'Slack #general'
const EVIDENCE_DATE = '2026-08-01'

test.describe('Object detail shell — document sections', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders ask banner, kv rows, fold, and evidence at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'Shell bet',
				status: 'active',
				content: '## Context\n\nParagraph of context.',
				metadata: {
					priority: 'high',
					_ask: ASK,
					_fold_title: FOLD_TITLE,
					_fold_markdown: FOLD_BODY,
					_evidence_quote: EVIDENCE_QUOTE,
					_evidence_source: EVIDENCE_SOURCE,
					_evidence_date: EVIDENCE_DATE,
				},
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByRole('heading', { level: 1, name: 'Shell bet' })).toBeVisible({
				timeout: 15000,
			})

			// Ask banner renders the agent's open question.
			await expect(page.getByText('Open question')).toBeVisible()
			await expect(page.getByText(ASK)).toBeVisible()

			// "Answer it ↓" moves focus to the answer control.
			await page.getByRole('button', { name: /answer it/i }).click()
			await expect(page.getByPlaceholder(/write a comment/i)).toBeFocused()

			// Body: content, kv rows from public metadata.
			await expect(page.getByText(/Paragraph of context/)).toBeVisible()
			await expect(page.getByText('priority')).toBeVisible()
			await expect(page.getByText('high')).toBeVisible()

			// Document fold: title visible, markdown hidden until opened.
			await expect(page.getByText(FOLD_TITLE)).toBeVisible()
			await expect(page.getByText(FOLD_BODY)).toHaveCount(0)
			await page.getByText(FOLD_TITLE).click()
			await expect(page.getByText(FOLD_BODY)).toBeVisible()

			// Evidence block behind its own fold.
			await expect(page.getByText(EVIDENCE_QUOTE)).toHaveCount(0)
			await page.getByText('Evidence').click()
			await expect(page.getByText(EVIDENCE_QUOTE)).toBeVisible()
			await expect(page.getByText(new RegExp(EVIDENCE_SOURCE))).toBeVisible()
			await expect(page.getByText(new RegExp(EVIDENCE_DATE))).toBeVisible()

			// No horizontal scroll at this ship-gate viewport.
			const scrollWidth = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(scrollWidth).toBeLessThanOrEqual(0)
		})

		test(`hides ask banner when object has no open question at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: 'No ask bet',
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByRole('heading', { level: 1, name: 'No ask bet' })).toBeVisible({
				timeout: 15000,
			})
			await expect(page.getByText('Open question')).toHaveCount(0)
		})
	}
})
