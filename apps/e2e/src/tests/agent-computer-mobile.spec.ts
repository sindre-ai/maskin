import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { openAgentTab } from '../helpers/agent-tab.helper'
import { type FakeVnc, attachFakeVnc } from '../helpers/fake-vnc'

/**
 * An agent's computer on a phone: the popup runs edge to edge so the picture uses the whole
 * width, and while in control a tap raises the phone keyboard and what is typed reaches the
 * computer. Like agent-computer.spec.ts the computer itself is faked at the network edges
 * (the list and connect calls, and a WebSocket that speaks just enough VNC for noVNC to report
 * "connected" and to record the key presses it is sent).
 */

const PHONE = { width: 390, height: 844 }

test.use({ viewport: PHONE, hasTouch: true, isMobile: true })

const KEY_H = 0x48
const KEY_I = 0x69
const KEY_SPACE = 0x20
const KEY_1 = 0x31
const KEY_BACKSPACE = 0xff08
const KEY_RETURN = 0xff0d

async function seedRunningComputer(
	page: Page,
	account: {
		workspaceId: string
		api: {
			createAgentActor: (name: string) => Promise<{ id: string }>
			addWorkspaceMember: (workspaceId: string, actorId: string) => Promise<unknown>
		}
	},
) {
	const agent = await account.api.createAgentActor(`Phone computer ${Date.now()}`)
	await account.api.addWorkspaceMember(account.workspaceId, agent.id)
	await page.route(/\/api\/desktop$/, (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ desktops: [{ agent_id: agent.id, status: 'running' }] }),
		}),
	)
	await page.route(/\/api\/desktop\/connect/, (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ ticket: 't', path: '/api/desktop/stream', password: 'pw' }),
		}),
	)
	return agent
}

test.describe("An agent's computer on a phone", () => {
	let vnc: FakeVnc | null = null
	test.afterEach(async () => {
		await vnc?.close()
		vnc = null
	})

	test('fills the width of the screen and takes typing once in control', async ({
		page,
		account,
	}) => {
		const agent = await seedRunningComputer(page, account)
		vnc = await attachFakeVnc(page)

		await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
		// The computer is its own tab on the agent page.
		await openAgentTab(page, 'computer')
		await page.getByRole('button', { name: 'Open computer in a popup' }).tap()

		const dialog = page.getByRole('dialog')
		const takeControl = dialog.getByRole('button', { name: 'Take over' })
		await expect(takeControl).toBeVisible({ timeout: 20_000 })

		// The picture runs edge to edge: the full width of the phone, not a padded card.
		const canvas = dialog.locator('canvas')
		await expect(canvas).toBeVisible()
		const box = await canvas.boundingBox()
		if (!box) throw new Error('picture not laid out')
		expect(box.width).toBeGreaterThanOrEqual(PHONE.width - 1)
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			),
		).toBeLessThanOrEqual(0)
		// The controls do not push the popup wider than the screen.
		const popup = await dialog.boundingBox()
		expect(popup?.width).toBeLessThanOrEqual(PHONE.width)

		// Watching only: no keyboard to raise yet.
		await expect(dialog.getByLabel('Type on the computer')).toHaveCount(0)
		await takeControl.tap()
		await expect(dialog.getByText("You're in control")).toBeVisible()

		// A tap on the picture raises the keyboard (focuses the field that holds it up).
		const keyboardField = dialog.getByLabel('Type on the computer')
		await expect(keyboardField).toHaveCount(1)
		await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
		await expect(keyboardField).toBeFocused()

		// What is typed goes to the computer as key presses.
		await page.keyboard.type('Hi 1')
		await page.keyboard.press('Backspace')
		await page.keyboard.press('Enter')
		await expect
			.poll(() => vnc?.keys)
			.toEqual([KEY_H, KEY_I, KEY_SPACE, KEY_1, KEY_BACKSPACE, KEY_RETURN])

		// Hide keyboard puts it away, and a tap on the picture does not bring it back.
		await dialog.getByRole('button', { name: 'Hide keyboard' }).tap()
		await expect(keyboardField).not.toBeFocused()
		await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
		await expect(keyboardField).not.toBeFocused()

		// Show keyboard brings it back.
		await dialog.getByRole('button', { name: 'Show keyboard' }).tap()
		await expect(keyboardField).toBeFocused()
	})
})
