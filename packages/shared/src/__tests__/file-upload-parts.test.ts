import { describe, expect, it } from 'vitest'
import {
	MAX_INLINE_FILE_SIZE_BYTES,
	MAX_LARGE_FILE_SIZE_BYTES,
	completeFileUploadSchema,
	planFileUploadParts,
	startFileUploadSchema,
} from '../schemas/files'

const MiB = 1024 * 1024
const GiB = 1024 * MiB

describe('planFileUploadParts', () => {
	it('sends a small file as one part', () => {
		expect(planFileUploadParts(3 * MiB)).toEqual({ partSize: 16 * MiB, partCount: 1 })
	})

	it('cuts a 1 GiB file into 16 MiB parts', () => {
		expect(planFileUploadParts(GiB)).toEqual({ partSize: 16 * MiB, partCount: 64 })
	})

	it('rounds the last part up rather than dropping bytes', () => {
		const { partSize, partCount } = planFileUploadParts(16 * MiB + 1)
		expect(partCount).toBe(2)
		expect(partSize * partCount).toBeGreaterThanOrEqual(16 * MiB + 1)
	})

	it('grows the part size so a multi-TB file stays within 10,000 parts', () => {
		const { partSize, partCount } = planFileUploadParts(4 * 1024 * GiB)
		expect(partCount).toBeLessThanOrEqual(10_000)
		expect(partSize * partCount).toBeGreaterThanOrEqual(4 * 1024 * GiB)
	})

	it('keeps every part but the last above storage’s 5 MiB minimum', () => {
		for (const size of [50 * MiB + 1, GiB, 5 * GiB]) {
			expect(planFileUploadParts(size).partSize).toBeGreaterThanOrEqual(5 * MiB)
		}
	})
})

describe('startFileUploadSchema', () => {
	const valid = {
		name: 'clip.mp4',
		mime_type: 'video/mp4',
		size_bytes: MAX_INLINE_FILE_SIZE_BYTES + 1,
	}

	it('accepts a file up to the large-file limit', () => {
		expect(
			startFileUploadSchema.safeParse({ ...valid, size_bytes: MAX_LARGE_FILE_SIZE_BYTES }).success,
		).toBe(true)
	})

	it('rejects a file over the limit', () => {
		expect(
			startFileUploadSchema.safeParse({ ...valid, size_bytes: MAX_LARGE_FILE_SIZE_BYTES + 1 })
				.success,
		).toBe(false)
	})

	it('rejects an empty or fractional size', () => {
		expect(startFileUploadSchema.safeParse({ ...valid, size_bytes: 0 }).success).toBe(false)
		expect(startFileUploadSchema.safeParse({ ...valid, size_bytes: 1.5 }).success).toBe(false)
	})
})

describe('completeFileUploadSchema', () => {
	it('requires at least one part', () => {
		expect(completeFileUploadSchema.safeParse({ parts: [] }).success).toBe(false)
	})

	it('rejects part numbers outside 1 to 10000', () => {
		const part = (n: number) => ({ parts: [{ part_number: n, etag: '"abc"' }] })
		expect(completeFileUploadSchema.safeParse(part(0)).success).toBe(false)
		expect(completeFileUploadSchema.safeParse(part(10_001)).success).toBe(false)
		expect(completeFileUploadSchema.safeParse(part(10_000)).success).toBe(true)
	})
})
