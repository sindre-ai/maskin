import { describe, expect, it } from 'vitest'
import {
	VOICE_SKILLS_TOTAL_MAX_CHARS,
	capVoiceSkills,
	formatVoiceCallerContext,
} from '../../services/voice-instructions'

const NOW = new Date('2026-10-25T23:30:00Z')

describe('formatVoiceCallerContext', () => {
	it("names the caller and gives the date and time in the caller's time zone", () => {
		const out = formatVoiceCallerContext({
			callerName: 'Sam',
			timezone: 'Europe/Copenhagen',
			now: NOW,
		})
		expect(out).toContain('You are speaking with Sam.')
		// 23:30 UTC on 25 Oct is 00:30 on 26 Oct in Copenhagen (clocks went back that night).
		expect(out).toContain('Monday 26 October 2026, 00:30 (Europe/Copenhagen)')
	})

	it('falls back to UTC when no time zone is stored', () => {
		const out = formatVoiceCallerContext({ callerName: 'Sam', timezone: null, now: NOW })
		expect(out).toContain('Sunday 25 October 2026, 23:30 UTC')
	})

	it('falls back to UTC when the stored time zone is not valid', () => {
		const out = formatVoiceCallerContext({ callerName: 'Sam', timezone: 'Mars/Olympus', now: NOW })
		expect(out).toContain('Sunday 25 October 2026, 23:30 UTC')
		expect(out).not.toContain('Mars/Olympus')
	})

	it('leaves the name out when it is unknown', () => {
		const out = formatVoiceCallerContext({ callerName: ' ', timezone: null, now: NOW })
		expect(out).not.toContain('speaking with')
		expect(out).toContain('It is now')
	})
})

describe('capVoiceSkills', () => {
	const ctx = { voiceSessionId: 'vs-1' }

	it('keeps every skill when they fit', () => {
		const skills = [
			{ name: 'a', content: 'x'.repeat(100) },
			{ name: 'b', content: 'y'.repeat(100) },
		]
		expect(capVoiceSkills(skills, ctx)).toEqual(skills)
	})

	it('drops the longest skills first until the total fits, keeping the order of the rest', () => {
		const half = Math.floor(VOICE_SKILLS_TOTAL_MAX_CHARS / 2)
		const skills = [
			{ name: 'small', content: 'x'.repeat(500) },
			{ name: 'huge', content: 'y'.repeat(VOICE_SKILLS_TOTAL_MAX_CHARS) },
			{ name: 'medium', content: 'z'.repeat(half) },
		]
		const kept = capVoiceSkills(skills, ctx)
		expect(kept.map((s) => s.name)).toEqual(['small', 'medium'])
		expect(kept.reduce((n, s) => n + s.content.length, 0)).toBeLessThanOrEqual(
			VOICE_SKILLS_TOTAL_MAX_CHARS,
		)
	})

	it('never returns more than the cap when many skills each fit alone', () => {
		const skills = Array.from({ length: 20 }, (_, i) => ({
			name: `s${i}`,
			content: 'x'.repeat(3000 + i),
		}))
		const kept = capVoiceSkills(skills, ctx)
		expect(kept.length).toBeLessThan(skills.length)
		expect(kept.reduce((n, s) => n + s.content.length, 0)).toBeLessThanOrEqual(
			VOICE_SKILLS_TOTAL_MAX_CHARS,
		)
	})
})
