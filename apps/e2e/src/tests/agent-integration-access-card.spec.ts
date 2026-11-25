import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * E2E for the card an agent puts in chat via `request_integration_access` for Google Calendar,
 * which offers Allow in this chat for 8 hours next to Always allow and Not now.
 *
 * The card message is injected at the transport on purpose: `metadata.integration_access_request`
 * (and its `chat_lift` part) is backend-owned and `stripServerOwnedMetadata` removes it from
 * anything a client posts. The real write path (card, shown row, chat grant, allowed row, the
 * resolver) is covered against Postgres in
 * apps/dev/src/__tests__/integration/chat-write-lift.test.ts; this spec owns the rendering and the
 * interaction. The allow call and the follow-up message are stubbed: a real follow-up would start
 * an agent session.
 */

const SESSION_ID = '11111111-1111-1111-1111-111111111111'
const INTEGRATION_ID = '55555555-5555-4555-8555-555555555555'
const LIFT_TEXT =
	'Lets this agent change your calendar for 8 hours in this chat. That includes creating, editing and deleting events, and sending invites to attendees. It can still read as before.'

function cardMessage(conversationId: string) {
	return {
		id: 9401,
		conversationId,
		actorId: 'agent-1',
		actorName: 'Scheduler',
		actorType: 'agent' as const,
		kind: 'message' as const,
		content: 'I need to change your calendar.',
		metadata: {
			integration_access_request: {
				session_id: SESSION_ID,
				integration_id: INTEGRATION_ID,
				provider: 'google-calendar',
				display_name: 'Google Calendar',
				level: 'read_write',
				reason: 'To add the Meet link.',
				chat_lift: { hours: 8, text: LIFT_TEXT, tool: 'create_event' },
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
	followUps: Array<Record<string, unknown> | null>,
) {
	await page.route('**/api/conversations/*/messages*', async (route) => {
		if (route.request().method() === 'POST') {
			followUps.push(route.request().postDataJSON())
			await route.fulfill({
				status: 201,
				contentType: 'application/json',
				body: JSON.stringify({
					...cardMessage(conversationId),
					id: 9402,
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

/** Calendar at Read, connected by the signed-in account so it may allow it. */
async function stubIntegrations(page: Page, workspaceId: string, createdBy: string) {
	await page.route('**/api/integrations', async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		return route.fulfill({
			json: [
				{
					id: INTEGRATION_ID,
					workspaceId,
					provider: 'google-calendar',
					providerMode: 'registered',
					displayName: 'Google Calendar',
					status: 'active',
					externalId: 'me@example.com',
					config: {},
					actorId: null,
					createdBy,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					defaultAgentAccess: 'read',
					agentGrants: [],
				},
			],
		})
	})
}

interface Account {
	workspaceId: string
	actorId: string
	api: {
		createConversation: (ws: string, body: Record<string, unknown>) => Promise<{ id: string }>
	}
}

async function openCard(
	page: Page,
	account: Account,
	followUps: Array<Record<string, unknown> | null> = [],
) {
	const conversation = await account.api.createConversation(account.workspaceId, {
		title: `Calendar access ${Date.now()}`,
		participant_actor_ids: [],
		initial_message: 'Add a Meet link to my 3pm',
	})
	await stubThread(page, conversation.id, followUps)
	await stubIntegrations(page, account.workspaceId, account.actorId)
	await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
	const card = page.getByRole('group', { name: 'Allow Google Calendar' })
	await expect(card).toBeVisible({ timeout: 15_000 })
	return card
}

for (const vp of SHIP_GATE_VIEWPORTS) {
	test(`Allow in this chat for 8 hours lifts one chat and tells the agent @ ${vp.label}`, async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: vp.width, height: vp.height })
		const allows: Array<Record<string, unknown> | null> = []
		await page.route('**/api/integrations/*/allow-access', async (route) => {
			allows.push(route.request().postDataJSON())
			await route.fulfill({
				json: {
					actorId: '66666666-6666-4666-8666-666666666666',
					changed: true,
					relaunch: 'stopped',
				},
			})
		})
		const followUps: Array<Record<string, unknown> | null> = []

		const card = await openCard(page, account, followUps)
		// Fixed text, the tool of the refused call, and the agent's own words, each labelled.
		await expect(card).toContainText(LIFT_TEXT)
		await expect(card).toContainText('create_event')
		await expect(card).toContainText('The agent says')
		await expect(card).toContainText('To add the Meet link.')

		await card.getByRole('button', { name: 'Allow in this chat for 8 hours' }).click()

		await expect(page.getByText(/in this chat for 8 hours\./)).toBeVisible()
		expect(allows).toEqual([{ sessionId: SESSION_ID, level: 'read_write', scope: 'chat' }])
		await expect.poll(() => followUps.length).toBe(1)
		expect(String(followUps[0]?.content)).toContain('for the next 8 hours, in this chat only')

		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth > window.innerWidth,
		)
		expect(overflow).toBe(false)
	})
}

test('Always allow still sets the standing level', async ({ page, account }) => {
	const allows: Array<Record<string, unknown> | null> = []
	await page.route('**/api/integrations/*/allow-access', async (route) => {
		allows.push(route.request().postDataJSON())
		await route.fulfill({ json: { actorId: 'agent-1', changed: true, relaunch: 'stopped' } })
	})

	const card = await openCard(page, account)
	await card.getByRole('button', { name: 'Always allow' }).click()

	await expect(page.getByText(/It stays until you remove it/)).toBeVisible()
	expect(allows).toEqual([{ sessionId: SESSION_ID, level: 'read_write', scope: 'always' }])
})

test('Not now tells the agent and never grants', async ({ page, account }) => {
	let allowed = false
	await page.route('**/api/integrations/*/allow-access', (route) => {
		allowed = true
		return route.fulfill({ json: {} })
	})
	const followUps: Array<Record<string, unknown> | null> = []

	const card = await openCard(page, account, followUps)
	await card.getByRole('button', { name: 'Not now' }).click()

	await expect(page.getByText(/Declined/)).toBeVisible()
	expect(allowed).toBe(false)
	await expect.poll(() => followUps.length).toBe(1)
	expect(String(followUps[0]?.content)).toContain("don't use Google Calendar")
})
