import { toggleMarkdownMarker } from '@/components/shared/markdown-content'
import { splitMarkdownMarkers } from '@/lib/markdown-markers'

const markers = (source: string) =>
	splitMarkdownMarkers(source)
		.filter((segment) => segment.isMarker)
		.map((segment) => segment.text)

describe('splitMarkdownMarkers', () => {
	it('reports the delimiters of a paired run and leaves its content alone', () => {
		const segments = splitMarkdownMarkers('Enterprise **trials** block')
		expect(segments).toEqual([
			{ text: 'Enterprise ', isMarker: false },
			{ text: '**', isMarker: true },
			{ text: 'trials', isMarker: false },
			{ text: '**', isMarker: true },
			{ text: ' block', isMarker: false },
		])
	})

	it('handles italic and code runs', () => {
		expect(markers('a _b_ and `c` here')).toEqual(['_', '_', '`', '`'])
	})

	// A lone delimiter is prose, not syntax — dimming it would hide a real
	// character the writer typed.
	it('leaves an unpaired delimiter at full contrast', () => {
		expect(markers('2 * 3 and a stray _ here')).toEqual([])
		expect(markers('**unclosed bold')).toEqual([])
	})

	it('round-trips the source exactly', () => {
		const source = 'Mixed **bold**, _italic_, `code`, and a * stray.'
		expect(
			splitMarkdownMarkers(source)
				.map((segment) => segment.text)
				.join(''),
		).toBe(source)
	})

	it('returns nothing for an empty draft', () => {
		expect(splitMarkdownMarkers('')).toEqual([])
	})

	it('spans a bold run that wraps across lines', () => {
		expect(markers('**one\ntwo**')).toEqual(['**', '**'])
	})
})

describe('toggleMarkdownMarker', () => {
	it('wraps the selected run', () => {
		expect(toggleMarkdownMarker('one two three', 4, 7, '**')).toEqual({
			value: 'one **two** three',
			start: 6,
			end: 9,
		})
	})

	it('unwraps a run that already carries the marker', () => {
		expect(toggleMarkdownMarker('one **two** three', 6, 9, '**')).toEqual({
			value: 'one two three',
			start: 4,
			end: 7,
		})
	})

	// `**word **` is not emphasis — markdown renders the asterisks literally.
	it('leaves padding outside the markers', () => {
		expect(toggleMarkdownMarker('one two three', 4, 8, '**').value).toBe('one **two** three')
		expect(toggleMarkdownMarker('one two three', 3, 8, '**').value).toBe('one **two** three')
	})

	it('does nothing when the selection is only whitespace', () => {
		expect(toggleMarkdownMarker('one   two', 3, 6, '**').value).toBe('one   two')
	})
})
