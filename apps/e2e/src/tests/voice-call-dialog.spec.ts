import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Voice v1 Task 2 (bet/16bd0042-voice-v1). This spec covers the parts of the
// UI that don't require Task 1's session-mint route to be deployed — the flag
// gate on the detail header, the Permission state's verbatim copy, keyboard
// shortcuts, and Esc dismissal. Live / Connecting / Reconnecting states need
// the WebRTC handshake, so they live in Task 3's E2E once Task 1 has landed.
//
// The `ff:voice-mode-v1` localStorage override (see feature-flags.ts) beats
// the server response so the spec can flip both sides of the flag boundary
// without provisioning a second actor.

test.describe('Voice call dialog — Permission state and flag boundary', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`hides the Call button when the flag is off @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agent = await account.api.createAgentActor('Vera Voice')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			// Explicitly turn the flag OFF via the override — even though the CI
			// default is off, the override immunises the spec from a future default
			// flip.
			await page.addInitScript(() => {
				window.localStorage.setItem('ff:voice-mode-v1', 'off')
			})

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
			await expect(page.getByRole('heading', { name: 'Vera Voice' })).toBeVisible({
				timeout: 10_000,
			})
			await expect(page.getByRole('button', { name: /Call Vera Voice/ })).toHaveCount(0)
		})

		test(`shows the Call button and opens the Permission state @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agent = await account.api.createAgentActor('Vera Voice')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			await page.addInitScript(() => {
				window.localStorage.setItem('ff:voice-mode-v1', 'on')
			})

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			const callButton = page.getByRole('button', { name: /Call Vera Voice/ })
			await expect(callButton).toBeVisible({ timeout: 10_000 })

			// Both colour schemes render the primary action.
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(callButton).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })

			await callButton.click()

			// Verbatim copy per SPEC §Copy — a string not listed there is a bug.
			await expect(page.getByText('Call Vera Voice', { exact: true })).toBeVisible()
			await expect(
				page.getByText(
					'Your microphone will only be used while this call is running. Transcript saves to this workspace.',
					{ exact: true },
				),
			).toBeVisible()
			await expect(
				page.getByRole('button', { name: 'Allow microphone & start call' }),
			).toBeVisible()
			await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible()

			// Esc ends the call — Permission → dialog dismisses.
			await page.keyboard.press('Escape')
			await expect(page.getByRole('button', { name: 'Allow microphone & start call' })).toHaveCount(
				0,
			)
		})
	}

	test('V opens the dialog when the agent detail is focused', async ({ page, account }) => {
		const agent = await account.api.createAgentActor('Vera Voice')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)

		await page.addInitScript(() => {
			window.localStorage.setItem('ff:voice-mode-v1', 'on')
		})

		await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
		await expect(page.getByRole('button', { name: /Call Vera Voice/ })).toBeVisible({
			timeout: 10_000,
		})

		// Focus lives on the body — no input field is active — so V should fire
		// the shortcut, not type into a text field.
		await page.locator('body').focus()
		await page.keyboard.press('v')

		await expect(page.getByRole('button', { name: 'Allow microphone & start call' })).toBeVisible()
	})
})
