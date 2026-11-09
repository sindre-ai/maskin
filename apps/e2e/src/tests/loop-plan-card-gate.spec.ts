import { expect, test } from '../fixtures/auth.fixture'
import { sendFromComposer } from '../helpers/composer.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// A plan whose trigger listens to Slack cannot be created until Slack is
// connected or the operator skips it. A fresh test workspace has no
// integrations, so the gate is closed on arrival.
const SLACK_SENTENCE =
	'When a slack message arrives in the ops channel, have a triage agent review it and ask me before it replies.'

test.describe('Flow plan card — Create gate', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`Create stays blocked until the missing connection is skipped at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/loops/new`)
			const composer = page.getByRole('textbox', { name: /describe your flow/i })
			await composer.fill(SLACK_SENTENCE)
			await sendFromComposer(page, composer, viewport.width)

			await expect(page.getByText('PROPOSED FLOW')).toBeVisible({ timeout: 10000 })
			const create = page.getByRole('button', { name: /create flow/i })
			await expect(page.getByText('NEEDS THESE CONNECTED')).toBeVisible()
			await expect(create).toBeDisabled()

			// The skip control is a touch target on phones and tablets.
			const skip = page.getByRole('button', { name: /skip for now/i })
			await expect(skip).toBeVisible()
			if (viewport.width < 768) {
				const box = await skip.boundingBox()
				expect(box?.height ?? 0).toBeGreaterThanOrEqual(44)
			}

			await skip.click()
			await expect(create).toBeEnabled()
			await create.click()
			await expect(page.getByRole('heading', { name: 'Flow created' })).toBeVisible({
				timeout: 10000,
			})
			await expect(page.getByText(/^Next:/)).toBeVisible()
		})
	}
})
