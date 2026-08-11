import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T1 gate — verifies the object-detail static shell's body content at each
// ship-gate viewport (375 / 768 / 1024): the ask banner renders the agent's
// open question and "Answer it" moves focus to the answer control; the body
// renders markdown (heading, paragraph, list), key/value metadata rows, a
// collapsible document fold, and an evidence block (quote, source, date)
// behind its own fold; and the page never scrolls horizontally.

const SHELL_TITLE = 'T1 shell body fixtures'

test.describe('Object detail — ask banner + body', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders ask banner, body fixtures and folds at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: SHELL_TITLE,
				status: 'active',
				content: '# Heading\n\nSome body paragraph text.\n\n- item one\n- item two',
				metadata: {
					segment: 'enterprise',
					_ask_title: 'Which option wins?',
					_ask_sub: 'A or B?',
					_fold_title: 'Notes',
					_fold_markdown: '## Fold heading',
					_evidence_quote: 'The claim is backed',
					_evidence_source: 'PR #123',
					_evidence_date: '2026-08-01',
				},
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			const title = page.getByRole('heading', { level: 1, name: SHELL_TITLE })
			await expect(title).toBeVisible({ timeout: 15000 })

			// Body: markdown content renders as structured elements, and the
			// key/value row surfaces non-`_` metadata.
			await expect(page.getByRole('heading', { name: 'Heading' })).toBeVisible()
			await expect(page.getByText('Some body paragraph text.')).toBeVisible()
			await expect(page.getByText('item one')).toBeVisible()
			await expect(page.getByText('item two')).toBeVisible()
			await expect(page.getByText('segment:')).toBeVisible()
			await expect(page.getByText('enterprise')).toBeVisible()

			// Ask banner: the agent's open question renders above the composer,
			// and "Answer it" moves focus to the answer control.
			await expect(page.getByText('Which option wins?')).toBeVisible()
			await expect(page.getByText('A or B?')).toBeVisible()
			const answer = page.getByRole('button', { name: /answer it/i })
			await answer.click()
			await expect(page.getByPlaceholder(/write a comment/i)).toBeFocused()

			// Document fold: hidden behind the trigger, revealed on click.
			await expect(page.getByRole('heading', { name: 'Fold heading' })).toHaveCount(0)
			await page.getByRole('button', { name: /notes/i }).click()
			await expect(page.getByRole('heading', { name: 'Fold heading' })).toBeVisible()

			// Evidence block: quote, source and date behind its own fold.
			await expect(page.getByText('The claim is backed')).toHaveCount(0)
			await page.getByRole('button', { name: /evidence/i }).click()
			await expect(page.getByText('“The claim is backed”')).toBeVisible()
			await expect(page.getByText('PR #123')).toBeVisible()
			await expect(page.getByText('2026-08-01')).toBeVisible()

			// No horizontal page scroll at any ship-gate viewport.
			const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
			expect(scrollWidth).toBeLessThanOrEqual(vp.width)
		})
	}
})
