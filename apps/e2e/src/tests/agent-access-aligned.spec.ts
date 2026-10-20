import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Access reads the same on the Integrations page and the agent page, in both directions.
 *
 * The agents are real. The integration list, the agent's access view and the grant calls are
 * served by one small stateful stub, because a real connection needs a provider's consent
 * screen. That stub computes the access view from the same state the list is built from, the
 * way the server does. What the server really does to Postgres, launches and tool calls is
 * covered by apps/dev/src/__tests__/integration/access-alignment.test.ts; this spec owns what
 * a person sees moving between the two pages.
 */

const LINEAR_ID = '55555555-5555-4555-8555-555555555555'

type Level = 'none' | 'read' | 'read_write'
interface State {
	defaultAgentAccess: 'read' | 'none'
	grants: Array<{ actorId: string; access: Level }>
}

async function stub(page: Page, workspaceId: string, creator: string, state: State) {
	const now = new Date().toISOString()
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
			const { access } = req.postDataJSON() as { access: Level }
			state.grants = [
				...state.grants.filter((g) => g.actorId !== grant[1]),
				{ actorId: grant[1], access },
			]
			return route.fulfill({ json: { actorId: grant[1], access } })
		}
		if (grant && req.method() === 'DELETE') {
			state.grants = state.grants.filter((g) => g.actorId !== grant[1])
			return route.fulfill({ json: { actorId: grant[1] } })
		}
		return route.fallback()
	})
	await page.route('**/api/integrations', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		return route.fulfill({
			json: [
				{
					id: LINEAR_ID,
					workspaceId,
					provider: 'linear',
					status: 'active',
					externalId: 'org-1',
					config: {},
					actorId: null,
					createdBy: creator,
					createdAt: now,
					updatedAt: now,
					defaultAgentAccess: state.defaultAgentAccess,
					agentGrants: state.grants,
				},
			],
		})
	})
	await page.route('**/api/actors/*/access', async (route) => {
		const actorId =
			route
				.request()
				.url()
				.match(/actors\/([0-9a-f-]+)\/access/)?.[1] ?? ''
		const own = state.grants.find((g) => g.actorId === actorId)
		const access = own?.access ?? state.defaultAgentAccess
		return route.fulfill({
			json: {
				maskin_mcp: { name: 'Maskin', access: 'read_write', locked: true },
				integrations: [
					{
						integration_id: LINEAR_ID,
						provider: 'linear',
						name: 'Linear',
						access,
						source: own ? 'grant' : 'default',
						default_access: state.defaultAgentAccess,
						server_attached: access !== 'none',
						created_by: creator,
						kind: 'integration',
					},
				],
				credentials: [],
			},
		})
	})
}

for (const vp of SHIP_GATE_VIEWPORTS) {
	test(`a change on one page shows on the other @ ${vp.label}`, async ({ page, account }) => {
		await page.setViewportSize({ width: vp.width, height: vp.height })
		const reviewer = await account.api.createAgentActor('Code Reviewer', account.workspaceId)
		const state: State = { defaultAgentAccess: 'read', grants: [] }
		await stub(page, account.workspaceId, account.actorId, state)

		// Integrations page: give the agent write access.
		await page.goto(`/${account.workspaceId}/settings/integrations`)
		const toggle = page.getByRole('button', { name: /Agent access/ })
		await expect(toggle).toContainText('All agents can read', { timeout: 15_000 })
		await toggle.click()
		await page.getByRole('combobox', { name: 'Add an agent' }).click()
		await page.getByRole('option', { name: 'Code Reviewer' }).click()
		await expect(toggle).toContainText('1 can also write')

		// Agent page: the same level, with tools attached.
		await page.goto(`/${account.workspaceId}/agents/${reviewer.id}`)
		const access = page.getByRole('combobox', { name: 'Access to Linear' })
		await expect(access).toContainText('Read & write', { timeout: 15_000 })

		// Change it there; the Integrations page follows.
		await access.click()
		await page.getByRole('option', { name: 'Read', exact: true }).click()
		await expect(access).toContainText('Read')
		expect(state.grants).toEqual([{ actorId: reviewer.id, access: 'read' }])

		await page.goto(`/${account.workspaceId}/settings/integrations`)
		const again = page.getByRole('button', { name: /Agent access/ })
		await expect(again).toContainText('All agents can read', { timeout: 15_000 })
		await expect(again).not.toContainText('can also write')

		// Back to the default from the agent page.
		await page.goto(`/${account.workspaceId}/agents/${reviewer.id}`)
		await page.getByRole('combobox', { name: 'Access to Linear' }).click()
		await page.getByRole('option', { name: 'Default (Read)' }).click()
		await expect.poll(() => state.grants.length).toBe(0)

		// Take just this agent off the integration while everyone else keeps reading it.
		await page.getByRole('combobox', { name: 'Access to Linear' }).click()
		await page.getByRole('option', { name: 'No access' }).click()
		await expect(page.getByRole('combobox', { name: 'Access to Linear' })).toContainText(
			'No access',
		)
		expect(state.grants).toEqual([{ actorId: reviewer.id, access: 'none' }])

		await page.goto(`/${account.workspaceId}/settings/integrations`)
		await expect(page.getByRole('button', { name: /Agent access/ })).toContainText(
			'All agents can read · 1 has no access',
			{ timeout: 15_000 },
		)

		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth > window.innerWidth,
		)
		expect(overflow).toBe(false)
	})
}
