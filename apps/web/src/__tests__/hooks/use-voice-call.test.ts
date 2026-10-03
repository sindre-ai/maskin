import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockCreate, mockHangup } = vi.hoisted(() => ({
	mockCreate: vi.fn(),
	mockHangup: vi.fn(),
}))

vi.mock('@/lib/api', async () => {
	const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
	return {
		...actual,
		api: { voiceSessions: { create: mockCreate, hangup: mockHangup } },
	}
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

import { useVoiceCall } from '@/hooks/use-voice-call'
import { ApiError } from '@/lib/api'
import { isVoiceUnavailable, resetVoiceAvailability } from '@/lib/voice-availability'

const AGENT_ID = 'agent-1'

function domError(name: string) {
	return new DOMException('mic', name)
}

function stubMediaDevices(overrides: Partial<MediaDevices>) {
	Object.defineProperty(navigator, 'mediaDevices', {
		configurable: true,
		value: overrides,
	})
}

const fakeTrack = { stop: vi.fn(), enabled: true }
const fakeStream = {
	getTracks: () => [fakeTrack],
	getAudioTracks: () => [fakeTrack],
} as unknown as MediaStream

class FakePeerConnection {
	iceConnectionState = 'new'
	listeners = new Map<string, () => void>()
	restartIce = vi.fn()
	close = vi.fn()
	addTrack = vi.fn()
	createDataChannel() {
		return { close: vi.fn(), addEventListener: vi.fn() }
	}
	addEventListener(type: string, cb: () => void) {
		this.listeners.set(type, cb)
	}
	createOffer = vi.fn().mockResolvedValue({ sdp: 'v=0' })
	setLocalDescription = vi.fn().mockResolvedValue(undefined)
	setRemoteDescription = vi.fn().mockResolvedValue(undefined)
	setIce(state: string) {
		this.iceConnectionState = state
		this.listeners.get('iceconnectionstatechange')?.()
	}
}

let lastPc: FakePeerConnection | null = null

beforeEach(() => {
	mockCreate.mockReset()
	mockHangup.mockReset().mockResolvedValue({})
	fakeTrack.stop.mockReset()
	lastPc = null
	resetVoiceAvailability()
	vi.stubGlobal('RTCPeerConnection', function Factory() {
		lastPc = new FakePeerConnection()
		return lastPc
	} as unknown as typeof RTCPeerConnection)
})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

const mintOk = {
	voice_session_id: 'vs-1',
	client_secret: 'ek_abc',
	expires_at: '2026-10-01T00:00:00Z',
	ws_url: 'wss://example.test',
}

describe('useVoiceCall — microphone errors', () => {
	it('lands in mic-blocked when the browser denies the microphone, without minting a session', async () => {
		stubMediaDevices({ getUserMedia: vi.fn().mockRejectedValue(domError('NotAllowedError')) })
		const { result } = renderHook(() => useVoiceCall(AGENT_ID, true))
		await act(() => result.current.start())
		expect(result.current.state).toBe('mic-blocked')
		expect(mockCreate).not.toHaveBeenCalled()
		expect(mockHangup).not.toHaveBeenCalled()
	})

	it('lands in no-mic when no input device exists', async () => {
		stubMediaDevices({ getUserMedia: vi.fn().mockRejectedValue(domError('NotFoundError')) })
		const { result } = renderHook(() => useVoiceCall(AGENT_ID, true))
		await act(() => result.current.start())
		expect(result.current.state).toBe('no-mic')
	})

	it('keeps other mic failures on the permission screen with a notice', async () => {
		stubMediaDevices({ getUserMedia: vi.fn().mockRejectedValue(domError('NotReadableError')) })
		const { result } = renderHook(() => useVoiceCall(AGENT_ID, true))
		await act(() => result.current.start())
		expect(result.current.state).toBe('permission')
		expect(result.current.notice).toMatch(/Could not access a microphone/)
	})

	it('Retry re-enumerates devices and returns to permission once an input appears', async () => {
		const enumerateDevices = vi.fn().mockResolvedValue([])
		stubMediaDevices({
			getUserMedia: vi.fn().mockRejectedValue(domError('NotFoundError')),
			enumerateDevices,
		})
		const { result } = renderHook(() => useVoiceCall(AGENT_ID, true))
		await act(() => result.current.start())
		expect(result.current.state).toBe('no-mic')

		await act(() => result.current.retryMic())
		expect(enumerateDevices).toHaveBeenCalledTimes(1)
		expect(result.current.state).toBe('no-mic')

		enumerateDevices.mockResolvedValue([{ kind: 'audioinput' }])
		await act(() => result.current.retryMic())
		expect(result.current.state).toBe('permission')
	})
})

describe('useVoiceCall — session lifecycle', () => {
	it('disables voice for the server-given retry window when the mint is rate limited', async () => {
		stubMediaDevices({ getUserMedia: vi.fn().mockResolvedValue(fakeStream) })
		const err = new ApiError(429, 'Vendor rate limit')
		err.retryAfterSeconds = 120
		mockCreate.mockRejectedValue(err)
		const { result } = renderHook(() => useVoiceCall(AGENT_ID, true))
		await act(() => result.current.start())
		expect(isVoiceUnavailable()).toBe(true)
		expect(result.current.state).toBe('permission')
		expect(result.current.notice).toBe('Voice temporarily unavailable — try again in a moment.')
		// No session came back, so there is nothing to hang up; the mic is released.
		expect(mockHangup).not.toHaveBeenCalled()
		expect(fakeTrack.stop).toHaveBeenCalled()
	})

	it('hangs up as network_error when the handshake fails after the session was minted', async () => {
		stubMediaDevices({ getUserMedia: vi.fn().mockResolvedValue(fakeStream) })
		mockCreate.mockResolvedValue(mintOk)
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
		const { result } = renderHook(() => useVoiceCall(AGENT_ID, true))
		await act(() => result.current.start())
		expect(mockHangup).toHaveBeenCalledWith(
			'ws-1',
			'vs-1',
			expect.objectContaining({ reason: 'network_error' }),
		)
		expect(result.current.state).toBe('permission')
	})

	it('hangs up as user_hangup, once, when the call is ended', async () => {
		stubMediaDevices({ getUserMedia: vi.fn().mockResolvedValue(fakeStream) })
		mockCreate.mockResolvedValue(mintOk)
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => 'answer-sdp' }))
		const { result, rerender } = renderHook(({ open }) => useVoiceCall(AGENT_ID, open), {
			initialProps: { open: true },
		})
		await act(() => result.current.start())
		expect(mockHangup).not.toHaveBeenCalled()

		act(() => result.current.end())
		expect(mockHangup).toHaveBeenCalledTimes(1)
		expect(mockHangup).toHaveBeenCalledWith(
			'ws-1',
			'vs-1',
			expect.objectContaining({ reason: 'user_hangup' }),
		)

		// The dialog closing right after End must not send a second hangup.
		rerender({ open: false })
		expect(mockHangup).toHaveBeenCalledTimes(1)
	})

	it('restarts ICE once on a failed connection and ends the call as network_error after 15s', async () => {
		stubMediaDevices({ getUserMedia: vi.fn().mockResolvedValue(fakeStream) })
		mockCreate.mockResolvedValue(mintOk)
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => 'answer-sdp' }))
		const { result } = renderHook(() => useVoiceCall(AGENT_ID, true))
		await act(() => result.current.start())

		vi.useFakeTimers()
		act(() => lastPc?.setIce('failed'))
		expect(result.current.state).toBe('reconnecting')
		expect(lastPc?.restartIce).toHaveBeenCalledTimes(1)

		act(() => {
			vi.advanceTimersByTime(14_000)
		})
		expect(mockHangup).not.toHaveBeenCalled()
		act(() => {
			vi.advanceTimersByTime(2_000)
		})
		expect(mockHangup).toHaveBeenCalledWith(
			'ws-1',
			'vs-1',
			expect.objectContaining({ reason: 'network_error' }),
		)
		expect(result.current.state).toBe('permission')
		expect(result.current.notice).toMatch(/connection dropped/)
	})

	it('a connection that recovers inside the window resumes without ending the call', async () => {
		stubMediaDevices({ getUserMedia: vi.fn().mockResolvedValue(fakeStream) })
		mockCreate.mockResolvedValue(mintOk)
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => 'answer-sdp' }))
		const { result } = renderHook(() => useVoiceCall(AGENT_ID, true))
		await act(() => result.current.start())

		vi.useFakeTimers()
		act(() => lastPc?.setIce('disconnected'))
		expect(result.current.state).toBe('reconnecting')
		act(() => lastPc?.setIce('connected'))
		expect(result.current.state).toBe('live-agent-speaking')
		act(() => {
			vi.advanceTimersByTime(30_000)
		})
		expect(mockHangup).not.toHaveBeenCalled()
	})
})
