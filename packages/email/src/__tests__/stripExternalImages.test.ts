import { describe, expect, it } from 'vitest'
import { stripExternalImages } from '..'

describe('stripExternalImages', () => {
	it('strips an HTML <img> tag pointing at an external host', () => {
		const body = '<p>Hello</p><img src="http://attacker.example/pixel.gif"><p>bye</p>'
		const result = stripExternalImages(body)
		expect(result.bodyText).toBe('<p>Hello</p>[external image removed]<p>bye</p>')
		expect(result.removed).toBe(1)
	})

	it('leaves a body with no images unchanged', () => {
		const body = '# Heading\n\nJust some **text** with a [link](https://example.com).'
		const result = stripExternalImages(body)
		expect(result.bodyText).toBe(body)
		expect(result.removed).toBe(0)
	})

	it('preserves a data-URI inline image', () => {
		const body = '<img src="data:image/png;base64,iVBORw0KGgoAAAANS==" alt="ok"><p>hi</p>'
		const result = stripExternalImages(body)
		expect(result.bodyText).toBe(body)
		expect(result.removed).toBe(0)
	})

	it('strips Markdown image syntax with an external URL', () => {
		const body = 'Before ![pixel](https://attacker.example/p.gif) after'
		const result = stripExternalImages(body)
		expect(result.bodyText).toBe('Before [external image removed] after')
		expect(result.removed).toBe(1)
	})

	it('strips Markdown image with a title argument', () => {
		const body = '![alt](http://attacker.example/p.gif "title")'
		const result = stripExternalImages(body)
		expect(result.bodyText).toBe('[external image removed]')
		expect(result.removed).toBe(1)
	})

	it('preserves a Markdown data-URI image', () => {
		const body = '![tiny](data:image/gif;base64,R0lGODlh)'
		const result = stripExternalImages(body)
		expect(result.bodyText).toBe(body)
		expect(result.removed).toBe(0)
	})

	it('strips CSS url() references in a <style> block', () => {
		const body =
			'<style>.hero { background: url("https://attacker.example/bg.png"); }</style><p>ok</p>'
		const result = stripExternalImages(body)
		expect(result.bodyText).toBe('<style>.hero { background: url(); }</style><p>ok</p>')
		expect(result.removed).toBe(1)
	})

	it('strips CSS url() in an inline style attribute', () => {
		const body = '<div style="background:url(http://attacker.example/x.png)"></div>'
		const result = stripExternalImages(body)
		expect(result.bodyText).toBe('<div style="background:url()"></div>')
		expect(result.removed).toBe(1)
	})

	it('preserves CSS url() with a data-URI', () => {
		const body = '<div style="background:url(\'data:image/png;base64,iVBORw0KGg==\')"></div>'
		const result = stripExternalImages(body)
		expect(result.bodyText).toBe(body)
		expect(result.removed).toBe(0)
	})

	it('treats protocol-relative //host URLs as external', () => {
		const body = '<img src="//tracker.example/pixel.gif">'
		const result = stripExternalImages(body)
		expect(result.bodyText).toBe('[external image removed]')
		expect(result.removed).toBe(1)
	})

	it('treats cid: and relative URLs as external', () => {
		const body = '<img src="cid:logo.png"> and ![local](./logo.png)'
		const result = stripExternalImages(body)
		expect(result.bodyText).toBe('[external image removed] and [external image removed]')
		expect(result.removed).toBe(2)
	})

	it('strips <img> tags whose src uses unquoted attribute syntax', () => {
		const body = '<img src=http://attacker.example/x.gif width=1>'
		const result = stripExternalImages(body)
		expect(result.bodyText).toBe('[external image removed]')
		expect(result.removed).toBe(1)
	})

	it('strips <img> tags with no src attribute at all', () => {
		const body = '<img alt="nothing">'
		const result = stripExternalImages(body)
		expect(result.bodyText).toBe('[external image removed]')
		expect(result.removed).toBe(1)
	})

	it('handles multiple images in one body and counts them', () => {
		const body =
			'<img src="http://a.example/1.gif">' +
			'![two](https://b.example/2.gif)' +
			'<div style="background:url(http://c.example/3.png)"></div>' +
			'<img src="data:image/png;base64,AAAA">'
		const result = stripExternalImages(body)
		expect(result.removed).toBe(3)
		expect(result.bodyText).toContain('[external image removed]')
		expect(result.bodyText).toContain('data:image/png;base64,AAAA')
	})

	it('returns an empty body unchanged', () => {
		const result = stripExternalImages('')
		expect(result.bodyText).toBe('')
		expect(result.removed).toBe(0)
	})
})
