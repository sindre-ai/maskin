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

		// Inject auth into localStorage before any page navigation. Also mark the
		// per-workspace North Star prompt as answered — the For You landing route
		// renders `NorthStarPromptCard` above the queue whenever the workspace has
		// no bets and this key is unset, and every e2e workspace is freshly
		// created with no bets. Left showing, the extra card destabilises specs
		// that drive the queue (see `apps/web/src/routes/_authed/$workspaceId/index.tsx`
		// `showNorthStarPrompt`). Specs that specifically want to exercise the
		// prompt can clear the key in their own `addInitScript`.
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
