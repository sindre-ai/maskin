import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Voice v1 (bet/16bd0042-voice-v1): the browser half of a call whose tools run
// on the server. There is no real microphone, OpenAI edge or tool connection in
// CI, so the page's RTCPeerConnection and getUserMedia are replaced with
// in-page fakes and the voice routes are stubbed. What this covers is the app's
// own wiring: the offer goes to our server (never to the vendor), no browser
// WebSocket opens, the call's captions mirror what the agent says, the browser answers
// tool calls only when the server said it could not, and the post-call toast.

const SESSION_ID = '11111111-1111-4111-8111-111111111111'
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222'

declare global {
	interface Window {
		__voice: {
			dcSent: Array<Record<string, unknown>>
			sockets: string[]
			offerSdp: string | null
			fromRealtime: (evt: Record<string, unknown>) => void
		}
	}
}

async function installFakes(page: Page) {
	await page.addInitScript(() => {
		const voice = {
			dcSent: [] as Array<Record<string, unknown>>,
			sockets: [] as string[],
			offerSdp: null as string | null,
			dcListeners: [] as Array<(e: { data: string }) => void>,
			fromRealtime(evt: Record<string, unknown>) {
				for (const fn of this.dcListeners) fn({ data: JSON.stringify(evt) })
			},
		}
		;(window as unknown as { __voice: typeof voice }).__voice = voice

		Object.defineProperty(navigator, 'mediaDevices', {
			configurable: true,
			value: { getUserMedia: async () => new MediaStream() },
		})

		class FakeDataChannel {
			readyState = 'open'
			addEventListener(_: string, fn: (e: { data: string }) => void) {
				voice.dcListeners.push(fn)
			}
			send(raw: string) {
				voice.dcSent.push(JSON.parse(raw))
			}
			close() {}
		}
		class FakePeerConnection {
			iceConnectionState = 'connected'
			ontrack: unknown = null
			addTrack() {}
			addEventListener() {}
			createDataChannel() {
				return new FakeDataChannel()
			}
			async createOffer() {
				return { type: 'offer', sdp: 'v=0 browser offer' }
			}
			async setLocalDescription() {}
			async setRemoteDescription() {}
			close() {}
		}
		;(window as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = FakePeerConnection

		// Any browser WebSocket would be a regression: the tool channel is server side.
		const RealWebSocket = window.WebSocket
		;(window as unknown as { WebSocket: unknown }).WebSocket = class extends RealWebSocket {
			constructor(url: string | URL, protocols?: string | string[]) {
				voice.sockets.push(String(url))
				super(url, protocols)
			}
		}
	})
}

async function stubVoiceRoutes(page: Page, offer: { tools_available: boolean }) {
	await page.route('**/api/voice-sessions', (route) =>
		route.request().method() === 'POST'
			? route.fulfill({
					status: 201,
					contentType: 'application/json',
					body: JSON.stringify({ voice_session_id: SESSION_ID }),
				})
			: route.continue(),
	)
	await page.route(`**/api/voice-sessions/${SESSION_ID}/offer`, async (route) => {
		const { sdp } = route.request().postDataJSON() as { sdp: string }
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				sdp: `answer for ${sdp}`,
				tools_available: offer.tools_available,
				persist_transcripts: true,
			}),
		})
	})
	await page.route(`**/api/voice-sessions/${SESSION_ID}/hangup`, (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				voice_session_id: SESSION_ID,
				status: 'ended',
				ended_reason: 'user_hangup',
				ended_at: new Date().toISOString(),
				duration_ms: 1000,
				total_cost_usd: 0,
				conversation_id: CONVERSATION_ID,
			}),
		}),
	)
	// The vendor must never be reached from the browser.
	await page.route('https://api.openai.com/**', (route) => route.abort())
}

async function startCall(page: Page, workspaceId: string, agentId: string) {
	await page.goto(`/${workspaceId}/agents/${agentId}`)
	await page.getByRole('button', { name: /Call Vera Voice/ }).click()
	await page.getByRole('button', { name: 'Allow microphone & start call' }).click()
	// The call attaches its data-channel listener after the microphone prompt resolves; an event
	// sent before that goes nowhere and the call stays on "Starting the call".
	await page.waitForFunction(
		() => (window.__voice as unknown as { dcListeners: unknown[] }).dcListeners.length > 0,
	)
	await page.evaluate(() => window.__voice.fromRealtime({ type: 'session.created' }))
}

