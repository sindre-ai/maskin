import {
	estimateDurationMs,
	formatClock,
	pickVoice,
	splitIntoUtterances,
} from '@/hooks/use-brief-playback'
import { describe, expect, it } from 'vitest'

function voice(name: string, lang: string, extra: Partial<SpeechSynthesisVoice> = {}) {
	return {
		name,
		lang,
		default: false,
		localService: true,
		voiceURI: name,
		...extra,
	} as SpeechSynthesisVoice
}

describe('pickVoice', () => {
	it('returns null when the browser has no voices yet', () => {
		expect(pickVoice([], 'en-US')).toBeNull()
	})

	it('prefers a high-quality voice over the platform default', () => {
		// The default is the robotic one on most systems — picking it is the
		// bug this function exists to avoid.
		const voices = [
			voice('Albert', 'en-US', { default: true }),
			voice('Samantha (Premium)', 'en-US'),
		]
		expect(pickVoice(voices, 'en-US')?.name).toBe('Samantha (Premium)')
	})

	it('recognises every platform marker for a better voice', () => {
		const markers = [
			'Ava (Enhanced)',
			'Google UK English Female',
			'Microsoft Aria Natural',
			'Siri Voice 4',
		]
		for (const name of markers) {
			expect(pickVoice([voice('Albert', 'en-US'), voice(name, 'en-US')], 'en-US')?.name).toBe(name)
		}
	})

	it('matches the exact locale before falling back to the language', () => {
		const voices = [voice('Daniel (Enhanced)', 'en-GB'), voice('Alex', 'en-US')]
		expect(pickVoice(voices, 'en-US')?.name).toBe('Alex')
	})

	it('falls back to the same language when the exact locale is missing', () => {
		const voices = [voice('Daniel (Enhanced)', 'en-GB'), voice('Amelie', 'fr-FR')]
		expect(pickVoice(voices, 'en-AU')?.name).toBe('Daniel (Enhanced)')
	})

	it('falls back to the browser default when nothing matches the language', () => {
		const voices = [voice('Amelie', 'fr-FR'), voice('Yuna', 'ko-KR', { default: true })]
		expect(pickVoice(voices, 'en-US')?.name).toBe('Yuna')
	})
})

describe('splitIntoUtterances', () => {
	it('splits on sentence boundaries', () => {
		expect(splitIntoUtterances('One thing matters. Nothing else does.')).toEqual([
			'One thing matters.',
			'Nothing else does.',
		])
	})

	it('keeps the terminating punctuation, since it carries the intonation', () => {
		expect(splitIntoUtterances('Is it done? Yes! Good.')).toEqual(['Is it done?', 'Yes!', 'Good.'])
	})

	it('does not split on a decimal mid-sentence', () => {
		// The split needs whitespace after the terminator, so "3.5" survives.
		expect(splitIntoUtterances('Revenue is up 3.5 percent.')).toEqual([
			'Revenue is up 3.5 percent.',
		])
	})

	it('returns a single chunk for prose with no terminator', () => {
		expect(splitIntoUtterances('no full stop here')).toEqual(['no full stop here'])
	})

	it('drops empty chunks rather than speaking silence', () => {
		expect(splitIntoUtterances('  ')).toEqual([])
	})
})

describe('estimateDurationMs', () => {
	it('is zero for an empty script', () => {
		expect(estimateDurationMs('   ')).toBe(0)
	})

	it('accounts for the slowed playback rate', () => {
		// 165 words at rate 0.95 takes longer than a minute, not exactly one.
		const oneMinuteOfWords = Array.from({ length: 165 }, () => 'word').join(' ')
		expect(estimateDurationMs(oneMinuteOfWords)).toBeGreaterThan(60_000)
	})

	it('scales with length', () => {
		expect(estimateDurationMs('one two three four')).toBeGreaterThan(estimateDurationMs('one two'))
	})
})

describe('formatClock', () => {
	it('renders m:ss', () => {
		expect(formatClock(0)).toBe('0:00')
		expect(formatClock(9_000)).toBe('0:09')
		expect(formatClock(134_000)).toBe('2:14')
	})

	it('never renders a negative clock', () => {
		expect(formatClock(-5_000)).toBe('0:00')
	})
})
