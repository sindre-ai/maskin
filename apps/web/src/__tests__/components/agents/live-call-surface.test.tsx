import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockMedia } = vi.hoisted(() => ({ mockMedia: vi.fn() }))
vi.mock('@/hooks/use-media-query', () => ({ useMediaQuery: () => mockMedia() }))

import {
	LiveCallComposerSlot,
	LiveCallSurface,
	LiveCapsule,
} from '@/components/agents/live-call-surface'
import { type VoiceCallView, publishVoiceCallView } from '@/lib/voice-call-view'

function makeView(overrides: Partial<VoiceCallView> = {}): VoiceCallView {
	return {
		agent: { id: 'a1', name: 'Developer', type: 'agent' },
		state: 'live-user-speaking',
		liveSince: Date.now() - 37_000,
		caption: null,
		captionsOn: true,
		speakerOn: true,
		minimized: false,
		toggleMute: vi.fn(),
		toggleSpeaker: vi.fn(),
		toggleCaptions: vi.fn(),
		setMinimized: vi.fn(),
		pullUp: vi.fn(),
		end: vi.fn(),
		...overrides,
	}
}

beforeEach(() => mockMedia.mockReturnValue(true))
afterEach(() => act(() => publishVoiceCallView(null)))

describe('LiveCallSurface — panel', () => {
	it('shows the panel with status, captions placeholder, clock and the five controls', () => {
		render(<LiveCallSurface />)
		act(() => publishVoiceCallView(makeView()))
		const panel = screen.getByRole('complementary', { name: 'Call with Developer' })
		expect(panel).toHaveAttribute('data-voice-call-surface', 'panel')
		expect(screen.getByText('Listening')).toBeInTheDocument()
		expect(screen.getByText('Captions appear here when Developer speaks.')).toBeInTheDocument()
		expect(screen.getByText('0:37')).toBeInTheDocument()
		for (const name of ['Mute', 'Speaker off', 'Hide captions', 'Pull up', 'End call']) {
			expect(screen.getByRole('button', { name })).toBeInTheDocument()
		}
	})

	it.each([
		['live-agent-speaking', 'Speaking'],
		['live-agent-thinking', 'Working on it'],
		['live-muted', 'Microphone off'],
	] as const)('names the %s phase %s', (state, label) => {
		render(<LiveCallSurface />)
		act(() => publishVoiceCallView(makeView({ state })))
		expect(screen.getByText(label)).toBeInTheDocument()
	})

	it('shows the latest caption, and hides the box when captions are off', () => {
		render(<LiveCallSurface />)
		act(() => publishVoiceCallView(makeView({ caption: 'The fix is one generic rule.' })))
		expect(screen.getByText('The fix is one generic rule.')).toBeInTheDocument()
		act(() => publishVoiceCallView(makeView({ caption: 'Hidden', captionsOn: false })))
		expect(screen.queryByText('Hidden')).toBeNull()
	})

	it('wires every control to the call', async () => {
		const view = makeView()
		render(<LiveCallSurface />)
		act(() => publishVoiceCallView(view))
		await userEvent.click(screen.getByRole('button', { name: 'Mute' }))
		await userEvent.click(screen.getByRole('button', { name: 'Speaker off' }))
		await userEvent.click(screen.getByRole('button', { name: 'Hide captions' }))
		await userEvent.click(screen.getByRole('button', { name: 'Pull up' }))
		await userEvent.click(screen.getByRole('button', { name: 'End call' }))
		await userEvent.click(screen.getByRole('button', { name: 'Minimise call' }))
		expect(view.toggleMute).toHaveBeenCalled()
		expect(view.toggleSpeaker).toHaveBeenCalled()
		expect(view.toggleCaptions).toHaveBeenCalled()
		expect(view.pullUp).toHaveBeenCalled()
		expect(view.end).toHaveBeenCalled()
		expect(view.setMinimized).toHaveBeenCalledWith(true)
	})

	it('offers Unmute while the mic is off', () => {
		render(<LiveCallSurface />)
		act(() => publishVoiceCallView(makeView({ state: 'live-muted' })))
		expect(screen.getByRole('button', { name: 'Unmute' })).toBeInTheDocument()
	})
})

describe('LiveCallSurface — bar', () => {
	it('is a bar, never also a panel, once minimised', () => {
		render(<LiveCallSurface />)
		act(() => publishVoiceCallView(makeView({ minimized: true })))
		expect(screen.getByRole('region', { name: 'Call with Developer' })).toHaveAttribute(
			'data-voice-call-surface',
			'bar',
		)
		expect(screen.queryByRole('complementary')).toBeNull()
		expect(screen.getByText('Live · Developer')).toBeInTheDocument()
	})

	it('expands on click and ends from the red button', async () => {
		const view = makeView({ minimized: true })
		render(<LiveCallSurface />)
		act(() => publishVoiceCallView(view))
		await userEvent.click(screen.getByRole('button', { name: 'Expand call' }))
		expect(view.setMinimized).toHaveBeenCalledWith(false)
		await userEvent.click(screen.getByRole('button', { name: 'End call' }))
		expect(view.end).toHaveBeenCalled()
	})

	it('sits in the thread above the composer when there is one', () => {
		render(
			<>
				<LiveCallComposerSlot />
				<LiveCallSurface />
			</>,
		)
		act(() => publishVoiceCallView(makeView({ minimized: true })))
		const bar = screen.getByRole('region', { name: 'Call with Developer' })
		expect(bar.parentElement?.parentElement).toBe(
			document.querySelector('div.empty\\:hidden') as HTMLElement,
		)
	})
})

describe('LiveCallSurface — narrow', () => {
	beforeEach(() => mockMedia.mockReturnValue(false))

	it('docks above the composer instead of taking a column', () => {
		render(
			<>
				<LiveCallComposerSlot />
				<LiveCallSurface />
			</>,
		)
		act(() => publishVoiceCallView(makeView()))
		expect(screen.getByRole('region', { name: 'Call with Developer' })).toHaveAttribute(
			'data-voice-call-surface',
			'dock',
		)
		expect(screen.queryByRole('complementary')).toBeNull()
	})

	it('falls back to the bar where there is no thread to dock in', () => {
		render(<LiveCallSurface />)
		act(() => publishVoiceCallView(makeView()))
		expect(screen.getByRole('region', { name: 'Call with Developer' })).toHaveAttribute(
			'data-voice-call-surface',
			'bar',
		)
	})
})

describe('LiveCapsule', () => {
	it('renders only during a call, with the running time', () => {
		render(<LiveCapsule />)
		expect(screen.queryByRole('status')).toBeNull()
		act(() => publishVoiceCallView(makeView()))
		expect(screen.getByRole('status', { name: 'Live call with Developer' })).toHaveTextContent(
			'0:37',
		)
	})
})
