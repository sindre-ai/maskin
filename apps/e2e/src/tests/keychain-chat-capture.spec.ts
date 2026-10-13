import { type Page, expect } from '@playwright/test'
import { test } from '../fixtures/auth.fixture'
import { type LiveChatSession, seedLiveChatSession } from '../helpers/chat-log-stream.helper'
import { sendFromComposer } from '../helpers/composer.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * In-chat vault, relaunch and undo (flag: keychain-chat-capture), spec file 12.
 *
 * Real: the vault write (POST /api/integrations/chat-capture), the marker message,
 * the undo, and the server-side backstop. Not real: the agent. The web E2E stack has
 * no container runtime and no model credentials, so the seeded session is a real
 * pending row presented as running by a route mock, and the "new session" the
 * relaunch brings up is a synthetic row plus one synthetic log line. So this spec
 * proves the card states, the order of the calls and what the server stored. It does
 * not prove that an agent resumed; that is the 10-run check on production dispatch.
 *
 * The key below is obviously fake and built at runtime so no token-shaped literal
 * sits in the repo.
 */
const FAKE_KEY = `cfut_${'E2ECANARY1'.repeat(5)}`
const MARKER = 'cfut_[REDACTED · vaulted as Cloudflare key]'
const NEW_SESSION_ID = '11111111-2222-4333-8444-555555555555'
const BASE = 'http://localhost:3000'

function authHeaders(apiKey: string, workspaceId: string) {
	return { Authorization: `Bearer ${apiKey}`, 'X-Workspace-Id': workspaceId }
}

/**
 * Presents the seeded pending row as running, and, once `bringUpNewSession` is called,
 * a second running session with one stdout line, which is what a relaunched agent
 * looks like to the card.
 */
async function presentSessions(page: Page, live: LiveChatSession) {
	const state = { newSession: false }
	await page.route('**/api/sessions*', async (route) => {
		const response = await route.fetch()
		let body: unknown
		try {
			body = await response.json()
		} catch {
			await route.fulfill({ response })
			return
		}
		const real = Array.isArray(body) ? (body as Array<Record<string, unknown>>) : []
		const seeded = real
			.filter((s) => s.id === live.sessionId)
			.map((s) => ({ ...s, status: 'running' }))
		const synthetic = state.newSession
			? [
					{
						...(seeded[0] ?? {}),
						id: NEW_SESSION_ID,
						status: 'running',
						actorId: live.agentId,
					},
				]
			: []
		await route.fulfill({ response, json: [...seeded, ...synthetic] })
	})
	await page.route(`**/api/sessions/${NEW_SESSION_ID}/logs*`, (route) =>
		route.fulfill({
			json: [
				{
					id: 1,
					sessionId: NEW_SESSION_ID,
					stream: 'stdout',
					content: '{"type":"system","subtype":"init"}',
					createdAt: new Date().toISOString(),
				},
			],
		}),
	)
	return {
		bringUpNewSession: () => {
			state.newSession = true
		},
	}
}

async function openChat(page: Page, account: { workspaceId: string }, live: LiveChatSession) {
	await page.addInitScript(() => {
		localStorage.setItem('ff:keychain-chat-capture', 'on')
	})
	await page.goto(`/${account.workspaceId}/chats/${live.conversationId}`)
	await expect(page.getByRole('textbox', { name: 'Message this conversation' })).toBeVisible({
		timeout: 15_000,
	})
}

async function pasteAndVault(page: Page, viewportWidth: number) {
	const composer = page.getByRole('textbox', { name: 'Message this conversation' })
	await composer.click()
	await composer.fill(`use ${FAKE_KEY} please`)
	await sendFromComposer(page, composer, viewportWidth)
	await expect(page.getByText('Maskin detected a secret in your message.')).toBeVisible()
	// The whole value never renders.
	await expect(page.locator('body')).not.toContainText(FAKE_KEY)
	await page.getByRole('button', { name: /Vault \+ assign scope/ }).click()
	await expect(page.getByLabel('Credential name')).toHaveValue('Cloudflare key')
	const vaultResponse = page.waitForResponse(
		(r) => r.url().includes('/api/integrations/chat-capture') && r.request().method() === 'POST',
	)
	await page.getByRole('button', { name: /Vault \+ continue chat/ }).click()
	return vaultResponse
}

