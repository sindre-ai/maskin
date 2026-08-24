import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The pre-v2 Loops and Triggers surfaces — `components/loops/legacy/` and
// `components/triggers/legacy/` — rendered when the `new-design` flag is off,
// which is what every actor outside FF_TESTER_ACTOR_IDS gets. The v2 specs
// (loops-page, loop-detail, loop-builder, trigger-detail) all run with the flag
// on; this one keeps the flag's off branch executable until the flag (and the
// legacy tree with it) is deleted.
//
// The auth fixture seeds `ff:new-design = 'on'` for every spec, so each test
// here sets 'off' explicitly through the same test-only override.

async function setFlagOff(page: Page) {
	await page.addInitScript(() => {
		localStorage.setItem('ff:new-design', 'off')
	})
}

for (const viewport of SHIP_GATE_VIEWPORTS) {
	test(`${viewport.label}: the legacy Loops list renders its rows`, async ({ page, account }) => {
		await setFlagOff(page)
		await page.setViewportSize({ width: viewport.width, height: viewport.height })

		await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Customer feedback',
			status: 'learning',
			content: 'Every customer who gives feedback hears back within 30 days',
		})

		await page.goto(`/${account.workspaceId}/loops`)

		await expect(page.getByText('Customer feedback')).toBeVisible({ timeout: 10000 })
		// The pre-v2 list's own copy — the v2 list does not render this line.
		await expect(
			page.getByText('Persistent multi-agent pipelines running in this workspace.'),
		).toBeVisible()
	})

	test(`${viewport.label}: /triggers still renders the legacy Triggers index`, async ({
		page,
		account,
	}) => {
		await setFlagOff(page)
		await page.setViewportSize({ width: viewport.width, height: viewport.height })

		const agent = await account.api.createAgentActor('Relay')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		await account.api.createTrigger(account.workspaceId, {
			name: 'Nightly sweep',
			type: 'cron',
			action_prompt: 'Sweep the backlog',
			target_actor_id: agent.id,
			config: { expression: '0 3 * * *' },
		})

		await page.goto(`/${account.workspaceId}/triggers`)

		// With the flag off there is no fold-in: the route must NOT redirect.
		await expect(page.getByText('Nightly sweep')).toBeVisible({ timeout: 10000 })
		await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/triggers$`))
	})
}

test('the v2-only loop builder redirects to the Loops index with the flag off', async ({
	page,
	account,
}) => {
	await setFlagOff(page)

	await page.goto(`/${account.workspaceId}/loops/new`)

	await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/loops$`), { timeout: 10000 })
})
