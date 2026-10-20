import { describe, expect, it } from 'vitest'
import {
	applyDraftTransition,
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

	it('accepts a channel it has never heard of, so a new platform needs no code change', () => {
		const parsed = messageMetadataSchema.safeParse({
			draft: { object_id: TASK_ID, kind: 'tiktok_caption', char_limit: 2200 },
		})

		expect(parsed.success).toBe(true)
	})

	it('rejects a kind that is not a lowercase identifier', () => {
		for (const kind of ['', 'Carrier Pigeon', '1post', 'a-b']) {
			const parsed = messageMetadataSchema.safeParse({ draft: { object_id: TASK_ID, kind } })
			expect(parsed.success).toBe(false)
		}
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

describe('applyDraftTransition', () => {
	const NOW = new Date('2026-10-20T08:00:00.000Z')
	const task = (state: 'draft' | 'approved', content = 'Hi Mette') => ({
		content,
		metadata: draftTaskStateToMetadata({
			state,
			subject: 'Following up',
			original_subject: 'Following up',
			original_body: 'Hi',
		}),
	})

	it('saves an edit to an unapproved draft and keeps the subject unless it is sent', () => {
		const result = applyDraftTransition(
			task('draft'),
			{ action: 'edit', expected_state: 'draft', body: 'Shorter.' },
			NOW,
		)

		expect(result).toMatchObject({
			ok: true,
			content: 'Shorter.',
			state: { state: 'draft', subject: 'Following up' },
		})
	})

	it('approves with the text it is given and stamps the time', () => {
		const result = applyDraftTransition(
			task('draft'),
			{ action: 'approve', expected_state: 'draft', body: 'Final.', subject: 'Final subject' },
			NOW,
		)

		expect(result).toMatchObject({
			ok: true,
			content: 'Final.',
			state: { state: 'approved', subject: 'Final subject', approved_at: NOW.toISOString() },
		})
	})

	it('refuses to approve an empty draft', () => {
		const result = applyDraftTransition(
			task('draft'),
			{ action: 'approve', expected_state: 'draft', body: '   ' },
			NOW,
		)

		expect(result).toEqual({ ok: false, reason: 'empty_body' })
	})

	it.each(['edit', 'approve', 'restore'] as const)(
		'refuses to %s a draft that is already approved',
		(action) => {
			const result = applyDraftTransition(
				task('approved'),
				{ action, expected_state: 'draft', body: 'Changed after approval.' },
				NOW,
			)

			expect(result).toEqual({ ok: false, reason: 'state_changed' })
		},
	)

	it('refuses a change when the card saw a different state than the task is in', () => {
		const result = applyDraftTransition(
			task('draft'),
			{ action: 'undo', expected_state: 'approved' },
			NOW,
		)

		expect(result).toEqual({ ok: false, reason: 'state_changed' })
	})

	it('undoes an approval, keeping the text and clearing the approval time', () => {
		const result = applyDraftTransition(
			task('approved', 'Approved text'),
			{ action: 'undo', expected_state: 'approved' },
			NOW,
		)

		expect(result).toMatchObject({
			ok: true,
			content: 'Approved text',
			state: { state: 'draft', approved_at: undefined },
		})
	})

	it('restores the original text and subject', () => {
		const result = applyDraftTransition(
			task('draft', 'Edited'),
			{ action: 'restore', expected_state: 'draft' },
			NOW,
		)

		expect(result).toMatchObject({
			ok: true,
			content: 'Hi',
			state: { subject: 'Following up' },
		})
	})

	it('says so when the task is not a draft', () => {
		const result = applyDraftTransition(
			{ content: 'x', metadata: {} },
			{ action: 'edit', expected_state: 'draft', body: 'y' },
			NOW,
		)

		expect(result).toEqual({ ok: false, reason: 'not_a_draft' })
	})
})
