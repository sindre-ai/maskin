import {
	VOICE_CALL_ENDED_DESCRIPTION,
	VOICE_CALL_ENDED_DURATION_MS,
	VOICE_CALL_ENDED_OPEN_ACTION_LABEL,
	VOICE_CALL_ENDED_OPT_OUT_DESCRIPTION,
	VOICE_CALL_ENDED_TITLE_PREFIX,
	showVoiceCallEndedToast,
} from '@/lib/voice-toast'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({
	toast: vi.fn(),
}))

import { toast } from 'sonner'

const toastMock = toast as unknown as ReturnType<typeof vi.fn>

beforeEach(() => {
	toastMock.mockClear()
})

describe('showVoiceCallEndedToast — persist mode', () => {
	it('fires the verbatim title, description, Open action, and 6s duration', () => {
		const onOpen = vi.fn()
		showVoiceCallEndedToast({
			durationMs: 92_000,
			agentName: 'Chief of Staff',
			conversationUrl: '/ws/chats/abc',
			onOpen,
		})

		expect(toastMock).toHaveBeenCalledTimes(1)
		const [title, opts] = toastMock.mock.calls[0] as [string, Record<string, unknown>]
		expect(title).toBe(`${VOICE_CALL_ENDED_TITLE_PREFIX}1:32`)
		expect(opts.description).toBe(VOICE_CALL_ENDED_DESCRIPTION('Chief of Staff'))
		expect(opts.duration).toBe(VOICE_CALL_ENDED_DURATION_MS)

		const action = opts.action as { label: string; onClick: () => void }
		expect(action.label).toBe(VOICE_CALL_ENDED_OPEN_ACTION_LABEL)
		action.onClick()
		expect(onOpen).toHaveBeenCalledWith('/ws/chats/abc')
	})

	it('bakes the agent name into the description verbatim', () => {
		showVoiceCallEndedToast({
			durationMs: 45_000,
			agentName: 'Sindre',
			conversationUrl: '/ws/chats/xyz',
		})
		const opts = toastMock.mock.calls[0]?.[1] as Record<string, unknown>
		expect(opts.description).toBe('Transcript saved to your chat with Sindre.')
	})
})

describe('showVoiceCallEndedToast — opt-out / no-transcript mode', () => {
	it('drops the Open action and swaps the description when conversationUrl is null', () => {
		showVoiceCallEndedToast({
			durationMs: 10_000,
			agentName: 'Chief of Staff',
			conversationUrl: null,
		})
		const [title, opts] = toastMock.mock.calls[0] as [string, Record<string, unknown>]
		expect(title).toBe(`${VOICE_CALL_ENDED_TITLE_PREFIX}0:10`)
		expect(opts.description).toBe(VOICE_CALL_ENDED_OPT_OUT_DESCRIPTION)
		expect(opts.action).toBeUndefined()
	})

	it('drops the Open action when conversationUrl is an empty string', () => {
		showVoiceCallEndedToast({
			durationMs: 1_000,
			agentName: 'Chief of Staff',
			conversationUrl: '',
		})
		expect((toastMock.mock.calls[0]?.[1] as Record<string, unknown>).action).toBeUndefined()
	})

	it('drops the Open action when conversationUrl is omitted altogether', () => {
		showVoiceCallEndedToast({ durationMs: 1_000, agentName: 'Chief of Staff' })
		expect((toastMock.mock.calls[0]?.[1] as Record<string, unknown>).action).toBeUndefined()
	})
})
