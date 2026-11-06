import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The tool server and integration access request cards in chat (v3): header with icon tile,
 * labelled rows, a black primary action with a quiet "Not now", the access level lowered
 * before Allow, and the folded answers.
 *
 * The messages are injected at the transport on purpose: `metadata.mcp_server_request` and
 * `metadata.integration_access_request` are backend-owned and stripped from anything a client
 * posts. The write paths (customMcpServers.create, allowAccess) are stubbed because a real
 * answer would start an agent session; they are covered against Postgres elsewhere.
 */

const SESSION_ID = '11111111-1111-1111-1111-111111111111'
const INTEGRATION_ID = '22222222-2222-2222-2222-222222222222'

function agentMessage(conversationId: string, id: number, metadata: Record<string, unknown>) {
	return {
		id,
		conversationId,
		actorId: 'agent-1',
		actorName: 'Chief of Staff',
		actorType: 'agent' as const,
		kind: 'message' as const,
		content: 'I need two things before I can carry on.',
		metadata,
		sessionId: SESSION_ID,
		createdAt: new Date().toISOString(),
		editedAt: null,
	}
}

async function stubThread(page: Page, conversationId: string, actorId: string) {
	await page.route(/\/api\/integrations(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify([
				{
					id: INTEGRATION_ID,
					workspaceId: 'ws',
					provider: 'gmail',
					status: 'active',
					externalId: null,
					config: {},
					actorId: null,
					createdBy: actorId,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					defaultAgentAccess: 'none',
					agentGrants: [],
				},
			]),
		})
	})
	await page.route('**/api/conversations/*/messages*', async (route) => {
		if (route.request().method() === 'POST') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				messages: [
					agentMessage(conversationId, 9301, {
						integration_access_request: {
							session_id: SESSION_ID,
							integration_id: INTEGRATION_ID,
							provider: 'gmail',
							display_name: 'Gmail',
							level: 'read_write',
							reason: 'Needed to draft the reply to Bente.',
						},
					}),
					agentMessage(conversationId, 9302, {
						mcp_server_request: {
							session_id: SESSION_ID,
							name: 'ahrefs',
							command: 'npx',
							args: ['-y', '@ahrefs/mcp', '--read-only'],
							secret_env: ['AHREFS_API_KEY'],
						},
					}),
				],
				has_more: false,
			}),
		})
	})
}

test.describe('Chat request cards v3', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`rows, black primary and quiet Not now, no overflow at ${viewport.label}`, async ({
			page,
			account,
		}, testInfo) => {
			const conversation = await account.api.createConversation(account.workspaceId, {
				title: `Cards v3 ${Date.now()}`,
				participant_actor_ids: [],
				initial_message: 'Ping',
			})
			await stubThread(page, conversation.id, account.actorId)
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

			const access = page.getByRole('group', { name: 'Allow Gmail' })
			await expect(access).toBeVisible()
			await expect(access.getByText('Integration', { exact: true })).toBeVisible()
			await expect(access.getByText('Lasts', { exact: true })).toBeVisible()
			await expect(access.getByRole('radio', { name: 'Read and write' })).toBeChecked()
			const allow = access.getByRole('button', { name: 'Allow', exact: true })
			const notNow = access.getByRole('button', { name: 'Not now' })
			await expect(allow).toBeVisible()
			await expect(notNow).toBeVisible()

			const tool = page.getByRole('form', { name: 'Add ahrefs' })
			await tool.scrollIntoViewIfNeeded()
			await expect(tool).toBeVisible()
			await expect(tool.getByText('Runs inside the agent')).toBeVisible()
			await expect(tool.getByText('npx -y @ahrefs/mcp --read-only')).toBeVisible()
			await expect(tool.getByText('Read and write, this agent only')).toBeVisible()

			if (viewport.width < 768) {
				// 44px touch targets on phone widths, including the radio rows.
				for (const target of [allow, notNow]) {
					expect((await target.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(43)
				}
			}
			const overflow = await page.evaluate(() => {
				const el = document.scrollingElement
				return el ? el.scrollWidth - el.clientWidth : 0
			})
			expect(overflow).toBeLessThanOrEqual(1)

			await page.screenshot({ path: testInfo.outputPath(`cards-${viewport.width}.png`) })
		})
	}

	test('the level can be lowered to Read before Allow, and Not now folds the card', async ({
		page,
		account,
	}) => {
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: `Cards v3 level ${Date.now()}`,
			participant_actor_ids: [],
			initial_message: 'Ping',
		})
		await stubThread(page, conversation.id, account.actorId)
		const allows: Array<Record<string, unknown> | null> = []
		await page.route(`**/api/integrations/${INTEGRATION_ID}/allow-access`, async (route) => {
			allows.push(route.request().postDataJSON())
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ actorId: 'agent-1', changed: true, relaunch: 'stopped' }),
			})
		})
		await page.route('**/api/conversations/*/messages', (route) =>
			route.request().method() === 'POST'
				? route.fulfill({
						status: 201,
						contentType: 'application/json',
						body: JSON.stringify({
							...agentMessage(conversation.id, 9400, {}),
							actorId: account.actorId,
							actorName: 'Me',
							actorType: 'human',
							metadata: null,
						}),
					})
				: route.fallback(),
		)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

		const access = page.getByRole('group', { name: 'Allow Gmail' })
		await access.getByRole('radio', { name: 'Read', exact: true }).click()
		await access.getByRole('button', { name: 'Allow', exact: true }).click()
		await expect.poll(() => allows.length).toBe(1)
		expect(allows[0]).toMatchObject({ level: 'read' })
		await expect(page.getByText(/Allowed/)).toBeVisible()

		await page
			.getByRole('form', { name: 'Add ahrefs' })
			.getByRole('button', { name: 'Not now' })
			.click()
		await expect(page.getByText(/Declined/)).toBeVisible()
		await expect(page.getByRole('button', { name: 'Ask again' })).toBeVisible()
	})

	test('the cards are legible in light and dark mode', async ({ page, account }) => {
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: `Cards v3 theme ${Date.now()}`,
			participant_actor_ids: [],
			initial_message: 'Ping',
		})
		await stubThread(page, conversation.id, account.actorId)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

		for (const colorScheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme })
			const access = page.getByRole('group', { name: 'Allow Gmail' })
			await expect(access.getByRole('button', { name: 'Allow', exact: true })).toBeVisible()
			await expect(access.getByText('Allow Gmail for')).toBeVisible()
		}
	})
})
