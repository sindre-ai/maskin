import { describe, expect, it } from 'vitest'
import {
	OPT_OUT_STOP_WORDS,
	containsStopWord,
	normalizeAddress,
	stripQuotedText,
} from '../../../lib/outreach/voice/optout-reply'

describe('stop word list', () => {
	it('is the fixed starting set', () => {
		expect([...OPT_OUT_STOP_WORDS]).toEqual([
			'stop',
			'unsubscribe',
			'remove me',
			'do not contact',
			'afmeld',
			'frameld',
			'fjern mig',
			'ikke kontakt',
		])
	})

	it.each([...OPT_OUT_STOP_WORDS])('matches %s in the body', (word) => {
		expect(containsStopWord(undefined, `Hi,\n\n${word}\n\nPia`)).toBe(true)
	})

	it.each([...OPT_OUT_STOP_WORDS])('matches %s in the subject', (word) => {
		expect(containsStopWord(`Re: ${word}`, 'Tak for mailen')).toBe(true)
	})

	it.each([...OPT_OUT_STOP_WORDS])('matches %s in upper case', (word) => {
		expect(containsStopWord(undefined, word.toUpperCase())).toBe(true)
	})

	it('matches a phrase split across lines or extra spaces', () => {
		expect(containsStopWord(undefined, 'Please remove\r\n  me from your list')).toBe(true)
		expect(containsStopWord(undefined, 'ikke  kontakt mig igen')).toBe(true)
	})

	it('matches whole words only', () => {
		expect(containsStopWord('Re: bus stopper', 'Vi stopper ved Aarhus H')).toBe(false)
		expect(containsStopWord(undefined, 'unstoppable and afmelding')).toBe(false)
		expect(containsStopWord(undefined, 'Nonstop service')).toBe(false)
	})

	it('does not match a reply with no stop word', () => {
		expect(containsStopWord('Re: Tak for samtalen', 'Tak, vi vender tilbage næste uge.')).toBe(
			false,
		)
	})
})

describe('quoted text', () => {
	const danishOriginal =
		'Dette er den eneste e-mail, vi sender dig om samtalen. Hvis du ikke ønsker flere e-mails fra Maskin, så svar på denne mail eller skriv til rune@maskin.io, så stopper vi.'
	const englishOriginal =
		'If you do not want further email from Maskin, reply to this message or write to rune@maskin.io and we will stop.'

	it('ignores the opt-out line quoted under an "On ... wrote:" marker', () => {
		const reply = `Tak, vi vender tilbage.\n\nOn Fri, 2 Oct 2026 at 10:00 Maskin <noreply@x.example> wrote:\n> ${englishOriginal}`
		expect(containsStopWord('Re: Your call', reply)).toBe(false)
	})

	it('ignores the opt-out line quoted under a Danish "skrev" marker', () => {
		const reply = `Tak.\n\nDen fre. 2. okt. 2026 kl. 10.00 skrev Maskin <noreply@x.example>:\n${danishOriginal}`
		expect(containsStopWord('Re: Din samtale', reply)).toBe(false)
	})

	it('ignores ">" quoted lines and Original Message blocks', () => {
		expect(containsStopWord(undefined, `Fint.\n> ${englishOriginal}`)).toBe(false)
		expect(
			containsStopWord(undefined, `Fint.\n-----Original Message-----\n${englishOriginal}`),
		).toBe(false)
	})

	it('still matches a stop word written above the quote', () => {
		const reply = `STOP\n\nOn Fri, 2 Oct 2026 Maskin wrote:\n> ${englishOriginal}`
		expect(containsStopWord('Re: Your call', reply)).toBe(true)
	})

	it('stripQuotedText keeps only the new text', () => {
		expect(stripQuotedText('ok\nthanks\n> old\nmore old')).toBe('ok\nthanks')
	})
})

describe('normalizeAddress', () => {
	it('lower-cases and unwraps a display name', () => {
		expect(normalizeAddress('Pia Prospect <Pia@Prospect.EXAMPLE>')).toBe('pia@prospect.example')
		expect(normalizeAddress('  PIA@prospect.example ')).toBe('pia@prospect.example')
	})

	it('returns null for anything that is not an address', () => {
		expect(normalizeAddress(undefined)).toBeNull()
		expect(normalizeAddress('')).toBeNull()
		expect(normalizeAddress('not an address')).toBeNull()
	})
})
