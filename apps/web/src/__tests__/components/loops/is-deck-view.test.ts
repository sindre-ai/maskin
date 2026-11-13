import { isDeckView } from '@/components/loops/loop-briefing-stage'
import type { FileDetail } from '@/lib/api'
import { describe, expect, it } from 'vitest'

function file(over: Partial<FileDetail>): FileDetail {
	return {
		id: 'f',
		name: 'Page.html',
		mimeType: 'text/html',
		kind: null,
		encoding: 'utf8',
		content: '<html><body><p>Hello</p></body></html>',
		...over,
	} as FileDetail
}

const SLIDES = '<html><body><section class="slide">One</section></body></html>'
const withSources = (json: string) =>
	`<html><body><section class="slide">One</section><script id="maskin-sources" type="application/json">${json}</script></body></html>`

describe('isDeckView', () => {
	it('treats a file marked as a briefing as a deck', () => {
		expect(isDeckView(file({ kind: 'briefing' }))).toBe(true)
	})

	it('treats HTML with slides and no sources as a deck', () => {
		expect(isDeckView(file({ content: SLIDES }))).toBe(true)
		expect(isDeckView(file({ name: 'Q4.deck.html' }))).toBe(true)
	})

	it('reads base64 content', () => {
		expect(isDeckView(file({ encoding: 'base64', content: btoa(SLIDES) }))).toBe(true)
	})

	it('keeps a plain page, and a page with sources, in the frame', () => {
		expect(isDeckView(file({}))).toBe(false)
		const list = '{"tasks":{"list":"objects","type":"task"}}'
		expect(isDeckView(file({ content: withSources(list) }))).toBe(false)
	})

	it('is never a deck when it is not HTML', () => {
		expect(isDeckView(file({ mimeType: 'text/markdown', kind: 'briefing' }))).toBe(false)
	})
})
