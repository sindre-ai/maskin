import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * E2E for the Keychain card an agent puts in chat via `request_keychain_credential`.
 *
 * The card message is injected at the transport rather than seeded through the API on
 * purpose: `metadata.keychain_request` is backend-owned and `stripServerOwnedMetadata`
 * removes it from anything a client posts, so a client-seeded card is exactly the thing
 * that must NOT be renderable. The real write path is covered against Postgres in
 * apps/dev/src/__tests__/integration/session-keychain-card.test.ts (the card) and
 * keychain-login.test.ts (the vault and the env injection); this spec owns the
 * rendering and the interaction.
 *
 * The chat-capture call and the follow-up message are stubbed: the vault is covered
 * above, and a real follow-up message would start an agent session.
 */

const SESSION_ID = '11111111-1111-1111-1111-111111111111'
const PASSWORD = String.raw`pw"with\odd'chars-æøå`

function cardMessage(conversationId: string, kind: 'login' | 'api_key', name: string) {
	return {
		id: 9201,
		conversationId,
		actorId: 'agent-1',
		actorName: 'Bookkeeper',
		actorType: 'agent' as const,
		kind: 'message' as const,
		content: `I need a login for **${name}**. Add it with the Keychain card below.`,
		metadata: {
			keychain_request: {
				session_id: SESSION_ID,
				kind,
				suggested_name: name,
				hint: 'To read the latest invoices.',
			},
		},
		sessionId: SESSION_ID,
		createdAt: new Date().toISOString(),
		editedAt: null,
	}
}

async function stubThread(
	page: Page,
	conversationId: string,
	kind: 'login' | 'api_key',
	name: string,
) {
	await page.route('**/api/conversations/*/messages*', async (route) => {
		if (route.request().method() === 'POST') {
			await route.fulfill({
				status: 201,
				contentType: 'application/json',
				body: JSON.stringify({
					...cardMessage(conversationId, kind, name),
					id: 9202,
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
			body: JSON.stringify({
				messages: [cardMessage(conversationId, kind, name)],
				has_more: false,
			}),
		})
	})
}

test.describe('Agent Keychain card', () => {
	test('a login is typed into the card, vaulted for the workspace, and the agent is restarted', async ({
		page,
		account,
	}) => {
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: `Keychain login ${Date.now()}`,
			participant_actor_ids: [],
			initial_message: 'Read my latest invoices',
		})
		await stubThread(page, conversation.id, 'login', 'e-conomic')

		const captures: Array<Record<string, unknown> | null> = []
		await page.route('**/api/integrations/chat-capture', async (route) => {
			captures.push(route.request().postDataJSON())
			await route.fulfill({
				status: 201,
				contentType: 'application/json',
				body: JSON.stringify({
					integrationId: '55555555-5555-5555-5555-555555555555',
					undoExpiresAt: new Date(Date.now() + 300_000).toISOString(),
					undoUrl: '/api/integrations/55555555-5555-5555-5555-555555555555/undo',
					relaunch: 'stopped',
				}),
			})
		})
		const followUps: Array<Record<string, unknown> | null> = []
		await page.route('**/api/conversations/*/messages', (route) => {
			if (route.request().method() === 'POST') followUps.push(route.request().postDataJSON())
			return route.fallback()
		})

		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

		const form = page.getByRole('form', { name: 'Add a login to the Keychain' })
		await expect(form).toBeVisible()
		await expect(form.getByLabel('Name', { exact: true })).toHaveValue('e-conomic')
		const password = form.getByLabel('Password')
		// Masked: a password typed into a chat surface must not be shoulder-surfable.
		await expect(password).toHaveAttribute('type', 'password')
		await form.getByLabel('Username or email').fill('me@example.test')
		await password.fill(PASSWORD)
		await form.getByRole('button', { name: 'Save to Keychain' }).click()

		await expect.poll(() => captures.length).toBe(1)
		expect(captures[0]).toMatchObject({
			sessionId: SESSION_ID,
			providerMode: 'byo_login',
			displayName: 'e-conomic',
			username: 'me@example.test',
			password: PASSWORD,
			fromCard: true,
		})
		// The form is gone, replaced by a receipt, and the follow-up carries no value.
		await expect(page.getByRole('link', { name: 'Manage in Keychain' })).toBeVisible()
		await expect(form).toHaveCount(0)
		await expect.poll(() => followUps.length).toBe(1)
		expect(JSON.stringify(followUps[0])).not.toContain(PASSWORD)
		expect(JSON.stringify(followUps[0])).toContain('KEYCHAIN_BYO_LOGIN_E_CONOMIC_PASSWORD')
	})

	test('an API key card asks for one secret and vaults it as a manual capture', async ({
		page,
		account,
	}) => {
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: `Keychain key ${Date.now()}`,
			participant_actor_ids: [],
			initial_message: 'Connect to Stripe',
		})
		await stubThread(page, conversation.id, 'api_key', 'Stripe')

		const captures: Array<Record<string, unknown> | null> = []
		await page.route('**/api/integrations/chat-capture', async (route) => {
			captures.push(route.request().postDataJSON())
			await route.fulfill({
				status: 201,
				contentType: 'application/json',
				body: JSON.stringify({
					integrationId: '55555555-5555-5555-5555-555555555555',
					undoExpiresAt: new Date(Date.now() + 300_000).toISOString(),
					undoUrl: '/x',
					relaunch: 'stopped',
				}),
			})
		})

		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

		const form = page.getByRole('form', { name: 'Add an API key to the Keychain' })
		await expect(form.getByLabel('Username or email')).toHaveCount(0)
		await form.getByLabel('Secret').fill('sk_test_value')
		await form.getByRole('button', { name: 'Save to Keychain' }).click()

		await expect.poll(() => captures.length).toBe(1)
		expect(captures[0]).toMatchObject({
			providerMode: 'byo_apikey',
			detectedProvider: 'manual',
			rawSecret: 'sk_test_value',
			fromCard: true,
		})
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`the card is reachable and does not overflow at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			const conversation = await account.api.createConversation(account.workspaceId, {
				title: `Keychain vp ${Date.now()}`,
				participant_actor_ids: [],
				initial_message: 'Read my latest invoices',
			})
			await stubThread(page, conversation.id, 'login', 'e-conomic')
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

			const form = page.getByRole('form', { name: 'Add a login to the Keychain' })
			// toBeVisible covers opacity and visibility, so a hover-only reveal —
			// unusable on touch — fails here rather than shipping.
			await expect(form.getByLabel('Password')).toBeVisible()
			await expect(form.getByRole('button', { name: 'Show' })).toBeVisible()
			await expect(form.getByRole('button', { name: 'Save to Keychain' })).toBeVisible()

			const overflow = await page.evaluate(() => {
				const el = document.scrollingElement
				return el ? el.scrollWidth - el.clientWidth : 0
			})
			expect(overflow).toBeLessThanOrEqual(1)
			const box = await form.boundingBox()
			expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width + 1)
		})
	}

	test('the card is legible in light and dark mode', async ({ page, account }) => {
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: `Keychain theme ${Date.now()}`,
			participant_actor_ids: [],
			initial_message: 'Read my latest invoices',
		})
		await stubThread(page, conversation.id, 'login', 'e-conomic')
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

		for (const colorScheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme })
			const form = page.getByRole('form', { name: 'Add a login to the Keychain' })
			await expect(form.getByRole('button', { name: 'Save to Keychain' })).toBeVisible()
			await expect(form.getByText('Add a login to your Keychain')).toBeVisible()
		}
	})
})
