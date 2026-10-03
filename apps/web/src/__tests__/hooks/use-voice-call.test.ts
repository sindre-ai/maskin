import { useVoiceCall } from '@/hooks/use-voice-call'
import type { VoiceRelayOptions } from '@/lib/voice-relay'
import { showVoiceCallEndedToast } from '@/lib/voice-toast'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mockNavigate }))
vi.mock('@/lib/workspace-context', () => ({ useWorkspace: () => ({ workspaceId: 'ws-1' }) }))
vi.mock('@/lib/api', () => ({
	api: {
		voiceSessions: {
			create: vi.fn().mockResolvedValue({
				voice_session_id: 'vs-1',
				client_secret: 'secret',
				expires_at: '2026-10-01T00:00:00Z',
				ws_url: 'wss://example',
			}),
		},
	},
}))
vi.mock('@/lib/voice-toast', () => ({ showVoiceCallEndedToast: vi.fn() }))

let relayOptions: VoiceRelayOptions | null = null
const relayClose = vi.fn()
const relayHandle = vi.fn()
vi.mock('@/lib/voice-relay', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/voice-relay')>()
	return {
		...actual,
		createVoiceRelay: (options: VoiceRelayOptions) => {
			relayOptions = options
			return { handleRealtimeEvent: relayHandle, close: relayClose }
		},
	}
})

const toastMock = vi.mocked(showVoiceCallEndedToast)

class FakeDataChannel {
	listeners: Array<(e: { data: string }) => void> = []
	addEventListener(_: string, fn: (e: { data: string }) => void) {
		this.listeners.push(fn)
	}
	close() {}
}
class FakePeerConnection {
	iceConnectionState = 'new'
	dc = new FakeDataChannel()
	addTrack() {}
	addEventListener() {}
	createDataChannel() {
		return this.dc
	}
	async createOffer() {
		return { sdp: 'offer' }
	}
	async setLocalDescription() {}
	async setRemoteDescription() {}
	close() {}
}

beforeEach(() => {
	relayOptions = null
	toastMock.mockClear()
	mockNavigate.mockClear()
	relayClose.mockClear()
	relayHandle.mockClear()
	vi.stubGlobal('RTCPeerConnection', FakePeerConnection)
	vi.stubGlobal(
		'fetch',
		vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'answer' }),
	)
	Object.defineProperty(navigator, 'mediaDevices', {
		configurable: true,
		value: {
			getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [], getAudioTracks: () => [] }),
		},
	})
})

afterEach(() => {
	vi.unstubAllGlobals()
})

async function startCall() {
	const hook = renderHook(({ open }) => useVoiceCall('agent-1', 'Chief of Staff', open), {
		initialProps: { open: true },
	})
	await act(async () => {
		await hook.result.current.start()
	})
	return hook
}

describe('useVoiceCall: control channel and post-call toast', () => {
	it('opens the per-session events URL for the minted session', async () => {
		await startCall()
		expect(relayOptions?.url).toMatch(/\/api\/voice-sessions\/vs-1\/events$/)
	})

	it('feeds Realtime events into the relay', async () => {
		await startCall()
		const dc = relayOptions?.channel as unknown as FakeDataChannel
		dc.listeners[0]({ data: JSON.stringify({ type: 'response.done' }) })
		expect(relayHandle).toHaveBeenCalledWith({ type: 'response.done' })
	})

	it('shows the saved-transcript toast with the chat link when the call ends', async () => {
		const hook = await startCall()
		act(() => {
			relayOptions?.onReady?.({ persistTranscripts: true, conversationId: null })
			relayOptions?.onConversation?.('conv-9')
		})
		act(() => hook.result.current.end())
		expect(toastMock).toHaveBeenCalledTimes(1)
		const args = toastMock.mock.calls[0][0]
		expect(args.agentName).toBe('Chief of Staff')
		expect(args.conversationUrl).toBe('/ws-1/chats/conv-9')
		expect(args.durationMs).toBeGreaterThanOrEqual(0)
		args.onOpen?.(args.conversationUrl as string)
		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId/chats/$conversationId',
			params: { workspaceId: 'ws-1', conversationId: 'conv-9' },
		})
		expect(relayClose).toHaveBeenCalled()
	})

	it('shows the opt-out variant (no link) when the workspace opted out', async () => {
		const hook = await startCall()
		act(() => relayOptions?.onReady?.({ persistTranscripts: false, conversationId: null }))
		act(() => hook.result.current.end())
		expect(toastMock).toHaveBeenCalledTimes(1)
		expect(toastMock.mock.calls[0][0].conversationUrl).toBeNull()
	})

	it('shows no toast when the control channel never reported the transcript outcome', async () => {
		const hook = await startCall()
		act(() => hook.result.current.end())
		expect(toastMock).not.toHaveBeenCalled()
	})

	it('fires once per call even when end and close both run', async () => {
		const hook = await startCall()
		act(() => relayOptions?.onConversation?.('conv-9'))
		act(() => hook.result.current.end())
		hook.rerender({ open: false })
		expect(toastMock).toHaveBeenCalledTimes(1)
	})

	it('fires when the dialog is closed without pressing End', async () => {
		const hook = await startCall()
		act(() => relayOptions?.onConversation?.('conv-9'))
		hook.rerender({ open: false })
		expect(toastMock).toHaveBeenCalledTimes(1)
	})

	it('collects transcript lines for the pane and clears them on end', async () => {
		const hook = await startCall()
		act(() => relayOptions?.onLine?.({ id: 1, kind: 'user', text: 'hi' }))
		expect(hook.result.current.transcriptLines).toEqual([{ id: 1, kind: 'user', text: 'hi' }])
		act(() => hook.result.current.end())
		expect(hook.result.current.transcriptLines).toEqual([])
	})
})
