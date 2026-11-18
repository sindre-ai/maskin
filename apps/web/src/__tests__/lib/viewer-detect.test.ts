import {
	MOCKUP_VIEWPORT_PRESETS,
	detectViewerVariantFromDom,
	detectViewerVariantFromFilename,
	isSelfPagingDocument,
	resolveViewerVariant,
} from '@/lib/viewer-detect'
import { describe, expect, it } from 'vitest'

describe('viewer-detect', () => {
	describe('detectViewerVariantFromFilename', () => {
		it('picks deck for .deck.html', () => {
			expect(detectViewerVariantFromFilename('q3-review.deck.html')).toBe('deck')
			expect(detectViewerVariantFromFilename('Q3-REVIEW.DECK.HTML')).toBe('deck')
		})

		it('picks mockup for .mockup.html', () => {
			expect(detectViewerVariantFromFilename('signup-flow.mockup.html')).toBe('mockup')
		})

		it('returns null when neither suffix matches', () => {
			expect(detectViewerVariantFromFilename('landing.html')).toBeNull()
			expect(detectViewerVariantFromFilename('deck.html')).toBeNull()
			expect(detectViewerVariantFromFilename('signup-flow.mockup')).toBeNull()
		})
	})

	describe('detectViewerVariantFromDom', () => {
		it('picks deck when a data-slide attribute is present', () => {
			expect(detectViewerVariantFromDom('<article data-slide="1"></article>')).toBe('deck')
		})

		it('picks deck when a section.slide is present', () => {
			expect(detectViewerVariantFromDom('<section class="slide title">a</section>')).toBe('deck')
		})

		it('picks deck for three or more id="slide*"', () => {
			const html = '<div id="slide1"></div><div id="slide2"></div><div id="slide-3"></div>'
			expect(detectViewerVariantFromDom(html)).toBe('deck')
		})

		it('picks single when the DOM has no slide signals', () => {
			expect(detectViewerVariantFromDom('<main><h1>hello</h1><p>plain html</p></main>')).toBe(
				'single',
			)
		})

		it('caps the scan at 8KB — a slide signal past 8KB does NOT flip the result', () => {
			const padding = ' '.repeat(9_000)
			const html = `<main>plain</main>${padding}<article data-slide="1"></article>`
			expect(detectViewerVariantFromDom(html)).toBe('single')
		})

		it('does not confuse the substring "slide" inside other class names', () => {
			const html = '<section class="slidebar">not a deck</section>'
			expect(detectViewerVariantFromDom(html)).toBe('single')
		})
	})

	describe('resolveViewerVariant — order of resolution', () => {
		it('override wins over filename suffix', () => {
			expect(
				resolveViewerVariant({
					filename: 'anything.deck.html',
					html: '',
					override: 'mockup',
				}),
			).toBe('mockup')
		})

		it('override wins over DOM heuristic', () => {
			expect(
				resolveViewerVariant({
					filename: 'anything.html',
					html: '<article data-slide="1"></article>',
					override: 'single',
				}),
			).toBe('single')
		})

		it('filename suffix wins over DOM heuristic when no override', () => {
			expect(
				resolveViewerVariant({
					filename: 'x.mockup.html',
					html: '<article data-slide="1"></article>',
					override: null,
				}),
			).toBe('mockup')
		})

		it('DOM heuristic wins when neither override nor filename decides', () => {
			expect(
				resolveViewerVariant({
					filename: 'plain.html',
					html: '<article data-slide="1"></article>',
					override: null,
				}),
			).toBe('deck')
			expect(
				resolveViewerVariant({
					filename: 'plain.html',
					html: '<main>nothing paged</main>',
					override: null,
				}),
			).toBe('single')
		})
	})

	describe('self-paging documents', () => {
		const slides =
			'<section class="slide" id="s1">a</section><section class="slide" id="s2">b</section>'
		const metaDoc = `<meta name="maskin:paging" content="self">${slides}`
		const cssDoc = `<style>.slide{opacity:0}.slide.active{opacity:1}</style>${slides}`

		it('detects the maskin:paging meta tag', () => {
			expect(isSelfPagingDocument(metaDoc)).toBe(true)
			expect(isSelfPagingDocument(`<meta content="self" name="maskin:paging">${slides}`)).toBe(true)
		})

		it('detects a .slide.active CSS rule', () => {
			expect(isSelfPagingDocument(cssDoc)).toBe(true)
		})

		it('does not flag a deck without either signal', () => {
			expect(isSelfPagingDocument(slides)).toBe(false)
			expect(isSelfPagingDocument(`<meta name="maskin:paging" content="viewer">${slides}`)).toBe(
				false,
			)
		})

		it('only scans the first 8KB', () => {
			const padding = ' '.repeat(9_000)
			expect(isSelfPagingDocument(`${slides}${padding}${metaDoc}`)).toBe(false)
		})

		it('resolves to single for either signal, even with a deck filename', () => {
			for (const html of [metaDoc, cssDoc]) {
				expect(resolveViewerVariant({ filename: 'b.html', html, override: null })).toBe('single')
				expect(resolveViewerVariant({ filename: 'b.deck.html', html, override: null })).toBe(
					'single',
				)
			}
		})

		it('a manual View as override still wins', () => {
			expect(resolveViewerVariant({ filename: 'b.html', html: metaDoc, override: 'deck' })).toBe(
				'deck',
			)
		})

		it('a deck without the signals still gets the viewer paging', () => {
			expect(resolveViewerVariant({ filename: 'b.html', html: slides, override: null })).toBe(
				'deck',
			)
		})
	})

	describe('MOCKUP_VIEWPORT_PRESETS', () => {
		it('has the desktop / tablet / phone presets from the spec', () => {
			expect(MOCKUP_VIEWPORT_PRESETS.desktop).toEqual({ w: 1440, h: 900 })
			expect(MOCKUP_VIEWPORT_PRESETS.tablet).toEqual({ w: 768, h: 1024 })
			expect(MOCKUP_VIEWPORT_PRESETS.phone).toEqual({ w: 375, h: 812 })
		})
	})
})
