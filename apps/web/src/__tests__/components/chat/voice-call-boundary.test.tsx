import {
	VoiceCallBoundary,
	VoiceMessageMetaTag,
	formatVoiceCallDuration,
} from '@/components/chat/voice-call-boundary'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('formatVoiceCallDuration', () => {
	it('renders sub-minute calls as 0:SS', () => {
		expect(formatVoiceCallDuration(0)).toBe('0:00')
		expect(formatVoiceCallDuration(4_000)).toBe('0:04')
	})

	it('renders minute+ calls as M:SS with zero-padded seconds', () => {
		expect(formatVoiceCallDuration(65_000)).toBe('1:05')
		expect(formatVoiceCallDuration(9 * 60_000 + 30_000)).toBe('9:30')
	})

	it('renders hour+ calls as H:MM:SS with zero-padded minutes and seconds', () => {
		expect(formatVoiceCallDuration(3600_000 + 5 * 60_000 + 3_000)).toBe('1:05:03')
	})

	it('clamps negative durations to zero', () => {
		expect(formatVoiceCallDuration(-1)).toBe('0:00')
	})
})

describe('VoiceCallBoundary — start variant', () => {
	it('renders the verbatim SPEC head string with duration and clock range', () => {
		render(
			<VoiceCallBoundary
				variant="start"
				durationMs={2 * 60_000 + 14_000}
				startedAt={new Date('2026-09-29T10:00:00Z')}
				endedAt={new Date('2026-09-29T10:02:14Z')}
			/>,
		)
		const el = screen.getByTestId('voice-call-boundary')
		expect(el).toHaveAttribute('data-variant', 'start')
		expect(el.textContent).toMatch(
			/^Voice call · 2:14 · \d{1,2}:\d{2}\s*(?:[AP]M)?\s*→\s*\d{1,2}:\d{2}/,
		)
	})

	it('renders "Voice call" alone when no duration or clock is available', () => {
		render(<VoiceCallBoundary variant="start" />)
		expect(screen.getByTestId('voice-call-boundary').textContent).toBe('Voice call')
	})

	it('omits the clock range when only one endpoint is supplied', () => {
		render(
			<VoiceCallBoundary
				variant="start"
				durationMs={30_000}
				startedAt={new Date('2026-09-29T10:00:00Z')}
			/>,
		)
		expect(screen.getByTestId('voice-call-boundary').textContent).toBe('Voice call · 0:30')
	})
})

describe('VoiceCallBoundary — end variant', () => {
	it('renders the verbatim SPEC tail string', () => {
		render(<VoiceCallBoundary variant="end" />)
		const el = screen.getByTestId('voice-call-boundary')
		expect(el).toHaveAttribute('data-variant', 'end')
		expect(el.textContent).toBe('Call ended')
	})
})

describe('VoiceMessageMetaTag', () => {
	it('renders the "voice" mono meta tag with an sr-only label', () => {
		render(<VoiceMessageMetaTag />)
		const tag = screen.getByTestId('voice-message-meta-tag')
		expect(tag.textContent).toBe('voice')
		expect(tag).toHaveAttribute('aria-label', 'Sent by voice')
	})
})
