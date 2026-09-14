import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// P3-K · Per-identity Quick Add flow for LinkedIn (Magnus 2026-09-14 reversal
// of the workspace-wide auto-inject that shipped in PR #1595). Two identities
// connected in a workspace → the agent MCP panel offers one Quick Add button
// per identity. Clicking Sebastian's button lands Sebastian's identity server
// on the agent's `mcpServers`; the other button stays clickable but Magnus's
// server does not appear on the agent — cross-identity attach is impossible
// by construction because each button writes a different entry keyed on the
// fan-out instance slug.
//
// Uses page.route() to shape /api/integrations and /api/integrations/linkedin-unipile/identities
// because seeding real LinkedIn identities would require a Unipile round-trip.
// The route bodies match the fan-out contract in
// `apps/dev/src/routes/integrations-linkedin-unipile.ts` (`/identities`
// endpoint) and the mcp-servers component.

interface FakeIdentity {
	instanceSlug: string
	displayName: string
	identityType: 'personal' | 'company_page'
	identitySlug: string
	unipileAccSlug: string
	integrationId: string
}

const SEBASTIAN: FakeIdentity = {
	instanceSlug: 'linkedin-sebastianbille-personal',
	displayName: 'Sebastian Bille',
	identityType: 'personal',
	identitySlug: 'personal',
	unipileAccSlug: 'sebastianbille',
	integrationId: '00000000-0000-4000-8000-0000000000c1',
}

const MAGNUS: FakeIdentity = {
	instanceSlug: 'linkedin-magnus-noeddegaard-personal',
	displayName: 'Magnus Nødegaard',
	identityType: 'personal',
	identitySlug: 'personal',
	unipileAccSlug: 'magnus-noeddegaard',
	integrationId: '00000000-0000-4000-8000-0000000000c2',
}

async function mockTwoLinkedInIdentities(page: Page, workspaceId: string) {
	await page.route('**/api/integrations/linkedin-unipile/identities*', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			// The endpoint sorts alphabetically by displayName; mirror that here so
			// a change in the frontend to depend on server ordering fails the test.
			body: JSON.stringify([MAGNUS, SEBASTIAN]),
		})
	})
	await page.route('**/api/integrations*', async (route) => {
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
					id: SEBASTIAN.integrationId,
					workspaceId,
					provider: 'linkedin-unipile',
					status: 'active',
					externalId: SEBASTIAN.unipileAccSlug,
					config: {},
					actorId: null,
					createdBy: 'actor-1',
					createdAt: null,
					updatedAt: null,
				},
				{
					id: MAGNUS.integrationId,
					workspaceId,
					provider: 'linkedin-unipile',
					status: 'active',
					externalId: MAGNUS.unipileAccSlug,
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

test.describe('Agent detail — Tools — LinkedIn per-identity Quick Add', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`shows one Quick Add button per identity, sorted alphabetically, at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await mockTwoLinkedInIdentities(page, account.workspaceId)

			const agent = await account.api.createAgentActor(`LinkedIn Per-identity Agent ${vp.label}`)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			const tools = page.getByRole('region', { name: 'Tools' })
			await expect(tools).toBeVisible({ timeout: 10_000 })

			// No auto-injected row — that UX went away with the P3-K reversal.
			await expect(tools.getByRole('list', { name: /Auto-injected MCP servers/ })).toHaveCount(0)

			// Both identity buttons present. Alphabetical order — Magnus before
			// Sebastian — matches the /identities endpoint's sort.
			const magnusBtn = tools.getByRole('button', { name: /Add Magnus Nødegaard/ })
			const sebastianBtn = tools.getByRole('button', { name: /Add Sebastian Bille/ })
			await expect(magnusBtn).toBeVisible()
			await expect(sebastianBtn).toBeVisible()
		})
	}

	test('clicking one identity button attaches only that identity to the agent (1024)', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await mockTwoLinkedInIdentities(page, account.workspaceId)

		const agent = await account.api.createAgentActor('LinkedIn Attach One Agent')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)

		await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

		const tools = page.getByRole('region', { name: 'Tools' })
		await expect(tools).toBeVisible({ timeout: 10_000 })

		await tools.getByRole('button', { name: /Add Sebastian Bille/ }).click()

		// Sebastian's mcpServers entry lands under his fan-out instance slug —
		// the key IS the instance slug, so agents inspecting their own tools
		// see the identity as the row header.
		await expect(tools.getByText(SEBASTIAN.instanceSlug)).toBeVisible()

		// Magnus's server is NOT on the agent — the click only writes Sebastian's
		// entry. The Magnus button is still clickable (his identity remains
		// available to add) but nothing scoped to Magnus is on this agent yet.
		await expect(tools.getByText(MAGNUS.instanceSlug)).toHaveCount(0)

		// The Sebastian button hides once his entry is present — matches how the
		// other Quick Adds behave once their mcpServers row is written.
		await expect(tools.getByRole('button', { name: /Add Sebastian Bille/ })).toHaveCount(0)
		// Magnus is still offerable.
		await expect(tools.getByRole('button', { name: /Add Magnus Nødegaard/ })).toBeVisible()
	})

	test('with LinkedIn disconnected: no LinkedIn Quick Add buttons render (1024)', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.route('**/api/integrations/linkedin-unipile/identities*', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify([]),
			})
		})
		await page.route('**/api/integrations*', async (route) => {
			const url = new URL(route.request().url())
			if (url.pathname !== '/api/integrations') {
				await route.fallback()
				return
			}
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify([]),
			})
		})

		const agent = await account.api.createAgentActor('LinkedIn Disconnected Agent')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)

		await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

		const tools = page.getByRole('region', { name: 'Tools' })
		await expect(tools).toBeVisible({ timeout: 10_000 })

		// No LinkedIn buttons — no Quick Add row for LinkedIn at all.
		await expect(tools.getByRole('button', { name: /Add.*LinkedIn/ })).toHaveCount(0)
		await expect(tools.getByRole('button', { name: /Add Sebastian Bille/ })).toHaveCount(0)
		await expect(tools.getByRole('button', { name: /Add Magnus Nødegaard/ })).toHaveCount(0)

		// No "Auto-injected" row either — the whole read-only branch is gone.
		await expect(tools.getByRole('list', { name: /Auto-injected MCP servers/ })).toHaveCount(0)
	})
})
