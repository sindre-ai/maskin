import { describe, expect, it } from 'vitest'
import { validateMetadataFields } from '../../lib/validate-metadata'

const knowledgeFields = [
	{ name: 'summary', type: 'text' as const, required: true },
	{ name: 'confidence', type: 'enum' as const, required: false, values: ['low', 'medium', 'high'] },
	{ name: 'tags', type: 'text' as const, required: false },
]

describe('validateMetadataFields', () => {
	describe('mode: create', () => {
		it('returns no errors when no field definitions exist', () => {
			expect(validateMetadataFields('task', { foo: 'bar' }, undefined, { mode: 'create' })).toEqual(
				[],
			)
			expect(validateMetadataFields('task', null, [], { mode: 'create' })).toEqual([])
		})

		it('flags a missing required field on empty metadata', () => {
			const errors = validateMetadataFields('knowledge', {}, knowledgeFields, { mode: 'create' })
			expect(errors).toHaveLength(1)
			expect(errors[0].field).toBe('metadata.summary')
			expect(errors[0].message).toContain('summary')
		})

		it('flags a missing required field on null metadata', () => {
			const errors = validateMetadataFields('knowledge', null, knowledgeFields, { mode: 'create' })
			expect(errors).toHaveLength(1)
			expect(errors[0].field).toBe('metadata.summary')
		})

		it('flags a required field set to null', () => {
			const errors = validateMetadataFields('knowledge', { summary: null }, knowledgeFields, {
				mode: 'create',
			})
			expect(errors).toHaveLength(1)
			expect(errors[0].received).toBe('null')
		})

		it('accepts a present required field', () => {
			expect(
				validateMetadataFields('knowledge', { summary: 'x' }, knowledgeFields, {
					mode: 'create',
				}),
			).toEqual([])
		})

		it('accepts an empty string as a present value', () => {
			expect(
				validateMetadataFields('knowledge', { summary: '' }, knowledgeFields, {
					mode: 'create',
				}),
			).toEqual([])
		})

		it('flags an invalid enum value', () => {
			const errors = validateMetadataFields(
				'knowledge',
				{ summary: 'x', confidence: 'banana' },
				knowledgeFields,
				{ mode: 'create' },
			)
			expect(errors).toHaveLength(1)
			expect(errors[0].field).toBe('metadata.confidence')
			expect(errors[0].expected).toContain("'low'")
			expect(errors[0].expected).toContain("'high'")
		})

		it('accepts a valid enum value', () => {
			expect(
				validateMetadataFields(
					'knowledge',
					{ summary: 'x', confidence: 'medium' },
					knowledgeFields,
					{ mode: 'create' },
				),
			).toEqual([])
		})

		it('does not validate enum when value is omitted', () => {
			expect(
				validateMetadataFields('knowledge', { summary: 'x' }, knowledgeFields, {
					mode: 'create',
				}),
			).toEqual([])
		})

		it('accumulates multiple errors', () => {
			const errors = validateMetadataFields(
				'knowledge',
				{ confidence: 'banana' },
				knowledgeFields,
				{ mode: 'create' },
			)
			expect(errors).toHaveLength(2)
		})

		it('applies fieldPath prefix when provided', () => {
			const errors = validateMetadataFields('knowledge', {}, knowledgeFields, {
				mode: 'create',
				fieldPath: 'nodes[k-1]',
			})
			expect(errors[0].field).toBe('nodes[k-1].metadata.summary')
		})
	})

	describe('mode: update', () => {
		it('does not flag a missing required field when not submitted', () => {
			expect(
				validateMetadataFields('knowledge', { tags: 'foo' }, knowledgeFields, {
					mode: 'update',
				}),
			).toEqual([])
		})

		it('does not flag empty metadata payload (no-op patch)', () => {
			expect(validateMetadataFields('knowledge', {}, knowledgeFields, { mode: 'update' })).toEqual(
				[],
			)
		})

		it('flags an explicit null clear of a required field', () => {
			const errors = validateMetadataFields('knowledge', { summary: null }, knowledgeFields, {
				mode: 'update',
			})
			expect(errors).toHaveLength(1)
			expect(errors[0].field).toBe('metadata.summary')
			expect(errors[0].message).toContain('cannot be cleared')
		})

		it('accepts setting a required field to a new value', () => {
			expect(
				validateMetadataFields('knowledge', { summary: 'new' }, knowledgeFields, {
					mode: 'update',
				}),
			).toEqual([])
		})

		it('flags an invalid enum value on update', () => {
			const errors = validateMetadataFields(
				'knowledge',
				{ confidence: 'banana' },
				knowledgeFields,
				{ mode: 'update' },
			)
			expect(errors).toHaveLength(1)
			expect(errors[0].field).toBe('metadata.confidence')
		})

		it('accepts a valid enum value on update', () => {
			expect(
				validateMetadataFields('knowledge', { confidence: 'high' }, knowledgeFields, {
					mode: 'update',
				}),
			).toEqual([])
		})
	})
})
