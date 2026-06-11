// @vitest-environment node
import type { Annotation } from '@/components/files/annotation-overlay'
import {
	type AnnotationJson,
	buildRevisePrompt,
	compileAnnotations,
	hydrateAnnotations,
	sanitizeAnnotations,
} from '@/lib/annotations'
import type { FileAnnotation, FileDetail } from '@/lib/api'
import { describe, expect, it } from 'vitest'

const makeAnnotation = (overrides: Partial<Annotation> = {}): Annotation => ({
	id: 'a1',
	pinNumber: 1,
	selector: '#hero',
	bounds: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
	comment: 'looks off',
	position: { x: 0.5, y: 0.5 },
	...overrides,
})

function makeAnnotationJson(
	overrides: Partial<AnnotationJson['annotations'][number]> = {},
): AnnotationJson {
	return {
		annotations: [
			{
				id: 'a1',
				bounds: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
				selector: '#hero',
				comment: 'looks off',
				...overrides,
			},
		],
	}
}

function makeFile(overrides: Partial<FileDetail> = {}): FileDetail {
	return {
		id: 'file-1',
		workspaceId: 'ws-1',
		name: 'proto.html',
		description: null,
		mimeType: 'text/html',
		sizeBytes: 32,
		storageKey: 'workspaces/ws-1/files/file-1',
		createdBy: 'actor-1',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		content: '<h1>Hello</h1>',
		encoding: 'utf8',
		url: 'http://localhost:5173/ws-1/files/file-1',
		annotations: [],
		...overrides,
	}
}

describe('hydrateAnnotations', () => {
	it('returns an empty array for null/undefined', () => {
		expect(hydrateAnnotations(null)).toEqual([])
		expect(hydrateAnnotations(undefined)).toEqual([])
	})

	it('passes through fully-specified annotations', () => {
		const stored: FileAnnotation[] = [
			{
				id: 'a1',
				pinNumber: 3,
				selector: 'div.card',
				bounds: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
				comment: 'hi',
				position: { x: 0.5, y: 0.6 },
			},
		]
		expect(hydrateAnnotations(stored)[0]).toEqual(stored[0])
	})

	it('backfills pinNumber by order when missing', () => {
		const stored: FileAnnotation[] = [
			{ id: 'a', selector: '', bounds: { x: 0, y: 0, w: 0.2, h: 0.2 }, comment: 'one' },
			{ id: 'b', selector: '', bounds: { x: 0, y: 0, w: 0.2, h: 0.2 }, comment: 'two' },
		]
		const result = hydrateAnnotations(stored)
		expect(result.map((a) => a.pinNumber)).toEqual([1, 2])
	})

	it('derives position from the bounds center when missing', () => {
		const stored: FileAnnotation[] = [
			{ id: 'a', selector: '', bounds: { x: 0.2, y: 0.4, w: 0.4, h: 0.2 }, comment: 'c' },
		]
		expect(hydrateAnnotations(stored)[0].position).toEqual({ x: 0.4, y: 0.5 })
	})
})

describe('compileAnnotations', () => {
	it('maps annotation fields to the approved schema', () => {
		const result = compileAnnotations([makeAnnotation()])
		expect(result).toEqual({
			annotations: [
				{
					id: 'a1',
					bounds: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
					selector: '#hero',
					comment: 'looks off',
				},
			],
		})
	})

	it('omits selector when empty', () => {
		const result = compileAnnotations([makeAnnotation({ selector: '' })])
		expect(result.annotations[0]).not.toHaveProperty('selector')
	})

	it('excludes pinNumber and position from the output', () => {
		const result = compileAnnotations([makeAnnotation()])
		expect(result.annotations[0]).not.toHaveProperty('pinNumber')
		expect(result.annotations[0]).not.toHaveProperty('position')
	})

	it('returns empty annotations array for empty input', () => {
		expect(compileAnnotations([])).toEqual({ annotations: [] })
	})

	it('preserves all annotations in order', () => {
		const input = [
			makeAnnotation({ id: 'a1', pinNumber: 1, comment: 'first' }),
			makeAnnotation({ id: 'a2', pinNumber: 2, comment: 'second' }),
		]
		const result = compileAnnotations(input)
		expect(result.annotations).toHaveLength(2)
		expect(result.annotations[0].id).toBe('a1')
		expect(result.annotations[1].id).toBe('a2')
	})
})

describe('sanitizeAnnotations', () => {
	it('strips HTML tags from comment fields', () => {
		const json = makeAnnotationJson({ comment: '<b>bold</b> text <script>alert(1)</script>' })
		const result = sanitizeAnnotations(json)
		expect(result.annotations[0].comment).toBe('bold text alert(1)')
	})

	it('trims leading and trailing whitespace from comments', () => {
		const json = makeAnnotationJson({ comment: '  needs padding  ' })
		const result = sanitizeAnnotations(json)
		expect(result.annotations[0].comment).toBe('needs padding')
	})

	it('truncates comments longer than 500 characters', () => {
		const long = 'x'.repeat(600)
		const json = makeAnnotationJson({ comment: long })
		const result = sanitizeAnnotations(json)
		expect(result.annotations[0].comment).toHaveLength(500)
	})

	it('leaves comments shorter than 500 characters unchanged', () => {
		const json = makeAnnotationJson({ comment: 'short comment' })
		const result = sanitizeAnnotations(json)
		expect(result.annotations[0].comment).toBe('short comment')
	})

	it('does not mutate selector fields', () => {
		const json = makeAnnotationJson({ selector: '#hero > .btn', comment: 'fix color' })
		const result = sanitizeAnnotations(json)
		expect(result.annotations[0].selector).toBe('#hero > .btn')
	})

	it('sanitizes all annotations, not just the first', () => {
		const json: AnnotationJson = {
			annotations: [
				{ id: 'a1', bounds: { x: 0, y: 0, w: 1, h: 1 }, comment: '<em>one</em>' },
				{ id: 'a2', bounds: { x: 0, y: 0, w: 1, h: 1 }, comment: '<em>two</em>' },
			],
		}
		const result = sanitizeAnnotations(json)
		expect(result.annotations[0].comment).toBe('one')
		expect(result.annotations[1].comment).toBe('two')
	})
})

describe('buildRevisePrompt', () => {
	it('includes the system instruction, annotations JSON, and file HTML', () => {
		const file = makeFile({ content: '<h1>Hello</h1>' })
		const json = makeAnnotationJson({ comment: 'make heading blue' })
		const prompt = buildRevisePrompt(file, json)

		expect(prompt).toContain('Revise the HTML prototype')
		expect(prompt).toContain('## Annotations')
		expect(prompt).toContain('## Current file: proto.html')
		expect(prompt).toContain('<h1>Hello</h1>')
		expect(prompt).toContain('"comment": "make heading blue"')
	})

	it('decodes base64 content when encoding is base64', () => {
		const html = '<p>Base64 content</p>'
		const b64 = Buffer.from(html, 'utf-8').toString('base64')
		const file = makeFile({ content: b64, encoding: 'base64' })
		const prompt = buildRevisePrompt(file, makeAnnotationJson())
		expect(prompt).toContain('<p>Base64 content</p>')
		expect(prompt).not.toContain(b64)
	})

	it('sanitizes annotation comments before embedding them', () => {
		const file = makeFile()
		const json = makeAnnotationJson({ comment: '<script>alert(1)</script>fix this' })
		const prompt = buildRevisePrompt(file, json)
		expect(prompt).not.toContain('<script>')
		expect(prompt).toContain('alert(1)fix this')
	})
})
