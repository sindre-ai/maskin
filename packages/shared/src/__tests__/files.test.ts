import { describe, expect, it } from 'vitest'
import {
	MAX_ANNOTATIONS_PER_FILE,
	MAX_ANNOTATION_COMMENT_LENGTH,
	createFileSchema,
	fileAnnotationSchema,
	fileAnnotationsSchema,
	updateFileSchema,
} from '../schemas/files'

const validAnnotation = {
	id: 'a1',
	pinNumber: 1,
	selector: 'div.card-title',
	bounds: { x: 0.05, y: 0.35, w: 0.27, h: 0.06 },
	comment: 'this is also not good',
	position: { x: 0.19, y: 0.38 },
}

describe('fileAnnotationSchema', () => {
	it('accepts a fully-specified annotation', () => {
		expect(fileAnnotationSchema.parse(validAnnotation)).toEqual(validAnnotation)
	})

	it('defaults selector to an empty string and allows omitting pin metadata', () => {
		const parsed = fileAnnotationSchema.parse({
			id: 'a2',
			bounds: { x: 0, y: 0, w: 0.1, h: 0.1 },
			comment: 'hi',
		})
		expect(parsed.selector).toBe('')
		expect(parsed.pinNumber).toBeUndefined()
		expect(parsed.position).toBeUndefined()
	})

	it('rejects a comment over the max length', () => {
		const result = fileAnnotationSchema.safeParse({
			...validAnnotation,
			comment: 'x'.repeat(MAX_ANNOTATION_COMMENT_LENGTH + 1),
		})
		expect(result.success).toBe(false)
	})
})

describe('fileAnnotationsSchema', () => {
	it('rejects more than the per-file maximum', () => {
		const many = Array.from({ length: MAX_ANNOTATIONS_PER_FILE + 1 }, (_, i) => ({
			...validAnnotation,
			id: `a${i}`,
		}))
		expect(fileAnnotationsSchema.safeParse(many).success).toBe(false)
	})
})

describe('updateFileSchema', () => {
	it('accepts an annotations-only update', () => {
		const result = updateFileSchema.safeParse({ annotations: [validAnnotation] })
		expect(result.success).toBe(true)
	})

	it('still rejects a completely empty update', () => {
		expect(updateFileSchema.safeParse({}).success).toBe(false)
	})

	it('reports received length and a bad multiple-of-4 when base64 is cut off', () => {
		const result = updateFileSchema.safeParse({ content: 'QUJDRA=', encoding: 'base64' })
		expect(result.success).toBe(false)
		expect(result.error?.issues[0]?.message).toBe(
			'Content must be base64-encoded (received 7 characters; length is not a multiple of 4)',
		)
	})

	it('reports a good multiple-of-4 when the length is fine but characters are not base64', () => {
		const result = updateFileSchema.safeParse({ content: 'QUJD!A==', encoding: 'base64' })
		expect(result.success).toBe(false)
		expect(result.error?.issues[0]?.message).toBe(
			'Content must be base64-encoded (received 8 characters; length is a multiple of 4)',
		)
	})

	it('still accepts valid base64', () => {
		expect(updateFileSchema.safeParse({ content: 'QUJDRA==', encoding: 'base64' }).success).toBe(
			true,
		)
	})
})

describe('createFileSchema', () => {
	it('uses the same detailed base64 error on create', () => {
		const result = createFileSchema.safeParse({
			name: 'a.png',
			mime_type: 'image/png',
			content: 'QUJDRA=',
			encoding: 'base64',
		})
		expect(result.success).toBe(false)
		expect(result.error?.issues[0]?.message).toBe(
			'Content must be base64-encoded (received 7 characters; length is not a multiple of 4)',
		)
	})
})
