import { describe, expect, it } from 'vitest'
import {
	MAX_ANNOTATIONS_PER_FILE,
	MAX_ANNOTATION_COMMENT_LENGTH,
	MAX_TAGS_PER_FILE,
	MAX_TAG_LENGTH,
	createFileSchema,
	fileAnnotationSchema,
	fileAnnotationsSchema,
	fileTagsSchema,
	parseFileTagFilter,
	startFileUploadSchema,
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

describe('updateFileSchema if_match', () => {
	const hash = 'a'.repeat(64)

	it('accepts a sha256 hex digest alongside a change', () => {
		expect(updateFileSchema.parse({ content: 'x', if_match: hash }).if_match).toBe(hash)
	})

	it('accepts a save without if_match', () => {
		expect(updateFileSchema.safeParse({ content: 'x' }).success).toBe(true)
	})

	it('rejects a value that is not a sha256 hex digest', () => {
		expect(updateFileSchema.safeParse({ content: 'x', if_match: 'abc' }).success).toBe(false)
		expect(updateFileSchema.safeParse({ content: 'x', if_match: 'A'.repeat(64) }).success).toBe(
			false,
		)
	})

	it('does not count if_match as a field to update', () => {
		expect(updateFileSchema.safeParse({ if_match: hash }).success).toBe(false)
	})

	it('drops source and actor_type, which the server sets itself', () => {
		const parsed = updateFileSchema.parse({
			content: 'x',
			source: 'accepted_change',
			actor_type: 'agent',
		})
		expect(parsed).not.toHaveProperty('source')
		expect(parsed).not.toHaveProperty('actor_type')
	})
})

describe('fileTagsSchema', () => {
	it('trims and lowercases, so B-roll and b-roll are one tag', () => {
		expect(fileTagsSchema.parse(['  B-Roll ', 'b-roll', 'Clip_Type:B_Roll'])).toEqual([
			'b-roll',
			'clip_type:b_roll',
		])
	})

	it('accepts an empty list', () => {
		expect(fileTagsSchema.parse([])).toEqual([])
	})

	it('rejects a blank tag, a tag with a comma, and a tag over the length cap', () => {
		expect(fileTagsSchema.safeParse(['  ']).success).toBe(false)
		expect(fileTagsSchema.safeParse(['a,b']).success).toBe(false)
		expect(fileTagsSchema.safeParse(['x'.repeat(MAX_TAG_LENGTH)]).success).toBe(true)
		expect(fileTagsSchema.safeParse(['x'.repeat(MAX_TAG_LENGTH + 1)]).success).toBe(false)
	})

	it('allows up to the per-file cap and no more', () => {
		const tags = (n: number) => Array.from({ length: n }, (_, i) => `tag-${i}`)
		expect(fileTagsSchema.safeParse(tags(MAX_TAGS_PER_FILE)).success).toBe(true)
		expect(fileTagsSchema.safeParse(tags(MAX_TAGS_PER_FILE + 1)).success).toBe(false)
	})

	it('is accepted on create, update and the start of a large upload', () => {
		const file = { name: 'a.mov', mime_type: 'video/quicktime' }
		expect(createFileSchema.parse({ ...file, content: '', tags: [' B-roll '] }).tags).toEqual([
			'b-roll',
		])
		expect(updateFileSchema.parse({ tags: [] }).tags).toEqual([])
		expect(startFileUploadSchema.parse({ ...file, size_bytes: 10, tags: ['Raw'] }).tags).toEqual([
			'raw',
		])
	})
})

describe('parseFileTagFilter', () => {
	it('splits on commas and normalises like a write', () => {
		expect(parseFileTagFilter(' B-roll, raw ,B-ROLL,,')).toEqual(['b-roll', 'raw'])
	})

	it('returns nothing for an absent or blank filter', () => {
		expect(parseFileTagFilter(undefined)).toEqual([])
		expect(parseFileTagFilter(' , ')).toEqual([])
	})
})
