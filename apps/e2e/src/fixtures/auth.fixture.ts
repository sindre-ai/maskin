import { test as base, expect } from '@playwright/test'
import { TestAPI, createTestActor } from '../helpers/api.helper'

interface TestAccount {
	apiKey: string
	actorId: string
	workspaceId: string
	workspaceName: string
	api: TestAPI
}

interface AuthFixtures {
	account: TestAccount
}

export const test = base.extend<AuthFixtures>({
	account: async ({ page }, use) => {
		// Deliberately NOT derived from the test title. The workspace is named
		// after the actor ("<name>'s Workspace") and that name is rendered in the
		// sidebar workspace-switcher pill's aria-label, so a title-derived name
		// leaks the test's own words into the DOM — any spec whose title contains
		// a string it also locates by (e.g. "Hide plans", "Buy usage credits")
		// then fails with a Playwright strict-mode violation.
		const unique = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
		const actor = await createTestActor({
			name: `E2E Actor ${unique}`,
			email: `e2e-${unique}@test.com`,
		})

		const api = new TestAPI(actor.api_key)
		const workspaces = await api.listWorkspaces()
		const workspace = workspaces[0]

		if (!workspace) {
			throw new Error('No workspace found after actor creation')
		}

		// Inject auth into localStorage before any page navigation.
		await page.addInitScript(
			(data: {
				apiKey: string
				actor: { id: string; name: string; type: string; email: string | null }
				workspaceId: string
			}) => {
				localStorage.setItem('maskin-api-key', data.apiKey)
				localStorage.setItem('maskin-actor', JSON.stringify(data.actor))
				localStorage.setItem(`north_star_answered_${data.workspaceId}`, '1')
			},
			{
				apiKey: actor.api_key,
				actor: {
					id: actor.id,
					name: actor.name,
					type: actor.type,
					email: actor.email,
				},
				workspaceId: workspace.id,
			},
		)

		await use({
			apiKey: actor.api_key,
			actorId: actor.id,
			workspaceId: workspace.id,
			workspaceName: workspace.name,
			api,
		})
	},
})

export { expect }
