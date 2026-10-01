import {
	VoiceCallBoundary,
	VoiceMessageMetaTag,
	deriveVoiceCallBoundaries,
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

describe('deriveVoiceCallBoundaries', () => {
	const msg = (id: number, createdAt: string | null, call: string | null) => ({
		id,
		createdAt,
		metadata: call ? { source: 'voice', voice_session_id: call } : null,
	})

	it('marks the first and last message of a run, with the run duration and range', () => {
		const out = deriveVoiceCallBoundaries([
			msg(1, '2026-09-30T09:00:00Z', null),
			msg(2, '2026-09-30T10:00:00Z', 'a'),
			msg(3, '2026-09-30T10:01:00Z', 'a'),
			msg(4, '2026-09-30T10:02:14Z', 'a'),
			msg(5, '2026-09-30T11:00:00Z', null),
		])
		expect([...out.keys()]).toEqual([2, 4])
		expect(out.get(2)?.start).toEqual({
			durationMs: 134_000,
			startedAt: '2026-09-30T10:00:00Z',
			endedAt: '2026-09-30T10:02:14Z',
		})
		expect(out.get(4)?.end).toBe(true)
	})

	it('puts head and tail on the one message of a single-message run', () => {
		const out = deriveVoiceCallBoundaries([msg(7, '2026-09-30T10:00:00Z', 'a')])
		expect(out.get(7)?.start?.durationMs).toBe(0)
		expect(out.get(7)?.end).toBe(true)
	})

	it('splits a call into two runs when a typed message lands between its turns', () => {
		const out = deriveVoiceCallBoundaries([
			msg(1, '2026-09-30T10:00:00Z', 'a'),
			msg(2, '2026-09-30T10:01:00Z', null),
			msg(3, '2026-09-30T10:02:00Z', 'a'),
		])
		expect([...out.entries()].map(([id, b]) => [id, !!b.start, !!b.end])).toEqual([
			[1, true, true],
			[3, true, true],
		])
	})

	it('treats back-to-back calls as separate runs', () => {
		const out = deriveVoiceCallBoundaries([
			msg(1, '2026-09-30T10:00:00Z', 'a'),
			msg(2, '2026-09-30T10:00:05Z', 'b'),
		])
		expect(out.get(1)).toMatchObject({ end: true })
		expect(out.get(2)).toMatchObject({ end: true })
		expect(out.get(2)?.start).toBeDefined()
	})

	it('ignores a voice-sourced message with no call id, and threads with no voice at all', () => {
		expect(
			deriveVoiceCallBoundaries([{ id: 1, createdAt: null, metadata: { source: 'voice' } }]).size,
		).toBe(0)
		expect(deriveVoiceCallBoundaries([msg(1, '2026-09-30T10:00:00Z', null)]).size).toBe(0)
	})

	it('leaves the range off when a message has no timestamp', () => {
		const out = deriveVoiceCallBoundaries([msg(1, null, 'a')])
		expect(out.get(1)?.start).toEqual({
			durationMs: undefined,
			startedAt: undefined,
			endedAt: undefined,
		})
	})
})
