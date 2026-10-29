/**
 * R11-B · Zod schema contract for LinkedIn attachments + destructive post CRUD.
 *
 * Three concerns worth pinning:
 *   1. The attachments array's mixed-type refinement — LinkedIn accepts EITHER
 *      up to 9 images OR one non-image, never both, and the exact refinement
 *      message from spec §4.2 is what an agent pattern-matches on. All three
 *      cross-type combinations (image+video, image+document, video+document)
 *      have to fail — a partial rejection is subtler and more dangerous than
 *      an obvious no.
 *   2. The four R11 tool input shapes must NOT accept a `post_as`,
 *      `comment_as`, `react_as`, or `send_as` field. R11-A pre-scopes the
 *      acting identity at register-time, so any of those four field names
 *      leaking back in is a re-introduction of the "which identity is this?"
 *      per-call arg the fan-out exists to remove. Test iterates every shape.
 *   3. `editPostInputSchema` must fail when neither `text` nor `can_comment`
 *      is set — an edit with no fields is a no-op and would waste a Unipile
 *      round-trip.
 *
 * Nothing in this file hits the network, spins up a server, or reads
 * `apps/dev`. Every assertion targets Zod schema behaviour, so the suite
 * remains a fast, package-local unit test.
 */

import { describe, expect, it } from 'vitest'
import {
	DOCUMENT_MIME_TYPES,
	IMAGE_MIME_TYPES,
	LINKEDIN_ATTACHMENTS_MIXED_TYPES_MESSAGE,
	VIDEO_MIME_TYPES,
	linkedinAttachmentSchema,
	linkedinAttachmentsArraySchema,
} from '../lib/linkedin-attachments'
import {
	FORBIDDEN_IDENTITY_PER_CALL_FIELDS,
	LINKEDIN_R11_INPUT_SHAPES,
	deletePostInputSchema,
	editPostInputSchema,
	publishPostInputSchema,
	sendMessageInputSchema,
} from '../lib/linkedin-tool-schemas'

const oneByte = 'AA=='

function image(filename = 'photo.jpg') {
	return {
		content: oneByte,
		content_type: IMAGE_MIME_TYPES[0],
		filename,
	}
}

function video(filename = 'clip.mp4') {
	return {
		content: oneByte,
		content_type: VIDEO_MIME_TYPES[0],
		filename,
	}
}

function document(filename = 'brief.pdf') {
	return {
		content: oneByte,
		content_type: DOCUMENT_MIME_TYPES[0],
		filename,
	}
}

describe('linkedinAttachmentSchema (spec §4.2)', () => {
	it('accepts a minimal valid image attachment', () => {
		const parsed = linkedinAttachmentSchema.parse(image())
		expect(parsed.content_type).toBe('image/jpeg')
		expect(parsed.filename).toBe('photo.jpg')
	})

	it('rejects an empty content string', () => {
		const bad = { ...image(), content: '' }
		expect(() => linkedinAttachmentSchema.parse(bad)).toThrow()
	})

	it('rejects a filename longer than 255 chars', () => {
		const bad = { ...image(), filename: 'a'.repeat(256) }
		expect(() => linkedinAttachmentSchema.parse(bad)).toThrow()
	})

	it('rejects a content_type outside the image/video/document union', () => {
		const bad = { ...image(), content_type: 'application/octet-stream' }
		expect(() => linkedinAttachmentSchema.parse(bad)).toThrow()
	})

	it('accepts an optional send_mode of "native" or "file"', () => {
		expect(linkedinAttachmentSchema.parse({ ...image(), send_mode: 'native' })).toBeTruthy()
		expect(linkedinAttachmentSchema.parse({ ...image(), send_mode: 'file' })).toBeTruthy()
	})

	it('rejects a send_mode outside the two-value enum', () => {
		expect(() => linkedinAttachmentSchema.parse({ ...image(), send_mode: 'auto' })).toThrow()
	})
})

describe('linkedinAttachmentsArraySchema (spec §4.2 mixed-type refinement)', () => {
	it('accepts up to 9 images together (carousel)', () => {
		const nine = Array.from({ length: 9 }, (_, i) => image(`p${i}.jpg`))
		expect(linkedinAttachmentsArraySchema.parse(nine)).toHaveLength(9)
	})

	it('rejects more than 9 attachments — LinkedIn hard cap', () => {
		const ten = Array.from({ length: 10 }, (_, i) => image(`p${i}.jpg`))
		expect(() => linkedinAttachmentsArraySchema.parse(ten)).toThrow()
	})

	it('accepts an empty array — text-only sends and posts', () => {
		expect(linkedinAttachmentsArraySchema.parse([])).toEqual([])
	})

	it('accepts exactly one non-image (video)', () => {
		expect(linkedinAttachmentsArraySchema.parse([video()])).toHaveLength(1)
	})

	it('accepts exactly one non-image (document)', () => {
		expect(linkedinAttachmentsArraySchema.parse([document()])).toHaveLength(1)
	})

	it('rejects an image + video mix with the exact §4.2 message', () => {
		const parsed = linkedinAttachmentsArraySchema.safeParse([image(), video()])
		expect(parsed.success).toBe(false)
		if (!parsed.success) {
			expect(parsed.error.issues[0]?.message).toBe(LINKEDIN_ATTACHMENTS_MIXED_TYPES_MESSAGE)
		}
	})

	it('rejects an image + document mix with the exact §4.2 message', () => {
		const parsed = linkedinAttachmentsArraySchema.safeParse([image(), document()])
		expect(parsed.success).toBe(false)
		if (!parsed.success) {
			expect(parsed.error.issues[0]?.message).toBe(LINKEDIN_ATTACHMENTS_MIXED_TYPES_MESSAGE)
		}
	})

	it('rejects a video + document mix with the exact §4.2 message', () => {
		const parsed = linkedinAttachmentsArraySchema.safeParse([video(), document()])
		expect(parsed.success).toBe(false)
		if (!parsed.success) {
			expect(parsed.error.issues[0]?.message).toBe(LINKEDIN_ATTACHMENTS_MIXED_TYPES_MESSAGE)
		}
	})

	it('rejects two videos — a single non-image means at most ONE non-image', () => {
		const parsed = linkedinAttachmentsArraySchema.safeParse([video('a.mp4'), video('b.mp4')])
		expect(parsed.success).toBe(false)
	})
})

