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

describe('VoiceCallDialog — Mic blocked', () => {
	it('shows the SPEC copy and a How to enable link that opens a help page in a new tab', () => {
		renderDialog(callIn('mic-blocked'))
		expect(screen.getByRole('heading', { name: 'Microphone blocked' })).toBeInTheDocument()
		expect(
			screen.getByText("Enable microphone access in your browser's site settings, then try again."),
		).toBeInTheDocument()
		const link = screen.getByRole('link', { name: /How to enable →/ })
		expect(link).toHaveAttribute('target', '_blank')
		expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
		expect(link.getAttribute('href')).toMatch(/^https:\/\//)
	})

	it('offers Cancel, and not the permission screen controls', async () => {
		const onOpenChange = renderDialog(callIn('mic-blocked'))
		expect(screen.queryByRole('button', { name: 'Allow microphone & start call' })).toBeNull()
		await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it('announces the state to screen readers', () => {
		renderDialog(callIn('mic-blocked'))
		expect(screen.getByText('Microphone blocked.', { selector: '[aria-live]' })).toBeInTheDocument()
	})
})

describe('VoiceCallDialog — No microphone', () => {
	it('shows the SPEC copy and a Retry that re-enumerates devices', async () => {
		const retryMic = vi.fn()
		renderDialog(callIn('no-mic', { retryMic }))
		expect(screen.getByRole('heading', { name: 'No microphone found' })).toBeInTheDocument()
		expect(
			screen.getByText(
				'Connect a microphone (or check that headphones with a mic are plugged in), then try again.',
			),
		).toBeInTheDocument()
		await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
		expect(retryMic).toHaveBeenCalledTimes(1)
	})
})
