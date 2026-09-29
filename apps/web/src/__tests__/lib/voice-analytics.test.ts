import { trackVoiceToolCall, trackVoiceTurnCompleted } from '@/lib/voice-analytics'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/analytics', () => ({
	trackEvent: vi.fn(),
}))

import { trackEvent } from '@/lib/analytics'

const trackEventMock = trackEvent as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
	trackEventMock.mockClear()
})

describe('trackVoiceToolCall', () => {
	it('emits voice_tool_call with the spec property schema on success', () => {
		trackVoiceToolCall({
			voice_session_id: 'vs_1',
			tool_name: 'search_objects',
			success: true,
			latency_ms: 142,
		})
		expect(trackEventMock).toHaveBeenCalledWith('voice_tool_call', {
			voice_session_id: 'vs_1',
			tool_name: 'search_objects',
			success: true,
			latency_ms: 142,
			error_code: null,
		})
	})

	it('passes error_code through on failure', () => {
		trackVoiceToolCall({
			voice_session_id: 'vs_2',
			tool_name: 'create_comment',
			success: false,
			latency_ms: 12,
			error_code: 'voice_attention_too_high',
		})
		expect(trackEventMock).toHaveBeenCalledWith('voice_tool_call', {
			voice_session_id: 'vs_2',
			tool_name: 'create_comment',
			success: false,
			latency_ms: 12,
			error_code: 'voice_attention_too_high',
		})
	})

	it('coerces missing error_code to null (never undefined)', () => {
		trackVoiceToolCall({
			voice_session_id: 'vs_3',
			tool_name: 'get_objects',
			success: true,
			latency_ms: 8,
			error_code: undefined,
		})
		const call = trackEventMock.mock.calls[0]
		expect(call?.[1]?.error_code).toBeNull()
	})
})

describe('trackVoiceTurnCompleted', () => {
	it('emits voice_turn_completed with the full property schema', () => {
		trackVoiceTurnCompleted({
			voice_session_id: 'vs_1',
			turn_index: 3,
			user_audio_ms: 1_200,
			agent_audio_ms: 4_100,
			barge_in: false,
		})
		expect(trackEventMock).toHaveBeenCalledWith('voice_turn_completed', {
			voice_session_id: 'vs_1',
			turn_index: 3,
			user_audio_ms: 1_200,
			agent_audio_ms: 4_100,
			barge_in: false,
		})
	})

	it('propagates barge_in=true so the property is queryable', () => {
		trackVoiceTurnCompleted({
			voice_session_id: 'vs_1',
			turn_index: 4,
			user_audio_ms: 800,
			agent_audio_ms: 210,
			barge_in: true,
		})
		expect(trackEventMock.mock.calls[0]?.[1]?.barge_in).toBe(true)
	})
})
