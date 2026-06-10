// @vitest-environment node
import type { Annotation } from '@/components/files/annotation-overlay'
import { compileAnnotations } from '@/lib/annotations'
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
