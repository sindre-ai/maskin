import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The agent MCP config UI has to reflect the runtime behaviour of the
// linkedin-unipile MCP server: session-manager attaches it to every session
// in a workspace where the integration is active (autoInject), so a hand-added
// row on the same agent would connect the same endpoint twice and fan every
// tool out under two prefixes. Test spec covers:
//   1. the read-only "Auto-injected" row appears when the integration is active
//   2. no "Add linkedin-unipile" Quick Add button appears
//   3. a hand-pasted duplicate is flagged (not silently kept)
//
// Uses page.route() to shape /api/integrations and /api/integrations/providers
// because seeding a real linkedin-unipile row would require a Unipile OAuth
// round-trip. The routes and their response shape are pinned in
// apps/dev/src/routes/integrations.ts.

const LINKEDIN_UNIPILE_URL = '${MASKIN_API_URL}/api/integrations/linkedin-unipile/mcp'

async function mockActiveLinkedInIntegration(page: Page, workspaceId: string) {
	await page.route('**/api/integrations/providers', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify([
				{
					name: 'linkedin-unipile',
					displayName: 'LinkedIn',
					authType: 'oauth2_custom',
					events: [],
					mcp: {
						envKey: 'LINKEDIN_UNIPILE_TOKEN',
						autoInject: true,
						server: {
							type: 'http',
							url: LINKEDIN_UNIPILE_URL,
							headers: {
								Authorization: 'Bearer ${MASKIN_API_KEY}',
								'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
							},
						},
					},
				},
			]),
		})
	})
	await page.route('**/api/integrations*', async (route) => {
		// Only shape the workspace-scoped list route — leave everything else alone.
		const url = new URL(route.request().url())
		if (url.pathname !== '/api/integrations') {
			await route.fallback()
			return
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify([
				{
					id: '00000000-0000-4000-8000-0000000000c1',
					workspaceId,
					provider: 'linkedin-unipile',
					status: 'active',
					externalId: 'unipile-account-abc',
					config: {},
					actorId: null,
					createdBy: 'actor-1',
					createdAt: null,
					updatedAt: null,
				},
			]),
		})
	})
}

test.describe('Agent detail — Tools — auto-injected linkedin-unipile', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`shows the auto-injected row, no Quick Add, at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await mockActiveLinkedInIntegration(page, account.workspaceId)

			const agent = await account.api.createAgentActor('LinkedIn Auto-inject Agent')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			const tools = page.getByRole('region', { name: 'Tools' })
			await expect(tools).toBeVisible({ timeout: 10_000 })

			// The list is aria-labelled so tests don't depend on visual chrome.
			const autoInjectedList = tools.getByRole('list', { name: /Auto-injected MCP servers/ })
			await expect(autoInjectedList).toBeVisible()
			await expect(autoInjectedList.getByText('LinkedIn')).toBeVisible()
			await expect(
				autoInjectedList.getByText(/Attached to every session in this workspace/),
			).toBeVisible()

			// Non-negotiable per the task spec: no Add linkedin-unipile Quick Add.
			await expect(tools.getByRole('button', { name: /Add linkedin-unipile/ })).toHaveCount(0)
			await expect(tools.getByRole('button', { name: /Add LinkedIn/ })).toHaveCount(0)
		})
	}

	test('flags a hand-pasted duplicate of the auto-injected server URL', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await mockActiveLinkedInIntegration(page, account.workspaceId)

		const agent = await account.api.createAgentActor('LinkedIn Dup Agent')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		await account.api.updateActor(agent.id, {
			tools: {
				mcpServers: {
					'linkedin-unipile': {
						type: 'http',
						url: LINKEDIN_UNIPILE_URL,
						headers: {},
					},
				},
			},
		})

		await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

		const tools = page.getByRole('region', { name: 'Tools' })
		await expect(tools).toBeVisible({ timeout: 10_000 })

		// The auto-injected row still renders.
		await expect(tools.getByRole('list', { name: /Auto-injected MCP servers/ })).toBeVisible()

		// The hand-pasted server row is not deleted — the hint appears alongside it.
		await expect(tools.getByText(/Already auto-injected/)).toBeVisible()
		await expect(tools.getByText('linkedin-unipile')).toBeVisible()
	})
})
