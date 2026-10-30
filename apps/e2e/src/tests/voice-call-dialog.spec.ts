import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Voice v1 Task 2 (bet/16bd0042-voice-v1). This spec covers the parts of the
// UI that don't require Task 1's session-mint route to be deployed — the
// Permission state's verbatim copy, keyboard
// shortcuts, and Esc dismissal. Live / Connecting / Reconnecting states need
// the WebRTC handshake, so they live in Task 3's E2E once Task 1 has landed.

test.describe('Voice call dialog — Permission state', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`shows the Call button and opens the Permission state @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agent = await account.api.createAgentActor('Vera Voice')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

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
			await expect(page.getByRole('heading', { name: 'Call Vera Voice' })).toBeVisible()
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

// The WebRTC answer needs the OpenAI edge, so the offer route is intercepted:
// this asserts what the browser asks the mic for and what it posts, not that
// audio flows.
test.describe('Voice call dialog — mic constraints and offer body', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`asks for processed mono audio and posts noise_reduction @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await page.addInitScript(() => {
				const w = window as unknown as { __micConstraints?: unknown }
				Object.defineProperty(navigator, 'mediaDevices', {
					configurable: true,
					value: {
						getUserMedia: async (constraints: unknown) => {
							w.__micConstraints = constraints
							const ctx = new AudioContext()
							return ctx.createMediaStreamDestination().stream
						},
						enumerateDevices: async () => [{ kind: 'audioinput' }],
					},
				})
			})
			await page.route('**/api/voice-sessions', (route) =>
				route.request().method() === 'POST'
					? route.fulfill({ json: { voice_session_id: 'e2e-voice-session' } })
					: route.fallback(),
			)
			await page.route('**/api/voice-sessions/*/hangup', (route) => route.fulfill({ json: {} }))
			const offerBody = new Promise<{ sdp: string; noise_reduction?: string }>((resolve) => {
				void page.route('**/api/voice-sessions/*/offer', (route) => {
					resolve(route.request().postDataJSON())
					return route.fulfill({ status: 502, json: { error: 'e2e: no vendor' } })
				})
			})

			const agent = await account.api.createAgentActor('Vera Voice')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
			await page.getByRole('button', { name: /Call Vera Voice/ }).click()
			await page.getByRole('button', { name: 'Allow microphone & start call' }).click()

			const body = await offerBody
			expect(body.sdp.length).toBeGreaterThan(0)
			expect(['near_field', 'far_field']).toContain(body.noise_reduction)
			expect(
				await page.evaluate(
					() => (window as never as { __micConstraints: unknown }).__micConstraints,
				),
			).toEqual({
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					autoGainControl: true,
					channelCount: 1,
				},
			})
		})
	}
})
