import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Voice v1 Task 4, second half (bet/16bd0042-voice-v1): the row-level Call
// button, the thread-header Call button, and the Mic-blocked / No-mic dialog
// states. The WebRTC call itself needs the OpenAI edge, so it is not driven
// here; session end (hangup, WS-drop grace, sweeper, cost, daily cap) is
// covered against real Postgres in
// apps/dev/src/__tests__/integration/voice-session-lifecycle.test.ts.

const GRANT = 'Allow microphone & start call'

/** Makes getUserMedia fail the way a real browser does, by DOMException name. */
async function failMicWith(page: Page, name: 'NotAllowedError' | 'NotFoundError') {
	await page.addInitScript((errName) => {
		Object.defineProperty(navigator, 'mediaDevices', {
			configurable: true,
			value: {
				getUserMedia: async () => {
					throw new DOMException('mic', errName)
				},
				enumerateDevices: async () => [],
			},
		})
	}, name)
}

test.describe('Voice — row-level Call button', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`every agent row gets a Call button @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const voice = await account.api.createAgentActor('Vera Voice')
			await account.api.addWorkspaceMember(account.workspaceId, voice.id)
			const text = await account.api.createAgentActor('Tia Text')
			await account.api.addWorkspaceMember(account.workspaceId, text.id)

			await page.goto(`/${account.workspaceId}/agents`)
			const voiceRow = page.getByRole('listitem').filter({ hasText: 'Vera Voice' })
			await expect(voiceRow).toBeVisible({ timeout: 10_000 })

			const call = voiceRow.getByRole('button', { name: 'Call Vera Voice' })
			if (vp.width >= 768) {
				// Desktop / tablet: hover-reveal. It is in the DOM, and hovering the
				// row brings it to full opacity.
				await voiceRow.hover()
				await expect(call).toHaveCSS('opacity', '1')
			} else {
				// Mobile has no hover, so the button is plain inline at full opacity.
				await expect(call).toBeVisible()
				await expect(call).toHaveCSS('opacity', '1')
			}

			await expect(
				page
					.getByRole('listitem')
					.filter({ hasText: 'Tia Text' })
					.getByRole('button', { name: 'Call Tia Text' }),
			).toHaveCount(1)

			// It is a sibling of the row link, not nested in it.
			await expect(voiceRow.getByRole('link').getByRole('button')).toHaveCount(0)
		})
	}

	test('a row Call button opens the permission dialog without navigating away', async ({
		page,
		account,
	}) => {
		const voice = await account.api.createAgentActor('Vera Voice')
		await account.api.addWorkspaceMember(account.workspaceId, voice.id)

		await page.goto(`/${account.workspaceId}/agents`)
		const row = page.getByRole('listitem').filter({ hasText: 'Vera Voice' })
		await row.hover()
		await row.getByRole('button', { name: 'Call Vera Voice' }).click()

		await expect(page.getByRole('button', { name: GRANT })).toBeVisible()
		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/agents$`))
	})

	test('the call stays open when the user navigates to another page', async ({ page, account }) => {
		const voice = await account.api.createAgentActor('Vera Voice')
		await account.api.addWorkspaceMember(account.workspaceId, voice.id)

		await page.goto(`/${account.workspaceId}/agents`)
		const row = page.getByRole('listitem').filter({ hasText: 'Vera Voice' })
		await row.hover()
		await row.getByRole('button', { name: 'Call Vera Voice' }).click()
		const dialog = page.getByRole('dialog', { name: 'Call Vera Voice' })
		await expect(dialog).toBeVisible()

		// Client-side navigation (a full page.goto would reload and end the call):
		// the dialog must survive it and must not block the page behind it.
		await page.getByRole('link', { name: 'Objects' }).first().click()
		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/objects`))
		await expect(dialog).toBeVisible()
	})
})

test.describe('Voice — thread-header Call button', () => {
	test('mounts for a thread with exactly one agent, and V opens the dialog', async ({
		page,
		account,
	}) => {
		const voice = await account.api.createAgentActor('Vera Voice')
		await account.api.addWorkspaceMember(account.workspaceId, voice.id)
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: 'Weekly check-in',
			participant_actor_ids: [voice.id],
		})

		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const call = page.getByRole('button', { name: 'Call Vera Voice' })
		await expect(call).toBeVisible({ timeout: 10_000 })

		await page.locator('body').focus()
		await page.keyboard.press('v')
		await expect(page.getByRole('button', { name: GRANT })).toBeVisible()
	})

	test('does not mount when two agents share the thread', async ({ page, account }) => {
		const a = await account.api.createAgentActor('Vera Voice')
		const b = await account.api.createAgentActor('Vic Voice')
		for (const agent of [a, b]) {
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		}
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: 'Two voices',
			participant_actor_ids: [a.id, b.id],
		})

		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		await expect(page.getByRole('heading', { name: /Two voices/ })).toBeVisible({
			timeout: 10_000,
		})
		await expect(page.getByRole('button', { name: /^Call / })).toHaveCount(0)
	})
})

test.describe('Voice — Mic-blocked and No-mic dialog states', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`a denied microphone opens the Mic-blocked state @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await account.api.createAgentActor('Vera Voice')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await failMicWith(page, 'NotAllowedError')

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
			await page.getByRole('button', { name: /Call Vera Voice/ }).click()
			await page.getByRole('button', { name: GRANT }).click()

			await expect(page.getByRole('heading', { name: 'Microphone blocked' })).toBeVisible()
			await expect(
				page.getByText(
					"Enable microphone access in your browser's site settings, then try again.",
					{ exact: true },
				),
			).toBeVisible()
			const help = page.getByRole('link', { name: /How to enable →/ })
			await expect(help).toBeVisible()
			await expect(help).toHaveAttribute('target', '_blank')
			await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible()

			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(page.getByRole('heading', { name: 'Microphone blocked' })).toBeVisible()
			}
		})

		test(`a missing microphone opens the No-mic state with a Retry @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await account.api.createAgentActor('Vera Voice')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await failMicWith(page, 'NotFoundError')

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
			await page.getByRole('button', { name: /Call Vera Voice/ }).click()
			await page.getByRole('button', { name: GRANT }).click()

			await expect(page.getByRole('heading', { name: 'No microphone found' })).toBeVisible()
			await expect(
				page.getByText(
					'Connect a microphone (or check that headphones with a mic are plugged in), then try again.',
					{ exact: true },
				),
			).toBeVisible()
			// Retry re-enumerates devices; with none present the state holds.
			await page.getByRole('button', { name: 'Retry' }).click()
			await expect(page.getByRole('heading', { name: 'No microphone found' })).toBeVisible()
		})
	}

	test('reduced motion: the error states render no animation', async ({ page, account }) => {
		const agent = await account.api.createAgentActor('Vera Voice')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		await failMicWith(page, 'NotAllowedError')
		await page.emulateMedia({ reducedMotion: 'reduce' })

		await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
		await page.getByRole('button', { name: /Call Vera Voice/ }).click()
		await page.getByRole('button', { name: GRANT }).click()

		await expect(page.getByRole('heading', { name: 'Microphone blocked' })).toBeVisible()
		// The status circle carries no speaking-ring / breathing animation class.
		await expect(page.locator('.speaking-ring, .voice-level')).toHaveCount(0)
	})
})
