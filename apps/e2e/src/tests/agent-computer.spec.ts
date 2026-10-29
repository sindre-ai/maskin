import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * E2E coverage for an agent's computer: the Computer section of the agent page
 * and its expand-to-popup.
 *
 * CI has no agent-server or microVM, so the computer itself is faked at the
 * network edges the page touches: `GET /api/desktop` (which agents have one, and
 * whether it is asleep), `POST /api/desktop/connect` and the `/api/desktop/stream`
 * WebSocket. What this spec proves is the wiring and layout: that opening the page never starts or wakes a computer on its own, the ticket
 * hand-off, error and retry states, the popup, and no horizontal overflow at the
 * ship-gate viewports. The live VNC picture is covered by the manual run in
 * docker/desktop/README.md.
 */

const CONNECT = /\/api\/desktop\/connect/
const LIST = /\/api\/desktop$/

async function expectNoHorizontalOverflow(page: Page) {
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
	)
	expect(overflow).toBeLessThanOrEqual(0)
}

async function seedAgent(account: {
	workspaceId: string
	api: {
		createAgentActor: (name: string) => Promise<{ id: string }>
		addWorkspaceMember: (workspaceId: string, actorId: string) => Promise<unknown>
	}
}) {
	const name = `Computer owner ${Date.now()}`
	const agent = await account.api.createAgentActor(name)
	await account.api.addWorkspaceMember(account.workspaceId, agent.id)
	return { id: agent.id, name }
}

const listing = (page: Page, agentId: string, status?: 'running' | 'suspended') =>
	page.route(LIST, (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ desktops: status ? [{ agent_id: agentId, status }] : [] }),
		}),
	)

test.describe("An agent's computer", () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`is offered, not started, when it does not exist yet at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await seedAgent(account)
			await listing(page, agent.id)
			let connectCalls = 0
			await page.route(CONNECT, async (route) => {
				connectCalls += 1
				await route.abort()
			})

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			const start = page.getByRole('button', { name: 'Start computer' })
			await expect(start).toBeVisible()
			await expect(page.getByText('Not started yet')).toBeVisible()
			await expectNoHorizontalOverflow(page)
			// Opening an agent page must never start a computer by itself.
			expect(connectCalls).toBe(0)
		})

		test(`offers to wake a sleeping computer instead of waking it at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await seedAgent(account)
			await listing(page, agent.id, 'suspended')
			let connectCalls = 0
			await page.route(CONNECT, async (route) => {
				connectCalls += 1
				await route.abort()
			})

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			await expect(page.getByRole('button', { name: 'Wake up' })).toBeVisible()
			await expect(page.getByText('Asleep', { exact: true })).toBeVisible()
			await expectNoHorizontalOverflow(page)
			expect(connectCalls).toBe(0)
		})

		test(`shows a retryable error when it cannot start at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await seedAgent(account)
			await listing(page, agent.id)
			let connectCalls = 0
			await page.route(CONNECT, async (route) => {
				connectCalls += 1
				await route.fulfill({
					status: 503,
					contentType: 'application/json',
					body: JSON.stringify({
						error: { code: 'INTERNAL_ERROR', message: 'No desktop could be started' },
					}),
				})
			})

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
			await page.getByRole('button', { name: 'Start computer' }).click()

			await expect(page.getByText("Couldn't open the desktop")).toBeVisible()
			const reconnect = page.getByRole('button', { name: 'Reconnect' })
			await expect(reconnect).toBeVisible()
			await expectNoHorizontalOverflow(page)

			// Relative, not absolute: the dev server runs StrictMode, which mounts the
			// effect twice, so the count before the click differs between CI and local.
			const callsBeforeRetry = connectCalls
			await reconnect.click()
			await expect.poll(() => connectCalls).toBe(callsBeforeRetry + 1)
		})

		test(`expands into a popup that fits the screen at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await seedAgent(account)
			await listing(page, agent.id, 'running')
			// Never fulfilled: the computer stays in its starting state.
			await page.route(CONNECT, () => {})

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
			await page.getByRole('button', { name: 'Open computer in a popup' }).click()

			const dialog = page.getByRole('dialog')
			await expect(dialog).toBeVisible()
			// The controls float under the picture once it is live; until then the collapse
			// button in the corner is what is there.
			await expect(dialog.getByRole('button', { name: 'Close popup' })).toBeVisible()
			const box = await dialog.boundingBox()
			if (!box) throw new Error('popup not laid out')
			expect(box.width).toBeLessThanOrEqual(vp.width)
			await expectNoHorizontalOverflow(page)

			await dialog.getByRole('button', { name: 'Close popup' }).click()
			await expect(dialog).toHaveCount(0)
		})
	}

	test('opens the stream WebSocket with the one-time ticket from connect', async ({
		page,
		account,
	}) => {
		const agent = await seedAgent(account)
		await listing(page, agent.id, 'running')
		let connectUrl = ''
		await page.route(CONNECT, async (route) => {
			connectUrl = route.request().url()
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					ticket: 'e2e-ticket',
					path: '/api/desktop/stream',
					password: 'e2e-password',
				}),
			})
		})
		// Observed, not intercepted: noVNC rejects Playwright's mocked socket, and the real
		// server refuses the fake ticket, which is the failure this test expects to see.
		const streamUrl = new Promise<string>((resolve) => {
			page.on('websocket', (ws) => {
				if (/\/api\/desktop\/stream/.test(ws.url())) resolve(ws.url())
			})
		})

		await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

		const url = new URL(await streamUrl)
		expect(url.pathname).toBe('/api/desktop/stream')
		expect(url.searchParams.get('ticket')).toBe('e2e-ticket')
		// The request names whose computer it is.
		expect(new URL(connectUrl).searchParams.get('agent_id')).toBe(agent.id)
		await expect(page.getByText("Couldn't open the desktop")).toBeVisible()
	})

	test('has no Desktop entry in the sidebar', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		await page.goto(`/${account.workspaceId}`)

		await expect(page.getByRole('link', { name: 'Chats' })).toBeVisible()
		await expect(page.getByRole('link', { name: 'Desktop' })).toHaveCount(0)
	})

	for (const scheme of ['light', 'dark'] as const) {
		test(`renders the section and its error state in ${scheme} mode`, async ({ page, account }) => {
			await page.emulateMedia({ colorScheme: scheme })
			const agent = await seedAgent(account)
			await listing(page, agent.id, 'running')
			await page.route(CONNECT, (route) =>
				route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }),
			)

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			await expect(page.getByRole('region', { name: 'Computer', exact: true })).toBeVisible()
			await expect(page.getByText("Couldn't open the desktop")).toBeVisible()
			await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible()
		})
	}
})
