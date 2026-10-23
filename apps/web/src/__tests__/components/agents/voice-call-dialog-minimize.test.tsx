import { TooltipProvider } from '@/components/ui/tooltip'
import type { VoiceCall, VoiceCallState } from '@/hooks/use-voice-call'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUseVoiceCall } = vi.hoisted(() => ({ mockUseVoiceCall: vi.fn() }))

vi.mock('@/hooks/use-voice-call', () => ({
	useVoiceCall: (...args: unknown[]) => mockUseVoiceCall(...args),
}))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))

import { VoiceCallDialog } from '@/components/agents/voice-call-dialog'

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
		toggleTranscript: vi.fn(),
		end: vi.fn(),
		...overrides,
	}
}

function renderDialog(call: VoiceCall, onOpenChange = vi.fn()) {
	mockUseVoiceCall.mockReturnValue(call)
	render(
		<TooltipProvider>
			<VoiceCallDialog agent={agent} open onOpenChange={onOpenChange} />
		</TooltipProvider>,
	)
	return onOpenChange
}

beforeEach(() => mockUseVoiceCall.mockReset())

describe('VoiceCallDialog — connecting copy', () => {
	it('says the call is starting, not how it is wired', () => {
		renderDialog(callIn('connecting'))
		expect(screen.getByText('Starting the call…')).toBeInTheDocument()
		expect(screen.queryByText(/WebRTC/)).toBeNull()
	})
})

describe('VoiceCallDialog — minimize', () => {
	it('offers Minimize once the call is live or connecting', () => {
		renderDialog(callIn('live-agent-speaking'))
		expect(screen.getByRole('button', { name: 'Minimize call' })).toBeInTheDocument()
	})

	it('does not offer Minimize before there is a call (permission, mic errors)', () => {
		renderDialog(callIn('permission'))
		expect(screen.queryByRole('button', { name: 'Minimize call' })).toBeNull()
	})

	it('collapses to a floating bar that keeps the call, and expands back', async () => {
		const call = callIn('live-agent-speaking')
		const onOpenChange = renderDialog(call)

		await userEvent.click(screen.getByRole('button', { name: 'Minimize call' }))
		const bar = screen.getByRole('region', { name: 'Call with Chief of Staff' })
		expect(bar).toHaveTextContent('Chief of Staff is speaking')
		// Minimizing is not hanging up.
		expect(onOpenChange).not.toHaveBeenCalled()
		expect(call.end).not.toHaveBeenCalled()
		expect(screen.queryByRole('button', { name: 'Minimize call' })).toBeNull()

		await userEvent.click(screen.getByRole('button', { name: 'Expand call' }))
		expect(screen.queryByRole('region', { name: 'Call with Chief of Staff' })).toBeNull()
		expect(screen.getByRole('button', { name: 'Minimize call' })).toBeInTheDocument()
	})

	it('mutes and ends the call from the bar', async () => {
		const call = callIn('live-user-speaking')
		const onOpenChange = renderDialog(call)
		await userEvent.click(screen.getByRole('button', { name: 'Minimize call' }))

		await userEvent.click(screen.getByRole('button', { name: 'Mute' }))
		expect(call.toggleMute).toHaveBeenCalledTimes(1)

		await userEvent.click(screen.getByRole('button', { name: 'End call' }))
		expect(call.end).toHaveBeenCalled()
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it('shows the muted state on the bar', async () => {
		renderDialog(callIn('live-muted'))
		await userEvent.click(screen.getByRole('button', { name: 'Minimize call' }))
		expect(screen.getByRole('region', { name: 'Call with Chief of Staff' })).toHaveTextContent(
			'Muted',
		)
		expect(screen.getByRole('button', { name: 'Unmute' })).toBeInTheDocument()
	})
})
