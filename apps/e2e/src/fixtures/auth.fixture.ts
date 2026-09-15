import { test as base, expect } from '@playwright/test'
import { TestAPI, createTestActor } from '../helpers/api.helper'

/**
 * The Chats v4 polish bet (bet/bdda1c1e-chats-v4-polish) is gated behind the
 * `chats-v4-polish` umbrella and one sub-flag per delta. Nothing sets
 * `FF_TESTER_FEATURES` in CI, so without this override every v4 assertion in
 * the suite would run against the pre-bet rollback surface.
 */
export const CHATS_V4_FLAGS = [
	'chats-v4-polish',
	'chats-v4-polish.list',
	'chats-v4-polish.header',
	'chats-v4-polish.banner',
	'chats-v4-polish.bubbles',
	'chats-v4-polish.new_chat',
] as const

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
				// Turn the Chats v4 polish flags on. The bet shipped that surface
				// unconditionally and these specs assert it (e.g. the header's
				// Mark-as-unread control), so the specs must render what CI's
				// flag-less backend would otherwise gate off. The client's
				// test-only override beats the fetched flag state.
				for (const flag of CHATS_V4_FLAGS) {
					localStorage.setItem(`ff:${flag}`, 'on')
				}
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
