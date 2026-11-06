import { describe, expect, it } from 'vitest'
import {
	OPT_OUT_STOP_WORDS,
	containsStopWord,
	htmlToText,
	normalizeAddress,
	replyBody,
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

describe('html-only replies', () => {
	const englishOriginal =
		'If you do not want further email from Maskin, reply to this message or write to rune@maskin.io and we will stop.'

	it('htmlToText turns block tags into lines and decodes entities', () => {
		expect(htmlToText('<div>Hej</div><div>ikke&nbsp;kontakt&nbsp;mig<br>tak</div>')).toBe(
			'\nHej\n\nikke kontakt mig\ntak\n',
		)
		expect(htmlToText('<p>Fjern&#32;mig &amp; afmeld &#xE6;&oslash;</p>')).toBe(
			'\nFjern mig & afmeld æø\n',
		)
	})

	it('htmlToText drops head, style and script content and leaves unknown entities alone', () => {
		expect(
			htmlToText(
				'<html><head><title>stop</title><style>.stop{}</style></head><body><script>stop()</script>Hi &bogus; &#0;</body></html>',
			),
		).toBe('Hi &bogus; &#0;')
	})

	it('matches a stop word in the HTML part', () => {
		expect(
			containsStopWord(undefined, replyBody({ html: '<div dir="ltr">Afmeld mig</div>' })),
		).toBe(true)
	})

	it('ignores our opt-out line inside a Gmail-style blockquote', () => {
		const html = `<div dir="ltr">Tak, vi vender tilbage.</div><br><div class="gmail_quote"><div>On Fri, 2 Oct 2026 at 10:00 Maskin &lt;noreply@x.example&gt; wrote:<br></div><blockquote class="gmail_quote"><div>${englishOriginal}</div></blockquote></div>`
		expect(containsStopWord('Re: Your call', replyBody({ html }))).toBe(false)
	})

	it('ignores our opt-out line inside nested blockquotes and an Outlook From: block', () => {
		const nested = `<div>Fint.</div><blockquote><div>earlier</div><blockquote>${englishOriginal}</blockquote></blockquote>`
		expect(containsStopWord(undefined, replyBody({ html: nested }))).toBe(false)
		const outlook = `<div>Fint.</div><hr><div><b>From:</b> Maskin</div><div>${englishOriginal}</div>`
		expect(containsStopWord(undefined, replyBody({ html: outlook }))).toBe(false)
	})

	it('prefers the text part when it has content, and falls back to HTML when it is blank', () => {
		expect(replyBody({ text: 'Tak', html: '<div>stop</div>' })).toBe('Tak')
		expect(replyBody({ text: '  \n', html: '<div>stop</div>' })).toBe('\nstop\n')
		expect(replyBody({ html: '<div>stop</div>' })).toBe('\nstop\n')
		expect(replyBody({ text: 'Tak' })).toBe('Tak')
		expect(replyBody({})).toBeUndefined()
	})
})
