import { describe, expect, it } from 'vitest'
import { computeSttCostUsd, computeTtsCostUsd, liveDailyMinuteCap } from '../../lib/live-costs'
import { LIVE_STYLE, composeLiveSystemPrompt, toHistoryMessages } from '../../services/live-prompt'

const parts = {
	agentName: 'Chief of Staff',
	humanName: 'Sebastian',
	systemPrompt: 'You run the day.',
	skills: [{ name: 'triage', content: 'Sort by urgency.' }],
	briefing: 'Two bets are blocked.',
	learnings: 'Prefers short answers.',
	otherParticipants: [],
	pulledUp: [],
}

describe('composeLiveSystemPrompt', () => {
	it('orders identity, skills, snapshot, learnings, people and style', () => {
		const out = composeLiveSystemPrompt(parts)
		const order = [
			'live voice conversation',
			'You run the day.',
			'## Skills',
			'## Workspace snapshot',
			'## What you have learned',
			'## Who is here',
			'## How to speak',
		]
		const idx = order.map((s) => out.indexOf(s))
		expect(idx.every((i) => i >= 0)).toBe(true)
		expect([...idx].sort((a, b) => a - b)).toEqual(idx)
	})

	it('omits empty sections and falls back to a default identity', () => {
		const out = composeLiveSystemPrompt({
			...parts,
			systemPrompt: null,
			skills: [],
			briefing: null,
			learnings: null,
		})
		expect(out).not.toContain('## Skills')
		expect(out).not.toContain('## Workspace snapshot')
		expect(out).toContain('You are a helpful AI agent.')
	})

	it('trims an oversized briefing', () => {
		const out = composeLiveSystemPrompt({ ...parts, briefing: 'x'.repeat(50_000) })
		expect(out.length).toBeLessThan(40_000)
		expect(out).toContain('[…trimmed]')
	})

	it('lists what is on screen and other participants', () => {
		const out = composeLiveSystemPrompt({
			...parts,
			otherParticipants: ['Magnus'],
			pulledUp: [
				{ id: 'x', type: 'bet', title: 'Retry window', status: 'active', excerpt: 'Seven days.' },
			],
		})
		expect(out).toContain('Magnus is also in this conversation')
		expect(out).toContain('Retry window (bet, active): Seven days.')
	})

	it('tells the model to speak, not write', () => {
		expect(LIVE_STYLE).toMatch(/No markdown/)
		expect(LIVE_STYLE).toMatch(/never ids/)
		expect(LIVE_STYLE).toMatch(/yes or no question/)
	})
})

describe('toHistoryMessages', () => {
	it('maps the agent to assistant and everyone else to named user lines', () => {
		const out = toHistoryMessages(
			[
				{ actorId: 'h', actorName: 'Sebastian', content: 'Status?', metadata: null },
				{ actorId: 'a', actorName: 'CoS', content: 'Two blocked.', metadata: null },
			],
			'a',
		)
		expect(out).toEqual([
			{ role: 'user', content: 'Sebastian: Status?' },
			{ role: 'assistant', content: 'Two blocked.' },
		])
	})

	it('shows the model what an interrupted reply was going to say', () => {
		const [m] = toHistoryMessages(
			[
				{
					actorId: 'a',
					actorName: 'CoS',
					content: 'Two are',
					metadata: { live: { interrupted: true, full_text: 'Two are blocked on legal.' } },
				},
			],
			'a',
		)
		expect(m?.content).toContain('Two are')
		expect(m?.content).toContain('Two are blocked on legal.')
	})
})

describe('live costs', () => {
	it('prices tts per thousand characters and stt per minute from env', () => {
		expect(computeTtsCostUsd(2000, { MASKIN_LIVE_TTS_USD_PER_1K_CHARS: '0.01' })).toBeCloseTo(0.02)
		expect(computeSttCostUsd(120, { MASKIN_LIVE_STT_USD_PER_MINUTE: '0.005' })).toBeCloseTo(0.01)
	})
	it('ignores junk env values', () => {
		expect(computeTtsCostUsd(1000, { MASKIN_LIVE_TTS_USD_PER_1K_CHARS: 'abc' })).toBeCloseTo(0.012)
	})
	it('prefers the workspace cap over env, with a safe default', () => {
		expect(
			liveDailyMinuteCap(
				{ live: { daily_minutes_cap: 10 } },
				{ MASKIN_LIVE_DAILY_MINUTES_PER_WORKSPACE: '99' },
			),
		).toBe(10)
		expect(liveDailyMinuteCap({}, { MASKIN_LIVE_DAILY_MINUTES_PER_WORKSPACE: '99' })).toBe(99)
		expect(liveDailyMinuteCap(null, { MASKIN_LIVE_DAILY_MINUTES_PER_WORKSPACE: 'x' })).toBe(60)
	})
})
