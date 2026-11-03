import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * E2E for the card an agent puts in chat via `request_keychain_access` to use a
 * credential that already exists in the Keychain.
 *
 * The card message is injected at the transport rather than seeded through the API on
 * purpose: `metadata.keychain_access_request` is backend-owned and
 * `stripServerOwnedMetadata` removes it from anything a client posts. The real write
 * path (card, grant, audit, restart) is covered against Postgres in
 * apps/dev/src/__tests__/integration/keychain-access-request.test.ts; this spec owns
 * the rendering and the interaction. The allow call and the follow-up message are
 * stubbed: a real follow-up would start an agent session.
 */

const SESSION_ID = '11111111-1111-1111-1111-111111111111'
const INTEGRATION_ID = '55555555-5555-4555-8555-555555555555'

function cardMessage(conversationId: string) {
	return {
		id: 9301,
		conversationId,
		actorId: 'agent-1',
		actorName: 'Bookkeeper',
		actorType: 'agent' as const,
		kind: 'message' as const,
		content: `I'd like to use **Stripe** from your Keychain.`,
		metadata: {
			keychain_access_request: {
				session_id: SESSION_ID,
				integration_id: INTEGRATION_ID,
				credential_name: 'Stripe',
				kind: 'api_key',
				hint: 'To read the latest invoices.',
			},
		},
		sessionId: SESSION_ID,
		createdAt: new Date().toISOString(),
		editedAt: null,
	}
}

async function stubThread(page: Page, conversationId: string) {
	await page.route('**/api/conversations/*/messages*', async (route) => {
		if (route.request().method() === 'POST') {
			await route.fulfill({
				status: 201,
				contentType: 'application/json',
				body: JSON.stringify({
					...cardMessage(conversationId),
					id: 9302,
					actorId: 'me',
					actorType: 'human',
					metadata: null,
				}),
			})
			return
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ messages: [cardMessage(conversationId)], has_more: false }),
		})
	})
}

/** The credential, saved by the signed-in account so it may allow it. */
async function stubIntegrations(
	page: Page,
	workspaceId: string,
	createdBy: string,
	grants: Array<{ actorId: string; access: string }> = [],
) {
	await page.route('**/api/integrations', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		return route.fulfill({
			json: [
				{
					id: INTEGRATION_ID,
					workspaceId,
					provider: 'custom',
					providerMode: 'byo_apikey',
					displayName: 'Stripe',
					status: 'active',
					externalId: null,
					config: {},
					actorId: null,
					createdBy,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					defaultAgentAccess: 'none',
					agentGrants: grants,
				},
			],
		})
	})
}

for (const vp of SHIP_GATE_VIEWPORTS) {
	test(`Always allow grants the agent and tells it where the credential is @ ${vp.label}`, async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: vp.width, height: vp.height })
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: `Keychain access ${Date.now()}`,
			participant_actor_ids: [],
			initial_message: 'Read my latest invoices',
		})
		await stubThread(page, conversation.id)
		await stubIntegrations(page, account.workspaceId, account.actorId)

		const allows: Array<Record<string, unknown> | null> = []
		await page.route('**/api/integrations/*/allow-from-chat', async (route) => {
			allows.push(route.request().postDataJSON())
			await route.fulfill({
				json: { actorId: '66666666-6666-4666-8666-666666666666', relaunch: 'stopped' },
			})
		})
		const followUps: Array<Record<string, unknown> | null> = []
		await page.route('**/api/conversations/*/messages', (route) => {
			if (route.request().method() === 'POST') followUps.push(route.request().postDataJSON())
			return route.fallback()
		})

		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const card = page.getByRole('group', { name: 'Allow Stripe' })
		await expect(card).toBeVisible({ timeout: 15_000 })
		await expect(card).toContainText('Let this agent use Stripe?')
		await expect(card).toContainText('To read the latest invoices.')

		// The choices say how long they last before anything is clicked.
		await expect(card).toContainText('only this agent, only in this conversation')
		await expect(card).toContainText('until you remove it in Settings')

		await card.getByRole('button', { name: 'Always allow' }).click()

		await expect(page.getByText(/It stays until you remove it/)).toBeVisible()
		expect(allows).toEqual([{ sessionId: SESSION_ID, scope: 'always' }])
		await expect.poll(() => followUps.length).toBe(1)
		expect(String(followUps[0]?.content)).toContain('KEYCHAIN_BYO_APIKEY_STRIPE')

		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth > window.innerWidth,
		)
		expect(overflow).toBe(false)
	})
}

test('Allow in this chat grants for this conversation only', async ({ page, account }) => {
	const conversation = await account.api.createConversation(account.workspaceId, {
		title: `Keychain chat allow ${Date.now()}`,
		participant_actor_ids: [],
		initial_message: 'Read my latest invoices',
	})
	await stubThread(page, conversation.id)
	await stubIntegrations(page, account.workspaceId, account.actorId)
	const allows: Array<Record<string, unknown> | null> = []
	await page.route('**/api/integrations/*/allow-from-chat', async (route) => {
		allows.push(route.request().postDataJSON())
		await route.fulfill({ json: { actorId: 'agent-1', relaunch: 'stopped' } })
	})

	await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
	await page.getByRole('button', { name: 'Allow in this chat' }).click()

	await expect(page.getByText(/^Allowed .* in this chat only.$/)).toBeVisible()
	expect(allows).toEqual([{ sessionId: SESSION_ID, scope: 'chat' }])
})

test('Not now tells the agent and never grants', async ({ page, account }) => {
	const conversation = await account.api.createConversation(account.workspaceId, {
		title: `Keychain decline ${Date.now()}`,
		participant_actor_ids: [],
		initial_message: 'Read my latest invoices',
	})
	await stubThread(page, conversation.id)
	await stubIntegrations(page, account.workspaceId, account.actorId)
	let allowed = false
	await page.route('**/api/integrations/*/allow-from-chat', (route) => {
		allowed = true
		return route.fulfill({ json: {} })
	})
	const followUps: Array<Record<string, unknown> | null> = []
	await page.route('**/api/conversations/*/messages', (route) => {
		if (route.request().method() === 'POST') followUps.push(route.request().postDataJSON())
		return route.fallback()
	})

	await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
	await page.getByRole('button', { name: 'Not now' }).click()

	await expect(page.getByText(/Declined/)).toBeVisible()
	expect(allowed).toBe(false)
	await expect.poll(() => followUps.length).toBe(1)
	expect(String(followUps[0]?.content)).toContain("don't use Stripe")
})

test('a card scrolled back to reads as allowed, in light and dark', async ({ page, account }) => {
	const conversation = await account.api.createConversation(account.workspaceId, {
		title: `Keychain allowed ${Date.now()}`,
		participant_actor_ids: [],
		initial_message: 'Read my latest invoices',
	})
	await stubThread(page, conversation.id)
	await stubIntegrations(page, account.workspaceId, account.actorId, [
		{ actorId: 'agent-1', access: 'read_write' },
	])

	await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme })
		await expect(page.getByText(/Allowed/)).toBeVisible({ timeout: 15_000 })
		// The buttons are gone; the group that held them is replaced by the plain line.
		await expect(page.getByRole('group', { name: 'Allow Stripe' })).toHaveCount(0)
	}
})
