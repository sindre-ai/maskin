import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Voice v1 Task 3 (bet/16bd0042-voice-v1): the browser half of the tool
// round-trip and the post-call toast. There is no real microphone, OpenAI edge
// or upgrade ticket in CI, so the page's RTCPeerConnection, getUserMedia and
// WebSocket are replaced with in-page fakes that record what the app sends and
// let the spec push what the Realtime session / Maskin server would. What this
// covers is the app's own wiring: DataChannel → WebSocket forwarding, the
// result relayed back to the model, the transcript pane, and the toast.

declare global {
	interface Window {
		__voice: {
			dcSent: Array<Record<string, unknown>>
			wsSent: Array<Record<string, unknown>>
			wsUrl: string | null
			fromRealtime: (evt: Record<string, unknown>) => void
			fromServer: (msg: Record<string, unknown>) => void
		}
	}
}

test.describe('Voice call: tool round-trip, transcript and post-call toast', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`forwards a tool call, relays the result and toasts on end @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agent = await account.api.createAgentActor('Vera Voice')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			await page.addInitScript(() => {
				window.localStorage.setItem('ff:voice-mode-v1', 'on')

				const voice = {
					dcSent: [] as Array<Record<string, unknown>>,
					wsSent: [] as Array<Record<string, unknown>>,
					wsUrl: null as string | null,
					dcListeners: [] as Array<(e: { data: string }) => void>,
					ws: null as null | { onmessage: ((e: { data: string }) => void) | null },
					fromRealtime(evt: Record<string, unknown>) {
						for (const fn of this.dcListeners) fn({ data: JSON.stringify(evt) })
					},
					fromServer(msg: Record<string, unknown>) {
						this.ws?.onmessage?.({ data: JSON.stringify(msg) })
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
						return { type: 'offer', sdp: 'v=0' }
					}
					async setLocalDescription() {}
					async setRemoteDescription() {}
					close() {}
				}
				;(window as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
					FakePeerConnection

				class FakeWebSocket {
					readyState = 1
					onopen: ((e: unknown) => void) | null = null
					onmessage: ((e: { data: string }) => void) | null = null
					onclose: ((e: unknown) => void) | null = null
					onerror: ((e: unknown) => void) | null = null
					constructor(url: string) {
						voice.wsUrl = url
						voice.ws = this
					}
					send(raw: string) {
						voice.wsSent.push(JSON.parse(raw))
					}
					close() {}
				}
				;(window as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket
			})

			await page.route('**/api/voice-sessions', (route) =>
				route.request().method() === 'POST'
					? route.fulfill({
							status: 201,
							contentType: 'application/json',
							body: JSON.stringify({
								voice_session_id: '11111111-1111-4111-8111-111111111111',
								client_secret: 'ek_test',
								expires_at: '2099-01-01T00:00:00.000Z',
								ws_url: 'wss://api.openai.com/v1/realtime',
							}),
						})
					: route.continue(),
			)
			await page.route('https://api.openai.com/v1/realtime**', (route) =>
				route.fulfill({ status: 201, contentType: 'application/sdp', body: 'v=0' }),
			)

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
			await page.getByRole('button', { name: /Call Vera Voice/ }).click()
			await page.getByRole('button', { name: 'Allow microphone & start call' }).click()

			// The app opens the per-session control channel for the minted session.
			await expect
				.poll(() => page.evaluate(() => window.__voice.wsUrl))
				.toMatch(/\/api\/voice-sessions\/11111111-1111-4111-8111-111111111111\/events$/)

			await page.evaluate(() => window.__voice.fromRealtime({ type: 'session.created' }))
			await page.getByRole('button', { name: 'Show transcript' }).click()

			// 1. Model asks for a tool → frame to the server, mono tag in the pane.
			await page.evaluate(() =>
				window.__voice.fromRealtime({
					type: 'response.function_call_arguments.done',
					call_id: 'call_1',
					name: 'search_objects',
					arguments: JSON.stringify({ query: 'loops v4 bet' }),
				}),
			)
			await expect(page.getByText('searching for loops v4 bet…')).toBeVisible()
			expect(await page.evaluate(() => window.__voice.wsSent)).toEqual([
				{
					type: 'tool_call',
					call_id: 'call_1',
					name: 'search_objects',
					arguments: JSON.stringify({ query: 'loops v4 bet' }),
				},
			])

			// 2. Server answers → result goes back into the Realtime session and the
			// model is told to speak it.
			const event = {
				type: 'conversation.item.create',
				item: { type: 'function_call_output', call_id: 'call_1', output: 'Loops v4' },
			}
			await page.evaluate(
				(e) =>
					window.__voice.fromServer({
						type: 'tool_result',
						call_id: 'call_1',
						name: 'search_objects',
						ok: true,
						error_code: null,
						event: e,
					}),
				event,
			)
			expect(await page.evaluate(() => window.__voice.dcSent)).toEqual([
				event,
				{ type: 'response.create' },
			])

			// 3. A finished user turn is persisted and shown.
			await page.evaluate(() =>
				window.__voice.fromRealtime({
					type: 'conversation.item.input_audio_transcription.completed',
					transcript: 'search for the loops v4 bet',
				}),
			)
			await expect(page.getByText('search for the loops v4 bet', { exact: false })).toBeVisible()
			expect(await page.evaluate(() => window.__voice.wsSent.at(-1))).toEqual({
				type: 'transcript',
				role: 'user',
				text: 'search for the loops v4 bet',
			})

			// 4. Server reports the conversation; ending the call toasts with a link.
			await page.evaluate(() => {
				window.__voice.fromServer({
					type: 'ready',
					persist_transcripts: true,
					conversation_id: null,
				})
				window.__voice.fromServer({
					type: 'conversation',
					conversation_id: '22222222-2222-4222-8222-222222222222',
				})
			})
			await page.getByRole('button', { name: 'End call' }).click()

			await expect(page.getByText(/^Voice call ended · /)).toBeVisible()
			await expect(
				page.getByText('Transcript saved to your chat with Vera Voice.', { exact: true }),
			).toBeVisible()
			await page.getByRole('button', { name: 'Open', exact: true }).click()
			await expect(page).toHaveURL(/\/chats\/22222222-2222-4222-8222-222222222222$/)
		})
	}

	test('answers the model with an error when the control channel dies mid-call', async ({
		page,
		account,
	}) => {
		const agent = await account.api.createAgentActor('Vera Voice')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)

		await page.addInitScript(() => {
			window.localStorage.setItem('ff:voice-mode-v1', 'on')
			const voice = {
				dcSent: [] as Array<Record<string, unknown>>,
				wsSent: [] as Array<Record<string, unknown>>,
				dcListeners: [] as Array<(e: { data: string }) => void>,
				ws: null as null | { onclose: ((e: unknown) => void) | null },
				fromRealtime(evt: Record<string, unknown>) {
					for (const fn of this.dcListeners) fn({ data: JSON.stringify(evt) })
				},
				killSocket() {
					this.ws?.onclose?.({})
				},
			}
			;(window as unknown as { __voice: typeof voice }).__voice = voice
			Object.defineProperty(navigator, 'mediaDevices', {
				configurable: true,
				value: { getUserMedia: async () => new MediaStream() },
			})
			;(window as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = class {
				iceConnectionState = 'connected'
				addTrack() {}
				addEventListener() {}
				createDataChannel() {
					return {
						readyState: 'open',
						addEventListener: (_: string, fn: (e: { data: string }) => void) =>
							voice.dcListeners.push(fn),
						send: (raw: string) => voice.dcSent.push(JSON.parse(raw)),
						close() {},
					}
				}
				async createOffer() {
					return { type: 'offer', sdp: 'v=0' }
				}
				async setLocalDescription() {}
				async setRemoteDescription() {}
				close() {}
			}
			;(window as unknown as { WebSocket: unknown }).WebSocket = class {
				readyState = 1
				onopen = null
				onmessage = null
				onclose: ((e: unknown) => void) | null = null
				onerror = null
				constructor() {
					voice.ws = this
				}
				send(raw: string) {
					voice.wsSent.push(JSON.parse(raw))
				}
				close() {}
			}
		})
		await page.route('**/api/voice-sessions', (route) =>
			route.request().method() === 'POST'
				? route.fulfill({
						status: 201,
						contentType: 'application/json',
						body: JSON.stringify({
							voice_session_id: '11111111-1111-4111-8111-111111111111',
							client_secret: 'ek_test',
							expires_at: '2099-01-01T00:00:00.000Z',
							ws_url: 'wss://api.openai.com/v1/realtime',
						}),
					})
				: route.continue(),
		)
		await page.route('https://api.openai.com/v1/realtime**', (route) =>
			route.fulfill({ status: 201, contentType: 'application/sdp', body: 'v=0' }),
		)

		await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
		await page.getByRole('button', { name: /Call Vera Voice/ }).click()
		await page.getByRole('button', { name: 'Allow microphone & start call' }).click()
		await expect
			.poll(() => page.evaluate(() => (window as never as { __voice: { ws: unknown } }).__voice.ws))
			.not.toBeNull()

		await page.evaluate(() => {
			const v = (window as never as { __voice: { killSocket: () => void } }).__voice
			v.killSocket()
		})
		await page.evaluate(() =>
			(
				window as never as {
					__voice: { fromRealtime: (e: Record<string, unknown>) => void }
				}
			).__voice.fromRealtime({
				type: 'response.function_call_arguments.done',
				call_id: 'call_9',
				name: 'get_objects',
				arguments: '{}',
			}),
		)

		const sent = await page.evaluate(
			() => (window as never as { __voice: { dcSent: unknown[] } }).__voice.dcSent,
		)
		expect(sent).toHaveLength(2)
		expect(JSON.stringify(sent[0])).toContain('voice_channel_unavailable')
		expect(sent[1]).toEqual({ type: 'response.create' })
	})
})
