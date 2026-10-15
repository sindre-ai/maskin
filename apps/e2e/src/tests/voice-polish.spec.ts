import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Voice v1 Task 4, second half (bet/16bd0042-voice-v1): the row-level Call
// button, the thread-header Call button, and the Mic-blocked / No-mic dialog
// states. The WebRTC call itself needs the OpenAI edge, so it is not driven
// here; session end (hangup, WS-drop grace, sweeper, cost, daily cap) is
// covered against real Postgres in
// apps/dev/src/__tests__/integration/voice-session-lifecycle.test.ts.
//
// `ff:voice-mode-v1` (see feature-flags.ts) beats the server response so the
// spec can flip both sides of the flag boundary without a second actor.

const GRANT = 'Allow microphone & start call'

async function flagOn(page: Page) {
	await page.addInitScript(() => {
		window.localStorage.setItem('ff:voice-mode-v1', 'on')
	})
}

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
		test(`voice-enabled rows get a Call button, others do not @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const voice = await account.api.createAgentActor('Vera Voice')
			await account.api.addWorkspaceMember(account.workspaceId, voice.id)
			await account.api.setActorVoiceMode(account.workspaceId, voice.id, true)
			const text = await account.api.createAgentActor('Tia Text')
			await account.api.addWorkspaceMember(account.workspaceId, text.id)
			await flagOn(page)

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
					.getByRole('button', { name: /^Call / }),
			).toHaveCount(0)

			// It is a sibling of the row link, not nested in it.
			await expect(voiceRow.getByRole('link').getByRole('button')).toHaveCount(0)
		})
	}

	test('hides the row Call button when the flag is off', async ({ page, account }) => {
		const voice = await account.api.createAgentActor('Vera Voice')
		await account.api.addWorkspaceMember(account.workspaceId, voice.id)
		await account.api.setActorVoiceMode(account.workspaceId, voice.id, true)
		await page.addInitScript(() => {
			window.localStorage.setItem('ff:voice-mode-v1', 'off')
		})

		await page.goto(`/${account.workspaceId}/agents`)
		await expect(page.getByRole('link').filter({ hasText: 'Vera Voice' })).toBeVisible({
			timeout: 10_000,
		})
		await expect(page.getByRole('button', { name: 'Call Vera Voice' })).toHaveCount(0)
	})

	test('a row Call button opens the permission dialog without navigating away', async ({
		page,
		account,
	}) => {
		const voice = await account.api.createAgentActor('Vera Voice')
		await account.api.addWorkspaceMember(account.workspaceId, voice.id)
		await account.api.setActorVoiceMode(account.workspaceId, voice.id, true)
		await flagOn(page)

		await page.goto(`/${account.workspaceId}/agents`)
		const row = page.getByRole('listitem').filter({ hasText: 'Vera Voice' })
		await row.hover()
		await row.getByRole('button', { name: 'Call Vera Voice' }).click()

		await expect(page.getByRole('button', { name: GRANT })).toBeVisible()
		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/agents$`))
	})
})

test.describe('Voice — thread-header Call button', () => {
	test('mounts for a thread with exactly one voice-enabled agent, and V opens the dialog', async ({
		page,
		account,
	}) => {
		const voice = await account.api.createAgentActor('Vera Voice')
		await account.api.addWorkspaceMember(account.workspaceId, voice.id)
		await account.api.setActorVoiceMode(account.workspaceId, voice.id, true)
		const text = await account.api.createAgentActor('Tia Text')
		await account.api.addWorkspaceMember(account.workspaceId, text.id)
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: 'Weekly check-in',
			participant_actor_ids: [voice.id, text.id],
		})
		await flagOn(page)

		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		const call = page.getByRole('button', { name: 'Call Vera Voice' })
		await expect(call).toBeVisible({ timeout: 10_000 })

		await page.locator('body').focus()
		await page.keyboard.press('v')
		await expect(page.getByRole('button', { name: GRANT })).toBeVisible()
	})

	test('does not mount when two voice-enabled agents share the thread', async ({
		page,
		account,
	}) => {
		const a = await account.api.createAgentActor('Vera Voice')
		const b = await account.api.createAgentActor('Vic Voice')
		for (const agent of [a, b]) {
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await account.api.setActorVoiceMode(account.workspaceId, agent.id, true)
		}
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: 'Two voices',
			participant_actor_ids: [a.id, b.id],
		})
		await flagOn(page)

		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		await expect(page.getByRole('heading', { name: /Two voices/ })).toBeVisible({
			timeout: 10_000,
		})
		await expect(page.getByRole('button', { name: /^Call / })).toHaveCount(0)
	})

	test('does not mount when the only agent is not voice-enabled', async ({ page, account }) => {
		const text = await account.api.createAgentActor('Tia Text')
		await account.api.addWorkspaceMember(account.workspaceId, text.id)
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: 'Text only',
			participant_actor_ids: [text.id],
		})
		await flagOn(page)

		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
		await expect(page.getByRole('heading', { name: /Text only/ })).toBeVisible({
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
			await flagOn(page)
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
			await flagOn(page)
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
		await flagOn(page)
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
