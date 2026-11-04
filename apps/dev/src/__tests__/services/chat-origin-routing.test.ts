import { describe, expect, it } from 'vitest'
import {
	ROUTED_MESSAGE_MAX_CHARS,
	buildRoutedMessage,
	cutAtParagraph,
} from '../../services/chat-origin-routing'

const URL = 'https://maskin.io/ws/objects/obj'

const paragraph = (n: number, size = 400) => `Paragraph ${n} ${'x'.repeat(size)}`

describe('cutAtParagraph', () => {
	it('leaves a body at or under the cap alone', () => {
		const body = 'a'.repeat(ROUTED_MESSAGE_MAX_CHARS)
		expect(cutAtParagraph(body, ROUTED_MESSAGE_MAX_CHARS)).toEqual({ text: body, cut: false })
	})

	it('cuts at the last paragraph break under the cap', () => {
		const body = [paragraph(1), paragraph(2), paragraph(3), paragraph(4), paragraph(5)].join('\n\n')
		const out = cutAtParagraph(body, ROUTED_MESSAGE_MAX_CHARS)
		expect(out.cut).toBe(true)
		expect(out.text.length).toBeLessThanOrEqual(ROUTED_MESSAGE_MAX_CHARS)
		expect(out.text).toBe([paragraph(1), paragraph(2), paragraph(3)].join('\n\n'))
	})

	it('cuts before a code fence that the cap would split', () => {
		// Blank lines inside the fence are paragraph breaks to a naive cut.
		const fence = `\`\`\`chart\n${'{"a":1}\n\n'.repeat(160)}\`\`\``
		const body = `${paragraph(1, 100)}\n\n${fence}\n\n${paragraph(2, 100)}`
		const out = cutAtParagraph(body, ROUTED_MESSAGE_MAX_CHARS)
		expect(out.cut).toBe(true)
		expect(out.text).toBe(paragraph(1, 100))
		expect(out.text).not.toContain('```')
	})

	it('keeps a fence that closes before the cap', () => {
		const fence = '```\ncode\n```'
		const body = `${paragraph(1, 100)}\n\n${fence}\n\n${paragraph(2, 1600)}`
		const out = cutAtParagraph(body, ROUTED_MESSAGE_MAX_CHARS)
		expect(out.text).toBe(`${paragraph(1, 100)}\n\n${fence}`)
	})

	it('falls back to a line break, then a space, then a hard cut', () => {
		const lines = `${'a'.repeat(1000)}\n${'b'.repeat(1000)}`
		expect(cutAtParagraph(lines, ROUTED_MESSAGE_MAX_CHARS).text).toBe('a'.repeat(1000))

		const words = `${'a'.repeat(1000)} ${'b'.repeat(1000)}`
		expect(cutAtParagraph(words, ROUTED_MESSAGE_MAX_CHARS).text).toBe('a'.repeat(1000))

		const solid = 'z'.repeat(2000)
		expect(cutAtParagraph(solid, ROUTED_MESSAGE_MAX_CHARS).text).toHaveLength(
			ROUTED_MESSAGE_MAX_CHARS,
		)
	})
})

describe('buildRoutedMessage', () => {
	it('sends a short body as is, with no link', () => {
		expect(
			buildRoutedMessage({ body: 'All done.', title: 'Report', url: URL, pointerOnly: false }),
		).toBe('All done.')
	})

	it('ends a cut body with a link to the rest', () => {
		const body = [paragraph(1), paragraph(2), paragraph(3), paragraph(4), paragraph(5)].join('\n\n')
		const text = buildRoutedMessage({ body, title: 'Report', url: URL, pointerOnly: false })
		expect(text.endsWith(`\n\nRead the rest: [Report](${URL})`)).toBe(true)
		expect(text.length).toBeLessThanOrEqual(ROUTED_MESSAGE_MAX_CHARS + 200)
	})

	it('is only the link when the body opens with a fence longer than the cap', () => {
		const body = `\`\`\`chart\n${'{"a":1}\n'.repeat(400)}\`\`\``
		expect(buildRoutedMessage({ body, title: 'Report', url: URL, pointerOnly: false })).toBe(
			`Read the rest: [Report](${URL})`,
		)
	})

	it('is a one-line pointer, not the text, when the commenter is in the chat itself', () => {
		const text = buildRoutedMessage({
			body: 'a long update',
			title: 'Report',
			url: URL,
			pointerOnly: true,
		})
		expect(text).toBe(`I posted an update on [Report](${URL}).`)
	})

	it('drops square brackets from the title so the link stays valid', () => {
		const text = buildRoutedMessage({
			body: 'x',
			title: '[Bug] Login',
			url: URL,
			pointerOnly: true,
		})
		expect(text).toBe(`I posted an update on [Bug Login](${URL}).`)
	})
})
