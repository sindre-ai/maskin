import { expect, test } from '../fixtures/auth.fixture'
import { sendFromComposer } from '../helpers/composer.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The first example sentence on the "Start a loop" page. It drafts a feedback
// loop whose default name is "<Object type> loop".
const EXAMPLE_CHIP = /Notify me weekly with a summary of new customer feedback/i

test.describe('Loop builder — language-only create flow', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`empty → draft → create → done at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			// The mounted Composer never reaches the backend on this surface — its
			// `onSend` only re-parses the sentence locally. The create-flow must
			// write nothing at all until "Create loop" is pressed.
			const loopsBefore = (await account.api.listObjects(account.workspaceId)).filter(
				(o) => o.type === 'loop',
			)

			await page.goto(`/${account.workspaceId}/loops/new`)

			// AC-2 / empty state: nothing is drafted until a description is given.
			// v2 empty state carries copy that begins "The flow appears here…".
			await expect(page.getByText(/The flow appears here/i)).toBeVisible({ timeout: 10000 })

			// Layout gate: single-column stacked below md, two-pane side-by-side at md+.
			// The design spec puts the split at md: (≥768px) — regressing to lg: would
			// leave iPad portrait users stacked, which is what this assertion catches.
			const describeBox = await page
				.getByRole('region', { name: /describe your flow/i })
				.boundingBox()
			const proposedBox = await page.getByRole('region', { name: /proposed flow/i }).boundingBox()
			if (!describeBox || !proposedBox) throw new Error('layout regions missing bounding boxes')
			if (viewport.width >= 768) {
				expect(proposedBox.x).toBeGreaterThan(describeBox.x + describeBox.width / 2)
			} else {
				expect(proposedBox.y).toBeGreaterThanOrEqual(describeBox.y + describeBox.height - 1)
			}

			// Tap an example chip → the proposed loop card appears, not yet created.
			await page.getByRole('button', { name: EXAMPLE_CHIP }).click()
			const planCard = page.getByText('PROPOSED FLOW')
			await expect(planCard).toBeVisible({ timeout: 10000 })
			await expect(page.getByText('not created yet')).toBeVisible()

			// Language is the only way in — the card offers no builder path: no
			// Adjust, no form fields, and a footer of Start over + Create loop only.
			await expect(page.getByRole('button', { name: /adjust/i })).toBeHidden()
			await expect(page.getByRole('button', { name: /^save$/i })).toBeHidden()
			await expect(
				page.getByRole('region', { name: /proposed flow/i }).getByRole('textbox'),
			).toHaveCount(0)
			await expect(page.getByRole('button', { name: /^start over$/i })).toBeVisible()
			await expect(page.getByRole('button', { name: /create flow/i })).toBeVisible()

			// No loop object exists before Create.
			const loopsDuring = (await account.api.listObjects(account.workspaceId)).filter(
				(o) => o.type === 'loop',
			)
			expect(loopsDuring.length).toBe(loopsBefore.length)

			// Create loop → the card flips to "created" and a real loop object is
			// persisted matching the preview name.
			await page.getByRole('button', { name: /create flow/i }).click()
			// The card carries both an eyebrow and a heading — locate the heading
			// by role, or the two collide under strict mode.
			await expect(page.getByRole('heading', { name: 'Flow created' })).toBeVisible({
				timeout: 10000,
			})
			await expect(page.getByText('FLOW CREATED', { exact: true })).toBeVisible()

			const loopsAfter = (await account.api.listObjects(account.workspaceId)).filter(
				(o) => o.type === 'loop',
			)
			expect(loopsAfter.length).toBe(loopsBefore.length + 1)
			// Pick the new loop by id: the list is newest-first, so the last entry is
			// the oldest seeded loop, not the one just created.
			const knownIds = new Set(loopsBefore.map((o) => o.id))
			const createdLoop = loopsAfter.find((o) => !knownIds.has(o.id))
			expect(createdLoop?.title).toMatch(/ loop$/)

			// Start over clears back to a fresh draft.
			await page.getByRole('button', { name: /^start over$/i }).click()
			await expect(page.getByText(/The flow appears here/i)).toBeVisible()
		})

		test(`an under-specified sentence asks for the missing half at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			await page.goto(`/${account.workspaceId}/loops/new`)
			await expect(page.getByText(/The flow appears here/i)).toBeVisible({ timeout: 10000 })

			const composer = page.getByRole('textbox', { name: /describe your flow/i })
			await composer.fill('track customer feedback')
			await sendFromComposer(page, composer, viewport.width)

			// No source it listens to and no end it reports to — nothing to draw.
			await expect(
				page.getByText(/Nothing to draw yet\. A flow needs a source it listens to/),
			).toBeVisible({ timeout: 10000 })
			await expect(page.getByText('PROPOSED FLOW')).toBeHidden()

			// Tapping a fill-in chip extends the sentence and drafts the plan.
			await page.getByRole('button', { name: '…when it comes in' }).click()
			await expect(page.getByText('PROPOSED FLOW')).toBeVisible({ timeout: 10000 })
			await expect(page.getByText('not created yet')).toBeVisible()
		})
	}
})
