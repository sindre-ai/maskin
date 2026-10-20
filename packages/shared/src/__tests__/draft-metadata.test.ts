import { describe, expect, it } from 'vitest'
import {
	draftTaskStateToMetadata,
	formatDraftAsMarkdown,
	messageMetadataSchema,
	readDraftTaskState,
	stripServerOwnedMetadata,
} from '../schemas/conversations'
import { updateObjectSchema } from '../schemas/objects'

const TASK_ID = '22222222-2222-2222-2222-222222222222'

describe('stripServerOwnedMetadata draft', () => {
	it('removes draft so a client cannot forge a draft card', () => {
		const stripped = stripServerOwnedMetadata({
			mentions: [TASK_ID],
			draft: { object_id: TASK_ID, kind: 'email' },
		})

		expect(stripped).toEqual({ mentions: [TASK_ID] })
	})
})

describe('messageMetadataSchema draft', () => {
	it('accepts a task id and a kind', () => {
		const parsed = messageMetadataSchema.safeParse({
			draft: { object_id: TASK_ID, kind: 'linkedin_message', char_limit: 300 },
		})

		expect(parsed.success).toBe(true)
	})

	it('rejects an unknown kind', () => {
		const parsed = messageMetadataSchema.safeParse({
			draft: { object_id: TASK_ID, kind: 'carrier_pigeon' },
		})

		expect(parsed.success).toBe(false)
	})
})

describe('formatDraftAsMarkdown', () => {
	it('quotes the body under the recipient and subject', () => {
		const md = formatDraftAsMarkdown({
			to: 'Mette Holm, Northwind',
			subject: 'Following up',
			body: 'Hi Mette,\n\nBest,\nSeb',
		})

		expect(md).toBe(
			'**To:** Mette Holm, Northwind\n\n**Subject:** Following up\n\n> Hi Mette,\n>\n> Best,\n> Seb',
		)
	})

	it('omits the header lines a post does not have', () => {
		expect(formatDraftAsMarkdown({ body: 'We shipped it.' })).toBe('> We shipped it.')
	})
})

describe('readDraftTaskState', () => {
	it('reads the flat draft_* keys of a task', () => {
		const state = readDraftTaskState({ draft_state: 'draft', draft_original_body: 'Hi' })

		expect(state).toEqual({ state: 'draft', original_body: 'Hi' })
	})

	it('treats a null key as absent', () => {
		const state = readDraftTaskState({
			draft_state: 'draft',
			draft_original_body: 'Hi',
			draft_approved_at: null,
		})

		expect(state).toEqual({ state: 'draft', original_body: 'Hi' })
	})

	it('returns null when the keys are missing or malformed', () => {
		expect(readDraftTaskState({})).toBeNull()
		expect(readDraftTaskState({ draft_state: 'sent', draft_original_body: 'Hi' })).toBeNull()
		expect(readDraftTaskState(null)).toBeNull()
	})
})

describe('draftTaskStateToMetadata', () => {
	it('round-trips through the task metadata and passes the object write schema', () => {
		const state = {
			state: 'approved' as const,
			subject: 'Following up',
			original_subject: 'Following up',
			original_body: 'Hi',
			approved_at: '2026-10-20T08:00:00.000Z',
		}

		const metadata = draftTaskStateToMetadata(state)

		expect(readDraftTaskState(metadata)).toEqual(state)
		expect(updateObjectSchema.safeParse({ metadata }).success).toBe(true)
	})

	it('nulls cleared fields so an undo overwrites the old approval time', () => {
		const metadata = draftTaskStateToMetadata({ state: 'draft', original_body: 'Hi' })

		expect(metadata.draft_approved_at).toBeNull()
	})
})