test.describe('Keychain chat capture: vault, relaunch, undo', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`vault shows Resuming, then Live once the new session speaks @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const live = await seedLiveChatSession(page, account, 'E2E keychain capture')
			await page.unroute('**/api/sessions*')
			const sessions = await presentSessions(page, live)
			await openChat(page, account, live)

			const vaultResponse = await pasteAndVault(page, vp.width)

			// The server answered the vault: stored pending_undo, relaunch decided.
			const vaulted = (await (await vaultResponse).json()) as {
				integrationId: string
				relaunch: string
			}
			expect(vaulted.relaunch).toBe('stopped')

			// Card: Restarting pill, polite status row, and Undo stays available.
			await expect(
				page.getByText('Vaulted. Cloudflare key is now available to 1 agent.'),
			).toBeVisible()
			await expect(page.getByText('Resuming with the new credential…')).toBeVisible()
			await expect(page.getByText('Restarting', { exact: true })).toBeVisible()
			await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled()

			// The marker, not the key, is what was posted and stored.
			const stored = await page.request.get(
				`${BASE}/api/conversations/${live.conversationId}/messages`,
				{
					headers: authHeaders(account.apiKey, account.workspaceId),
				},
			)
			const text = JSON.stringify(await stored.json())
			expect(text).toContain(MARKER)
			expect(text).not.toContain(FAKE_KEY)

			// The relaunched session shows up and writes its first line: the card goes Live.
			sessions.bringUpNewSession()
			await expect(page.getByText('Resuming with the new credential…')).toBeHidden({
				timeout: 15_000,
			})
			await expect(page.getByText('Live', { exact: true })).toBeVisible()

			// Nothing in either web storage holds the key.
			const leaked = await page.evaluate((secret) => {
				const dump = (s: Storage) =>
					Object.keys(s)
						.map((k) => `${k}=${s.getItem(k)}`)
						.join('\n')
				return (dump(localStorage) + dump(sessionStorage)).includes(secret)
			}, FAKE_KEY)
			expect(leaked).toBe(false)
		})
	}

	test('undo ends the session: Undone card, key gone from the vault', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		const live = await seedLiveChatSession(page, account, 'E2E keychain undo')
		await page.unroute('**/api/sessions*')
		await presentSessions(page, live)
		await openChat(page, account, live)

		const vaulted = (await (await pasteAndVault(page, 1024)).json()) as { integrationId: string }
		await expect(page.getByText('Resuming with the new credential…')).toBeVisible()

		const undoResponse = page.waitForResponse((r) =>
			r.url().includes(`/api/integrations/${vaulted.integrationId}/undo`),
		)
		await page.getByRole('button', { name: 'Undo' }).click()
		const undone = (await (await undoResponse).json()) as { status: string; sessionEnded: boolean }
		expect(undone).toMatchObject({ status: 'undone', sessionEnded: true })

		await expect(page.getByText('Undone. Cloudflare key is removed.')).toBeVisible()
		await expect(
			page.getByText(
				'This session has ended. Your next message starts a new one without the credential.',
			),
		).toBeVisible()
		await expect(page.getByText('Ended', { exact: true })).toBeVisible()
		await expect(page.getByText('Resuming with the new credential…')).toBeHidden()

		const list = await page.request.get(`${BASE}/api/integrations`, {
			headers: authHeaders(account.apiKey, account.workspaceId),
		})
		const rows = (await list.json()) as Array<{ id: string; status: string }>
		expect(rows.find((r) => r.id === vaulted.integrationId)?.status).toBe('undone')
	})

	test('the server refuses a raw key posted straight to the conversation (backstop)', async ({
		page,
		account,
	}) => {
		const live = await seedLiveChatSession(page, account, 'E2E keychain backstop')
		const res = await page.request.post(
			`${BASE}/api/conversations/${live.conversationId}/messages`,
			{
				headers: authHeaders(account.apiKey, account.workspaceId),
				data: { content: `here you go ${FAKE_KEY}` },
			},
		)
		expect(res.status()).toBe(400)
		expect(JSON.stringify(await res.json())).toContain('RAW_SECRET_DETECTED')
	})
})