describe('R11 tool input schemas', () => {
	it('publishPostInputSchema accepts text-only', () => {
		const parsed = publishPostInputSchema.parse({ text: 'Hello LinkedIn.' })
		expect(parsed.text).toBe('Hello LinkedIn.')
		expect(parsed.attachment_file_ids).toBeUndefined()
	})

	it('publishPostInputSchema accepts workspace file ids for an image post', () => {
		const ids = ['0d3c5b7e-2f4a-4c1e-9a67-1b2c3d4e5f60', '5b1f6c2a-8d3e-4f70-a1b2-c3d4e5f60718']
		const parsed = publishPostInputSchema.parse({ text: 'Deck slides.', attachment_file_ids: ids })
		expect(parsed.attachment_file_ids).toEqual(ids)
	})

	it('publishPostInputSchema drops raw attachments: the agent never sends file bytes', () => {
		const parsed = publishPostInputSchema.parse({ text: 'Post.', attachments: [image()] })
		expect(parsed).not.toHaveProperty('attachments')
	})

	it('publishPostInputSchema rejects a file id that is not a uuid and more than 9 ids', () => {
		expect(
			publishPostInputSchema.safeParse({ text: 'x', attachment_file_ids: ['not-an-id'] }).success,
		).toBe(false)
		const ten = Array.from({ length: 10 }, () => '0d3c5b7e-2f4a-4c1e-9a67-1b2c3d4e5f60')
		expect(publishPostInputSchema.safeParse({ text: 'x', attachment_file_ids: ten }).success).toBe(
			false,
		)
	})

	it('sendMessageInputSchema accepts a text-only DM', () => {
		const parsed = sendMessageInputSchema.parse({
			recipient_urn: 'ACo-abc',
			body: 'Hi.',
			idempotency_key: 'abc:1',
		})
		expect(parsed).not.toHaveProperty('attachments')
	})

	it('sendMessageInputSchema drops attachments: a file goes out only on an approved object', () => {
		const parsed = sendMessageInputSchema.parse({
			recipient_urn: 'ACo-abc',
			body: 'File attached.',
			idempotency_key: 'abc:2',
			attachments: [document()],
		})
		expect(parsed).not.toHaveProperty('attachments')
	})

	it('editPostInputSchema accepts a text-only edit', () => {
		const parsed = editPostInputSchema.parse({
			post_id: 'mock-post-1',
			text: 'Updated body.',
		})
		expect(parsed.post_id).toBe('mock-post-1')
	})

	it('editPostInputSchema accepts a can_comment-only edit', () => {
		const parsed = editPostInputSchema.parse({
			post_id: 'mock-post-1',
			can_comment: 'no_one',
		})
		expect(parsed.can_comment).toBe('no_one')
	})

	it('editPostInputSchema rejects an edit with neither field', () => {
		const parsed = editPostInputSchema.safeParse({ post_id: 'mock-post-1' })
		expect(parsed.success).toBe(false)
		if (!parsed.success) {
			expect(parsed.error.issues[0]?.message).toBe(
				'At least one of text or can_comment is required.',
			)
		}
	})

	it('editPostInputSchema rejects can_comment outside the three-value enum', () => {
		const bad = editPostInputSchema.safeParse({
			post_id: 'mock-post-1',
			can_comment: 'friends',
		})
		expect(bad.success).toBe(false)
	})

	it('deletePostInputSchema accepts a bare post_id', () => {
		const parsed = deletePostInputSchema.parse({ post_id: 'mock-post-1' })
		expect(parsed.post_id).toBe('mock-post-1')
	})

	it('deletePostInputSchema rejects an empty post_id', () => {
		expect(() => deletePostInputSchema.parse({ post_id: '' })).toThrow()
	})
})

describe('R11 tool input schemas: forbidden identity-per-call fields', () => {
	// R11-A pre-scopes the acting identity at register-time (see
	// `LinkedInMcpInstanceConfig.identityUrn` in linkedin-mcp-context.ts).
	// If any of the four listed field names appear on any per-call tool
	// input, the fan-out contract is broken — an agent could carry a
	// different identity in the per-call args and side-step the register-time
	// pre-scoping.
	for (const [verb, shape] of Object.entries(LINKEDIN_R11_INPUT_SHAPES)) {
		for (const forbidden of FORBIDDEN_IDENTITY_PER_CALL_FIELDS) {
			it(`__${verb} has no "${forbidden}" field`, () => {
				expect(shape).not.toHaveProperty(forbidden)
			})
		}
	}
})
