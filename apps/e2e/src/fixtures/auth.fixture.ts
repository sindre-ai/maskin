import { test as base, expect } from '@playwright/test'
import { TestAPI, createTestActor } from '../helpers/api.helper'

interface TestAccount {
	apiKey: string
	actorId: string
	workspaceId: string
	api: TestAPI
}

interface AuthFixtures {
	account: TestAccount
}

export const test = base.extend<AuthFixtures>({
	account: async ({ page }, use, testInfo) => {
		const actor = await createTestActor({
			name: `E2E ${testInfo.title.slice(0, 30)} ${Date.now()}`,
			email: `e2e-${Date.now()}@test.com`,
		})

		const api = new TestAPI(actor.api_key)
		const workspaces = await api.listWorkspaces()
		const workspace = workspaces[0]

		if (!workspace) {
			throw new Error('No workspace found after actor creation')
		}

		// Inject auth into localStorage before any page navigation
		await page.addInitScript(
			(data: {
				apiKey: string
				actor: { id: string; name: string; type: string; email: string | null }
			}) => {
				localStorage.setItem('maskin-api-key', data.apiKey)
				localStorage.setItem('maskin-actor', JSON.stringify(data.actor))
			},
			{
				apiKey: actor.api_key,
				actor: {
					id: actor.id,
					name: actor.name,
					type: actor.type,
					email: actor.email,
				},
			},
		)

		await use({
			apiKey: actor.api_key,
			actorId: actor.id,
			workspaceId: workspace.id,
			api,
		})
	},
})

export { expect }
