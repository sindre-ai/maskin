import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Agent access on Settings → Integrations.
 *
 * The agents are real (created through the API, so the picker lists what the workspace
 * has). The integration list and the three grant calls are stubbed with a small stateful
 * server: a real connection needs a provider's consent screen. What a grant does to
 * Postgres, to a launch and to a tool call is covered against the real stack in
 * apps/dev/src/__tests__/integration/{agent-grants,agent-access-launch,integrations-gateway}.test.ts;
 * this spec owns the surface and the interaction.
 */

const INTEGRATION_ID = '55555555-5555-4555-8555-555555555555'

interface State {
	defaultAgentAccess: 'read' | 'none'
	agentGrants: Array<{ actorId: string; access: 'none' | 'read' | 'read_write' }>
}

async function stubIntegrations(page: Page, workspaceId: string, actorId: string, state: State) {
	await page.route('**/api/integrations/providers*', (route) =>
		route.fulfill({
			json: [{ name: 'linear', displayName: 'Linear', authType: 'oauth2', events: [] }],
		}),
	)
	await page.route('**/api/integrations/**', async (route) => {
		const req = route.request()
		const url = new URL(req.url())
		const grant = url.pathname.match(/\/grants\/([0-9a-f-]+)$/)
		if (grant && req.method() === 'PUT') {
			const { access } = req.postDataJSON() as { access: State['agentGrants'][number]['access'] }
			state.agentGrants = [
				...state.agentGrants.filter((g) => g.actorId !== grant[1]),
				{ actorId: grant[1], access },
			]
			return route.fulfill({ json: { actorId: grant[1], access } })
		}
		if (grant && req.method() === 'DELETE') {
			state.agentGrants = state.agentGrants.filter((g) => g.actorId !== grant[1])
			return route.fulfill({ json: { actorId: grant[1] } })
		}
		if (url.pathname.endsWith('/default-access') && req.method() === 'PUT') {
			const body = req.postDataJSON() as { defaultAgentAccess: State['defaultAgentAccess'] }
			state.defaultAgentAccess = body.defaultAgentAccess
			return route.fulfill({ json: body })
		}
		return route.fallback()
	})
	await page.route('**/api/integrations', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		return route.fulfill({
			json: [
				{
					id: INTEGRATION_ID,
					workspaceId,
					provider: 'linear',
					status: 'active',
					externalId: 'org-1',
					config: {},
					actorId: null,
					// The signed-in test account connected it, so it may edit access.
					createdBy: actorId,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					...state,
				},
			],
		})
	})
}

for (const vp of SHIP_GATE_VIEWPORTS) {
	test(`change who can use an integration, and how @ ${vp.label}`, async ({ page, account }) => {
		await page.setViewportSize({ width: vp.width, height: vp.height })
		const reviewer = await account.api.createAgentActor('Code Reviewer', account.workspaceId)
		await account.api.createAgentActor('Writer', account.workspaceId)
		const state: State = { defaultAgentAccess: 'read', agentGrants: [] }
		await stubIntegrations(page, account.workspaceId, account.actorId, state)

		await page.goto(`/${account.workspaceId}/settings/integrations`)
		const toggle = page.getByRole('button', { name: /Agent access/ })
		await expect(toggle).toBeVisible({ timeout: 15_000 })
		// Collapsed: one line, no list.
		await expect(toggle).toContainText('All agents can read')
		await expect(page.getByText('All other agents')).toHaveCount(0)

		await toggle.click()
		await expect(page.getByText('All other agents')).toBeVisible()
		// Nothing is listed until an agent differs from the default.
		await expect(page.getByRole('combobox', { name: /^Access for (?!all other)/ })).toHaveCount(0)

		// Give one agent write access: it appears, and the summary says so.
		await page.getByRole('combobox', { name: 'Add an agent' }).click()
		await page.getByRole('option', { name: 'Code Reviewer' }).click()
		await expect(page.getByRole('combobox', { name: 'Access for Code Reviewer' })).toContainText(
			'Read & write',
		)
		await expect(toggle).toContainText('All agents can read · 1 can also write')
		expect(state.agentGrants).toEqual([{ actorId: reviewer.id, access: 'read_write' }])

		// The agent that already has an entry is not offered again.
		await page.getByRole('combobox', { name: 'Add an agent' }).click()
		await expect(page.getByRole('option', { name: 'Writer' })).toBeVisible()
		await expect(page.getByRole('option', { name: 'Code Reviewer' })).toHaveCount(0)
		await page.keyboard.press('Escape')

		// Narrow that agent to read-only.
		await page.getByRole('combobox', { name: 'Access for Code Reviewer' }).click()
		await page.getByRole('option', { name: 'Read', exact: true }).click()
		await expect(toggle).toContainText('All agents can read')
		await expect(toggle).not.toContainText('can also write')

		// Take read access away from everyone else.
		await page.getByRole('combobox', { name: 'Access for all other agents' }).click()
		await page.getByRole('option', { name: 'No access' }).click()
		await expect(toggle).toContainText('1 agent has access')
		expect(state.defaultAgentAccess).toBe('none')

		// Remove the override and it is gone from the list.
		await page.getByRole('button', { name: 'Remove Code Reviewer' }).click()
		await expect(page.getByRole('combobox', { name: 'Access for Code Reviewer' })).toHaveCount(0)
		await expect(toggle).toContainText('No agents have access')

		// Nothing spills out sideways, and the controls are reachable on touch.
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth > window.innerWidth,
		)
		expect(overflow).toBe(false)
		await expect(page.getByRole('combobox', { name: 'Add an agent' })).toBeVisible()
	})
}

test('the access section reads in light and dark', async ({ page, account }) => {
	await account.api.createAgentActor('Code Reviewer', account.workspaceId)
	const state: State = { defaultAgentAccess: 'read', agentGrants: [] }
	await stubIntegrations(page, account.workspaceId, account.actorId, state)
	await page.goto(`/${account.workspaceId}/settings/integrations`)
	await page.getByRole('button', { name: /Agent access/ }).click()

	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme })
		await expect(page.getByText('All other agents')).toBeVisible()
		await expect(page.getByRole('combobox', { name: 'Access for all other agents' })).toBeVisible()
		await expect(page.getByRole('combobox', { name: 'Add an agent' })).toBeVisible()
	}
})
