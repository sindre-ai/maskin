import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { type FakeVnc, attachFakeVnc } from '../helpers/fake-vnc'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * E2E coverage for "Teach a task" on an agent's computer (the Computer section of
 * the agent page).
 *
 * The Teach button only exists once the stream is live, so the VNC server is
 * faked at the WebSocket: it answers the RFB 3.8 handshake (no-auth security, a
 * 1280x720 ServerInit), which is enough for noVNC to report "connected". The
 * connect ticket and the teach endpoint are faked at the network edge too. What
 * this proves is the recorder and the page: a real canvas, real pointer and key
 * events, a real JPEG still, and the request the browser actually sends.
 */

const AGENT_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_AGENT_ID = '33333333-3333-4333-8333-333333333333'

const LIST_URL = /\/api\/desktop$/
const CONNECT_URL = /\/api\/desktop\/connect/

type Seeded = { id: string; name: string }

// A real agent in the account's workspace, so its page loads from the backend.
async function seedAgent(account: {
	workspaceId: string
	api: {
		createAgentActor: (n: string) => Promise<{ id: string }>
		addWorkspaceMember: (w: string, a: string) => Promise<unknown>
	}
}): Promise<Seeded> {
	const name = `Computer owner ${Date.now()}`
	const agent = await account.api.createAgentActor(name)
	await account.api.addWorkspaceMember(account.workspaceId, agent.id)
	return { id: agent.id, name }
}

async function fakeBackend(page: Page, viewed: Seeded) {
	// Already running, so the page connects without a click.
	await page.route(LIST_URL, (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ desktops: [{ agent_id: viewed.id, status: 'running' }] }),
		}),
	)
	await page.route(CONNECT_URL, (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ticket: 't', path: '/api/desktop/stream', password: 'pw' }),
		}),
	)
	await page.route('**/api/actors', (route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		const now = new Date().toISOString()
		const agent = (id: string, name: string) => ({
			id,
			type: 'agent',
			name,
			email: null,
			created_at: now,
			updated_at: now,
		})
		return route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify([
				agent(viewed.id, viewed.name),
				agent(AGENT_ID, 'Chief of Staff'),
				agent(OTHER_AGENT_ID, 'Researcher'),
			]),
		})
	})
}

async function expectNoHorizontalOverflow(page: Page) {
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
	)
	expect(overflow).toBeLessThanOrEqual(0)
}

// Skipped while "Teach a task" is switched off in the desktop viewer.
test.describe.skip('Teach a task on the desktop', () => {
	let vnc: FakeVnc | null = null
	test.afterEach(async () => {
		await vnc?.close()
		vnc = null
	})

	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`records a demonstration and sends it to the chosen agent at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const viewed = await seedAgent(account)
			await fakeBackend(page, viewed)
			vnc = await attachFakeVnc(page)
			let sent: Record<string, unknown> | null = null
			await page.route('**/api/desktop/teach', async (route) => {
				sent = route.request().postDataJSON()
				await route.fulfill({
					status: 201,
					contentType: 'application/json',
					body: JSON.stringify({
						recording_id: 'abcdef123456',
						session_id: '55555555-5555-4555-8555-555555555555',
						agent_id: AGENT_ID,
						frames_stored: 2,
						events_stored: 2,
					}),
				})
			})

			await page.goto(`/${account.workspaceId}/agents/${viewed.id}`)
			await expect(page.getByText('Live')).toBeVisible()
			await expectNoHorizontalOverflow(page)

			// Open the dialog; the button is reachable at every width.
			await page.getByRole('button', { name: 'Teach a task' }).click()
			const dialog = page.getByRole('dialog')
			await expect(dialog.getByText('Teach a task')).toBeVisible()
			const start = dialog.getByRole('button', { name: 'Start recording' })
			await expect(start).toBeDisabled()
			await expect(start).toBeInViewport()
			await expectNoHorizontalOverflow(page)

			// Pick the agent explicitly and describe the task.
			await dialog.getByRole('combobox', { name: /which agent/i }).click()
			await page.getByRole('option', { name: 'Researcher' }).click()
			await dialog.getByLabel('What are you about to show?').fill('Export the weekly report to PDF')
			await start.click()

			// Recording: header chip, a Stop button, and the frame is ringed.
			await expect(page.getByText(/^Recording · \d+:\d\d · teaching Researcher$/)).toBeVisible()
			await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible()
			await expectNoHorizontalOverflow(page)

			// Demonstrate: a click on the desktop, then typing.
			const canvas = page.locator('canvas').first()
			await canvas.click({ position: { x: 40, y: 30 } })
			await page.keyboard.type('hello')
			await page.keyboard.press('Control+l')

			await page.getByRole('button', { name: 'Stop recording' }).click()

			await expect(page.getByText('Researcher is learning this task')).toBeVisible()
			expect(sent).not.toBeNull()
			const body = sent as unknown as {
				agent_id: string
				description: string
				events: Array<Record<string, unknown>>
				frames: Array<{ id: string; data_base64: string }>
				final_frame?: string
			}
			expect(body.agent_id).toBe(OTHER_AGENT_ID)
			expect(body.description).toBe('Export the weekly report to PDF')
			expect(body.events.map((e) => e.type)).toEqual(['click', 'type', 'key'])
			expect(body.events[0]).toMatchObject({ type: 'click', button: 'left' })
			expect(body.events[1]).toMatchObject({ type: 'type', text: 'hello' })
			expect(body.events[2]).toMatchObject({ type: 'key', keys: 'ctrl+l' })
			// Stills are real JPEGs (base64 of the FFD8FF magic starts "/9j/").
			expect(body.frames.length).toBeGreaterThanOrEqual(2)
			for (const f of body.frames) expect(f.data_base64.startsWith('/9j/')).toBe(true)
			expect(body.final_frame).toBeTruthy()

			// Back to normal afterwards.
			await expect(page.getByRole('button', { name: 'Teach a task' })).toBeVisible()
			await expectNoHorizontalOverflow(page)
		})
	}

	test('does not send anything when nothing was demonstrated', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		const viewed = await seedAgent(account)
		await fakeBackend(page, viewed)
		vnc = await attachFakeVnc(page)
		let teachCalls = 0
		await page.route('**/api/desktop/teach', async (route) => {
			teachCalls += 1
			await route.abort()
		})

		await page.goto(`/${account.workspaceId}/agents/${viewed.id}`)
		await expect(page.getByText('Live')).toBeVisible()
		await page.getByRole('button', { name: 'Teach a task' }).click()
		await page.getByLabel('What are you about to show?').fill('Nothing really')
		await page.getByRole('button', { name: 'Start recording' }).click()
		await page.getByRole('button', { name: 'Stop recording' }).click()

		await expect(page.getByText('Nothing was recorded')).toBeVisible()
		expect(teachCalls).toBe(0)
	})

	for (const scheme of ['light', 'dark'] as const) {
		test(`shows the recording state in ${scheme} mode`, async ({ page, account }) => {
			await page.emulateMedia({ colorScheme: scheme })
			const viewed = await seedAgent(account)
			await fakeBackend(page, viewed)
			vnc = await attachFakeVnc(page)

			await page.goto(`/${account.workspaceId}/agents/${viewed.id}`)
			await expect(page.getByText('Live')).toBeVisible()
			await page.getByRole('button', { name: 'Teach a task' }).click()
			await page.getByLabel('What are you about to show?').fill('Show something')
			await page.getByRole('button', { name: 'Start recording' }).click()

			await expect(page.getByText(/^Recording · /)).toBeVisible()
			await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible()
		})
	}
})
