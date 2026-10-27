import { TooltipProvider } from '@/components/ui/tooltip'
import type { VoiceCall, VoiceCallState } from '@/hooks/use-voice-call'
import { CommandPaletteProvider } from '@/lib/command-palette-context'
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUseVoiceCall } = vi.hoisted(() => ({ mockUseVoiceCall: vi.fn() }))

vi.mock('@/hooks/use-voice-call', () => ({
	useVoiceCall: (...args: unknown[]) => mockUseVoiceCall(...args),
}))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))

import { VoiceCallDialog } from '@/components/agents/voice-call-dialog'
import { getVoiceCallView as getView, publishVoiceCallView } from '@/lib/voice-call-view'

const agent = { id: 'agent-1', name: 'Chief of Staff', type: 'agent' as const }

function callIn(state: VoiceCallState, overrides: Partial<VoiceCall> = {}): VoiceCall {
	return {
		state,
		notice: null,
		transcriptOpen: false,
		transcriptLines: [],
		start: vi.fn(),
		retryMic: vi.fn(),
		toggleMute: vi.fn(),
		speakerOn: true,
		toggleSpeaker: vi.fn(),
		toggleTranscript: vi.fn(),
		end: vi.fn(),
		...overrides,
	}
}

function renderDialog(call: VoiceCall, onOpenChange = vi.fn()) {
	mockUseVoiceCall.mockReturnValue(call)
	render(
		<CommandPaletteProvider>
			<TooltipProvider>
				<VoiceCallDialog agent={agent} open onOpenChange={onOpenChange} />
			</TooltipProvider>
		</CommandPaletteProvider>,
	)
	return onOpenChange
}

beforeEach(() => {
	mockUseVoiceCall.mockReset()
	publishVoiceCallView(null)
})

describe('VoiceCallDialog — connecting copy', () => {
	it('says the call is starting, not how it is wired', () => {
		renderDialog(callIn('connecting'))
		expect(screen.getByText('Starting the call…')).toBeInTheDocument()
		expect(screen.queryByText(/WebRTC/)).toBeNull()
	})
})

describe('VoiceCallDialog — going live', () => {
	it('hands a live call to the surfaces: the dialog draws nothing and publishes the view', () => {
		renderDialog(callIn('live-agent-speaking'))
		expect(screen.queryByRole('button', { name: 'Close call' })).toBeNull()
		const view = getView()
		expect(view?.agent.name).toBe('Chief of Staff')
		expect(view?.state).toBe('live-agent-speaking')
		expect(view?.minimized).toBe(false)
	})

	it('carries the agent latest spoken line as the caption', () => {
		renderDialog(
			callIn('live-agent-speaking', {
				transcriptLines: [
					{ id: 1, kind: 'assistant', text: 'First line.' },
					{ id: 2, kind: 'user', text: 'Okay.' },
					{ id: 3, kind: 'assistant', text: 'Second line.' },
				],
			}),
		)
		expect(getView()?.caption).toBe('Second line.')
	})

	it('publishes nothing before there is a call', () => {
		renderDialog(callIn('permission'))
		expect(getView()).toBeNull()
		expect(screen.getByRole('button', { name: 'Close call' })).toBeInTheDocument()
	})

	it('ends the call through the published view', () => {
		const onOpenChange = renderDialog(callIn('live-agent-speaking'))
		act(() => getView()?.end())
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it('minimises through the published view and keeps the call', () => {
		renderDialog(callIn('live-agent-speaking'))
		act(() => getView()?.setMinimized(true))
		expect(getView()?.minimized).toBe(true)
	})
})
