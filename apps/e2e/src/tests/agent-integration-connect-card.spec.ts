import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * E2E for the Connect card an agent puts in chat via `connect_integration`.
 *
 * The card message is injected at the transport rather than seeded through the
 * API on purpose: `metadata.integration_connect` is backend-owned and
 * `stripServerOwnedMetadata` removes it from anything a client posts, so a
 * client-seeded card is exactly the thing that must NOT be renderable. The real
 * write path is covered against Postgres in
 * apps/dev/src/__tests__/integration/session-connect-card.test.ts, and the
 * return-to-chat redirect in google-meet-oauth-callback.test.ts; this spec owns
 * the rendering and the interaction.
 *
 * The provider list, integration list and connect call are stubbed too: a real
 * connect would redirect the browser to the provider's consent screen.
 */

const SESSION_ID = '11111111-1111-1111-1111-111111111111'

const PROVIDERS = [
	{
		name: 'linear',
		displayName: 'Linear',
		authType: 'oauth2',
		events: Array.from({ length: 9 }, (_, i) => ({
			entityType: `entity_${i}`,
			actions: ['created'],
			label: `Event ${i}`,
		})),
	},
	{ name: 'posthog', displayName: 'PostHog', authType: 'api_key', events: [] },
]

function activeIntegration(workspaceId: string, provider: string) {
	return {
		id: '33333333-3333-3333-3333-333333333333',
		workspaceId,
		provider,
		status: 'active',
		externalId: `${provider}-ext`,
		config: {},
		actorId: null,
		createdBy: '44444444-4444-4444-4444-444444444444',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	}
}

function cardMessage(conversationId: string, provider: string, name: string) {
	return {
		id: 9101,
		conversationId,
		actorId: 'agent-1',
		actorName: 'Chief of Staff',
		actorType: 'agent' as const,
		kind: 'message' as const,
		content: `Connect **${name}** to continue — use the Connect card below, or go to Settings → Integrations.`,
		metadata: { integration_connect: { session_id: SESSION_ID, provider } },
		sessionId: SESSION_ID,
		createdAt: new Date().toISOString(),
		editedAt: null,
	}
}

async function stubThread(
	page: Page,
	conversationId: string,
	provider: string,
	name: string,
	connected: Array<Record<string, unknown>> = [],
) {
	await page.route('**/api/conversations/*/messages*', async (route) => {
		if (route.request().method() !== 'GET') return route.continue()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				messages: [cardMessage(conversationId, provider, name)],
				has_more: false,
			}),
		})
	})
	await page.route('**/api/integrations/providers', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(PROVIDERS),
		}),
	)
	await page.route(/\/api\/integrations(\?.*)?$/, (route) => {
		if (route.request().method() !== 'GET') return route.continue()
		return route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(connected),
		})
	})
}

test.describe('Agent integration connect card', () => {
	test('an OAuth provider connects with the chat as the return path', async ({ page, account }) => {
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: `Connect oauth ${Date.now()}`,
			participant_actor_ids: [],
			initial_message: 'Triage my Linear backlog',
		})
		await stubThread(page, conversation.id, 'linear', 'Linear')

		const bodies: Array<Record<string, unknown> | null> = []
		await page.route('**/api/integrations/linear/connect', async (route) => {
			bodies.push(route.request().postDataJSON())
			// No install_url: the browser stays put so the assertion can run.
			await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
		})

		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

		await expect(page.getByText('9 event types available')).toBeVisible()
		await page.getByRole('button', { name: 'Connect', exact: true }).click()

		await expect.poll(() => bodies.length).toBe(1)
		// This is what lands the user back in this same chat after the consent screen.
		expect(bodies[0]).toMatchObject({
			return_to: `/${account.workspaceId}/chats/${conversation.id}`,
		})
	})

	test('an API-key provider takes the key in a dialog and sends it with the return path', async ({
		page,
		account,
	}) => {
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: `Connect key ${Date.now()}`,
			participant_actor_ids: [],
			initial_message: 'Set up PostHog',
		})
		await stubThread(page, conversation.id, 'posthog', 'PostHog')

		const bodies: Array<Record<string, unknown> | null> = []
		await page.route('**/api/integrations/posthog/connect', async (route) => {
			bodies.push(route.request().postDataJSON())
			await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
		})

		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

		await page.getByRole('button', { name: 'Connect', exact: true }).click()
		const dialog = page.getByRole('dialog')
		const input = dialog.getByLabel('API key')
		await expect(input).toBeVisible()
		// Masked: a key typed into a chat surface must not be shoulder-surfable.
		await expect(input).toHaveAttribute('type', 'password')
		await input.fill('phx_test_key')
		await dialog.getByRole('button', { name: 'Connect' }).click()

		await expect.poll(() => bodies.length).toBe(1)
		expect(bodies[0]).toMatchObject({
			api_key: 'phx_test_key',
			return_to: `/${account.workspaceId}/chats/${conversation.id}`,
		})
	})

	test('a connected provider shows a disabled Connected button instead of Connect', async ({
		page,
		account,
	}) => {
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: `Connect done ${Date.now()}`,
			participant_actor_ids: [],
			initial_message: 'Triage my Linear backlog',
		})
		await stubThread(page, conversation.id, 'linear', 'Linear', [
			activeIntegration(account.workspaceId, 'linear'),
		])
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

		await expect(page.getByRole('button', { name: 'Connected' })).toBeDisabled()
		await expect(page.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0)
		await expect(page.getByRole('button', { name: 'Disconnect' })).toHaveCount(0)
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`the card and its key dialog are reachable and do not overflow at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			const conversation = await account.api.createConversation(account.workspaceId, {
				title: `Connect vp ${Date.now()}`,
				participant_actor_ids: [],
				initial_message: 'Set up PostHog',
			})
			await stubThread(page, conversation.id, 'posthog', 'PostHog')
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

			// toBeVisible covers opacity and visibility, so a hover-only reveal —
			// unusable on touch — fails here rather than shipping.
			const connect = page.getByRole('button', { name: 'Connect', exact: true })
			await expect(connect).toBeVisible()
			const box = await connect.boundingBox()
			expect(box?.height ?? 0).toBeGreaterThanOrEqual(28)

			const overflow = await page.evaluate(() => {
				const el = document.scrollingElement
				return el ? el.scrollWidth - el.clientWidth : 0
			})
			expect(overflow).toBeLessThanOrEqual(1)

			// The dialog is the widest thing the card can open; it must fit too.
			await connect.click()
			const dialog = page.getByRole('dialog')
			await expect(dialog.getByLabel('API key')).toBeVisible()
			await expect(dialog.getByRole('button', { name: 'Connect' })).toBeVisible()
			const dialogBox = await dialog.boundingBox()
			expect((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0)).toBeLessThanOrEqual(viewport.width + 1)
		})
	}

	test('the Connect button is visible in light and dark mode', async ({ page, account }) => {
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: `Connect theme ${Date.now()}`,
			participant_actor_ids: [],
			initial_message: 'Triage my Linear backlog',
		})
		await stubThread(page, conversation.id, 'linear', 'Linear')
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

		for (const colorScheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme })
			await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible()
		}
	})
})