test.describe('Voice call: server-side tools, captions and post-call toast', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`hands the offer to our server, tags a tool call and toasts on end @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await account.api.createAgentActor('Vera Voice')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await installFakes(page)
			await stubVoiceRoutes(page, { tools_available: true })
			const offerRequest = page.waitForRequest(`**/api/voice-sessions/${SESSION_ID}/offer`)

			await startCall(page, account.workspaceId, agent.id)
			expect((await offerRequest).postDataJSON()).toEqual({
				sdp: 'v=0 browser offer',
				noise_reduction: expect.stringMatching(/^(near|far)_field$/),
			})

			// No greeting: once the call is ready it shows Listening until someone speaks.
			await expect(page.getByText('Listening').first()).toBeVisible()

			// Model asks for a tool: nothing goes from the browser into the session
			// (the server answers on its own connection).
			await page.evaluate(() =>
				window.__voice.fromRealtime({
					type: 'response.function_call_arguments.done',
					call_id: 'call_1',
					name: 'search_objects',
					arguments: JSON.stringify({ q: 'loops v4 bet' }),
				}),
			)
			expect(await page.evaluate(() => window.__voice.dcSent)).toEqual([])

			// The agent's finished turn is the call's caption. The inline live
			// transcript pane is gone: captions replace it.
			await expect(page.getByRole('button', { name: 'Show transcript' })).toHaveCount(0)
			await page.evaluate(() =>
				window.__voice.fromRealtime({
					type: 'response.output_audio_transcript.done',
					transcript: 'Top hit is Loops v4.',
				}),
			)
			await expect(page.getByText('Top hit is Loops v4.')).toBeVisible()
			await page.getByRole('button', { name: 'Hide captions' }).click()
			await expect(page.getByText('Top hit is Loops v4.')).toHaveCount(0)
			await page.getByRole('button', { name: 'Show captions' }).click()

			// No browser WebSocket, ever.
			expect(await page.evaluate(() => window.__voice.sockets)).toEqual([])

			// The hangup names the saved conversation; the toast links to it.
			await page.getByRole('button', { name: 'End call' }).click()
			await expect(page.getByText(/^Voice call ended · /)).toBeVisible()
			await expect(
				page.getByText('Transcript saved to your chat with Vera Voice.', { exact: true }),
			).toBeVisible()
			await page.getByRole('button', { name: 'Open', exact: true }).click()
			await expect(page).toHaveURL(new RegExp(`/chats/${CONVERSATION_ID}$`))
		})
	}

	for (const width of [768, 1024]) {
		test(`keeps the thread at least 360px wide beside the call panel @ ${width}px`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width, height: 900 })
			const agent = await account.api.createAgentActor('Vera Voice')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			const conversation = await account.api.createConversation(account.workspaceId, {
				title: 'E2E call layout',
				participant_actor_ids: [agent.id],
				initial_message: 'Opening the thread',
			})
			await installFakes(page)
			await stubVoiceRoutes(page, { tools_available: true })

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const thread = page.getByTestId('thread-messages')
			await expect(thread).toBeVisible({ timeout: 10_000 })
			await page.getByRole('button', { name: /Call Vera Voice/ }).click()
			await page.getByRole('button', { name: 'Allow microphone & start call' }).click()
			await page.waitForFunction(
				() => (window.__voice as unknown as { dcListeners: unknown[] }).dcListeners.length > 0,
			)
			await page.evaluate(() => window.__voice.fromRealtime({ type: 'session.created' }))

			const panel = page.getByRole('complementary', { name: 'Call with Vera Voice' })
			await expect(panel).toBeVisible()
			// The sidebar folds to its icon rail and the list steps aside, so the
			// thread keeps its room.
			await expect
				.poll(async () => (await thread.boundingBox())?.width ?? 0)
				.toBeGreaterThanOrEqual(360)
			const panelBox = await panel.boundingBox()
			expect(panelBox?.width).toBe(width >= 1024 ? 340 : 300)

			await page.getByRole('button', { name: 'End call' }).click()
			await expect(panel).toHaveCount(0)
		})
	}

	test('tells the model tools are unavailable when the server could not attach its connection', async ({
		page,
		account,
	}) => {
		const agent = await account.api.createAgentActor('Vera Voice')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		await installFakes(page)
		await stubVoiceRoutes(page, { tools_available: false })

		await startCall(page, account.workspaceId, agent.id)
		await page.evaluate(() =>
			window.__voice.fromRealtime({
				type: 'response.function_call_arguments.done',
				call_id: 'call_9',
				name: 'get_objects',
				arguments: '{}',
			}),
		)

		const sent = await page.evaluate(() => window.__voice.dcSent)
		expect(sent).toHaveLength(2)
		expect(JSON.stringify(sent[0])).toContain('voice_channel_unavailable')
		expect(sent[1]).toEqual({ type: 'response.create' })
	})
})
