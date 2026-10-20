import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * E2E for the Approve card an agent puts in chat via `propose_integration_attach`.
 *
 * The card message is injected at the transport rather than seeded through the
 * API on purpose: `metadata.integration_attach` is backend-owned and
 * `stripServerOwnedMetadata` removes it from anything a client posts, so a
 * client-seeded card is exactly the thing that must NOT be renderable. The real
 * write paths are covered against Postgres in
 * apps/dev/src/__tests__/integration/integration-mcp-attach.test.ts; this spec
 * owns the rendering and the interaction.
 *
 * The preset list and the approve call are stubbed: the preset list is derived
 * from live provider connections this stack does not have, and the point of the
 * approve assertions is what the click sends (ids only, never tools).
 */

const SESSION_ID = '11111111-1111-1111-1111-111111111111'
const AGENT_ID = '55555555-5555-5555-5555-555555555555'
const PRESET_ID = 'linkedin-krumhausen-personal'
const LABEL = 'Sebastian Krumhausen'

function preset(overrides: Record<string, unknown> = {}) {
	return {
		preset_id: PRESET_ID,
		provider: 'linkedin-unipile',
		provider_label: 'LinkedIn',
		label: LABEL,
		integration_id: '33333333-3333-3333-3333-333333333333',
		key: PRESET_ID,
		auto_injected: false,
		server: {
			type: 'http',
			url: `\${MASKIN_API_URL}/api/integrations/linkedin-unipile/mcp/${PRESET_ID}`,
		},
		attached: false,
		...overrides,
	}
}

function cardMessage(conversationId: string) {
	return {
		id: 9201,
		conversationId,
		actorId: 'agent-1',
		actorName: 'Chief of Staff',
		actorType: 'agent' as const,
		kind: 'message' as const,
		content: `Allow **Sales Rep** to use **${LABEL}**. Approve with the card below (workspace admins only).`,
		metadata: {
			integration_attach: { session_id: SESSION_ID, actor_id: AGENT_ID, preset_id: PRESET_ID },
		},
		sessionId: SESSION_ID,
		createdAt: new Date().toISOString(),
		editedAt: null,
	}
}

async function stubThread(
	page: Page,
	conversationId: string,
	presets: Array<Record<string, unknown>> = [preset()],
) {
	await page.addInitScript(() => localStorage.setItem('ff:integration-attach-card', 'on'))
	await page.route('**/api/conversations/*/messages*', async (route) => {
		if (route.request().method() !== 'GET') return route.continue()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ messages: [cardMessage(conversationId)], has_more: false }),
		})
	})
	await page.route('**/api/integrations/mcp-presets*', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ presets }),
		}),
	)
}

test.describe('Agent integration attach card', () => {
	test('approving sends only the ids, never any tools', async ({ page, account }) => {
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: `Attach ${Date.now()}`,
			participant_actor_ids: [],
			initial_message: 'Get Sales Rep its LinkedIn back',
		})
		await stubThread(page, conversation.id)

		const calls: Array<{ url: string; body: Record<string, unknown> | null }> = []
		await page.route('**/api/actors/*/integration-mcp/*', async (route) => {
			calls.push({ url: route.request().url(), body: route.request().postDataJSON() })
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					preset_id: PRESET_ID,
					key: PRESET_ID,
					attached_actor_ids: [AGENT_ID],
					already_attached_actor_ids: [],
				}),
			})
		})

		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		await page.getByRole('button', { name: new RegExp(`Allow .* to use ${LABEL}`) }).click()

		await expect.poll(() => calls.length).toBe(1)
		expect(calls[0]?.url).toContain(`/api/actors/${AGENT_ID}/integration-mcp/${PRESET_ID}`)
		expect(calls[0]?.body).toEqual({ all_affected: false })
	})

	test('offers a second action for every agent a disconnect stripped it from', async ({
		page,
		account,
	}) => {
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: `Attach all ${Date.now()}`,
			participant_actor_ids: [],
			initial_message: 'Restore LinkedIn',
		})
		await stubThread(page, conversation.id, [
			preset({
				affected_agents: [
					{ id: AGENT_ID, name: 'Sales Rep' },
					{ id: '66666666-6666-6666-6666-666666666666', name: 'IR' },
				],
			}),
		])
		const bodies: Array<Record<string, unknown> | null> = []
		await page.route('**/api/actors/*/integration-mcp/*', async (route) => {
			bodies.push(route.request().postDataJSON())
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					preset_id: PRESET_ID,
					key: PRESET_ID,
					attached_actor_ids: [AGENT_ID],
					already_attached_actor_ids: [],
				}),
			})
		})

		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		await page.getByRole('button', { name: 'Attach to all 2 affected agents' }).click()

		await expect.poll(() => bodies.length).toBe(1)
		expect(bodies[0]).toEqual({ all_affected: true })
	})

	test('a card whose agent already holds the entry has no buttons', async ({ page, account }) => {
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: `Attach done ${Date.now()}`,
			participant_actor_ids: [],
			initial_message: 'Restore LinkedIn',
		})
		await stubThread(page, conversation.id, [preset({ attached: true })])
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

		await expect(page.getByText(new RegExp(`can use ${LABEL}`))).toBeVisible()
		await expect(page.getByRole('button', { name: /Allow .* to use/ })).toHaveCount(0)
	})

	test('with the flag off the thread shows the markdown and no card', async ({ page, account }) => {
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: `Attach off ${Date.now()}`,
			participant_actor_ids: [],
			initial_message: 'Restore LinkedIn',
		})
		await stubThread(page, conversation.id)
		await page.addInitScript(() => localStorage.setItem('ff:integration-attach-card', 'off'))
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

		await expect(page.getByText('Approve tool access')).toHaveCount(0)
		await expect(page.getByText(new RegExp(LABEL)).first()).toBeVisible()
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`the card and its actions are reachable and do not overflow at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			const conversation = await account.api.createConversation(account.workspaceId, {
				title: `Attach vp ${Date.now()}`,
				participant_actor_ids: [],
				initial_message: 'Restore LinkedIn',
			})
			await stubThread(page, conversation.id, [
				preset({
					affected_agents: [
						{ id: AGENT_ID, name: 'Sales Rep' },
						{ id: '66666666-6666-6666-6666-666666666666', name: 'IR' },
					],
				}),
			])
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

			// toBeVisible covers opacity and visibility, so a hover-only reveal —
			// unusable on touch — fails here rather than shipping.
			const approve = page.getByRole('button', { name: new RegExp(`Allow .* to use ${LABEL}`) })
			const all = page.getByRole('button', { name: 'Attach to all 2 affected agents' })
			await expect(approve).toBeVisible()
			await expect(all).toBeVisible()
			for (const button of [approve, all]) {
				const box = await button.boundingBox()
				expect(box?.height ?? 0).toBeGreaterThanOrEqual(28)
				expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(viewport.width + 1)
			}

			const overflow = await page.evaluate(() => {
				const el = document.scrollingElement
				return el ? el.scrollWidth - el.clientWidth : 0
			})
			expect(overflow).toBeLessThanOrEqual(1)
		})
	}

	test('the Approve button is visible in light and dark mode', async ({ page, account }) => {
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: `Attach theme ${Date.now()}`,
			participant_actor_ids: [],
			initial_message: 'Restore LinkedIn',
		})
		await stubThread(page, conversation.id)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

		for (const colorScheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme })
			await expect(
				page.getByRole('button', { name: new RegExp(`Allow .* to use ${LABEL}`) }),
			).toBeVisible()
		}
	})
})
