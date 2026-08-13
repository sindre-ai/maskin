import { expect, test } from '../fixtures/auth.fixture'
import { installChatMocks } from '../helpers/chat.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The first example sentence on the "Start a loop" page. It drafts a feedback
// loop whose default name is "<Object type> loop".
const EXAMPLE_CHIP = /Notify me weekly with a summary of new customer feedback/i

test.describe('Loop builder — language-only create flow', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`empty → draft → adjust → create → done at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			// Mock the chat API slice so the mounted Composer does not reach the
			// session backend or create any session — the create-flow must never
			// write anything until "Create loop" is pressed.
			const chat = await installChatMocks(page, {
				workspaceId: account.workspaceId,
				humanActorId: account.actorId,
				humanActorName: account.actorId,
			})

			const loopsBefore = (await account.api.listObjects(account.workspaceId)).filter(
				(o) => o.type === 'loop',
			)

			await page.goto(`/${account.workspaceId}/loops/new`)

			// AC-2 / empty state: nothing is drafted until a description is given.
			await expect(page.getByText('No loop drafted yet')).toBeVisible({ timeout: 10000 })

			// Layout gate: single-column stacked below md, two-pane side-by-side at md+.
			// The design spec puts the split at md: (≥768px) — regressing to lg: would
			// leave iPad portrait users stacked, which is what this assertion catches.
			const describeBox = await page
				.getByRole('region', { name: /describe your loop/i })
				.boundingBox()
			const proposedBox = await page.getByRole('region', { name: /proposed loop/i }).boundingBox()
			if (!describeBox || !proposedBox) throw new Error('layout regions missing bounding boxes')
			if (viewport.width >= 768) {
				expect(proposedBox.x).toBeGreaterThan(describeBox.x + describeBox.width / 2)
			} else {
				expect(proposedBox.y).toBeGreaterThanOrEqual(describeBox.y + describeBox.height - 1)
			}

			// Tap an example chip → the proposed loop card appears, not yet created.
			await page.getByRole('button', { name: EXAMPLE_CHIP }).click()
			const planCard = page.getByText('PROPOSED LOOP')
			await expect(planCard).toBeVisible({ timeout: 10000 })
			await expect(page.getByText('not created yet')).toBeVisible()

			// Adjust switches the card to editable fields.
			await page.getByRole('button', { name: /adjust/i }).click()
			await expect(page.getByRole('textbox', { name: /object type name/i })).toBeVisible()

			// Save returns to the read-only proposed view.
			await page.getByRole('button', { name: /^save$/i }).click()
			await expect(page.getByRole('button', { name: /^save$/i })).toBeHidden()
			await expect(page.getByText('PROPOSED LOOP')).toBeVisible()

			// No loop object exists before Create.
			expect(chat.sessionsCreated).toBe(0)
			const loopsDuring = (await account.api.listObjects(account.workspaceId)).filter(
				(o) => o.type === 'loop',
			)
			expect(loopsDuring.length).toBe(loopsBefore.length)

			// Create loop → the card flips to "created" and a real loop object is
			// persisted matching the preview name.
			await page.getByRole('button', { name: /create loop/i }).click()
			await expect(page.getByText('Loop created')).toBeVisible({ timeout: 10000 })
			await expect(page.getByText('created')).toBeVisible()

			const loopsAfter = (await account.api.listObjects(account.workspaceId)).filter(
				(o) => o.type === 'loop',
			)
			expect(loopsAfter.length).toBe(loopsBefore.length + 1)
			expect(loopsAfter[loopsAfter.length - 1].title).toMatch(/ loop$/)

			// Done clears back to a fresh draft.
			await page.getByRole('button', { name: /^done$/i }).click()
			await expect(page.getByText('No loop drafted yet')).toBeVisible()
		})
	}
})
