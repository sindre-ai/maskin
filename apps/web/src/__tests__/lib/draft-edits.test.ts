import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', () => ({
	api: { objects: { get: vi.fn(), update: vi.fn(), approve: vi.fn() } },
	ApiError: class ApiError extends Error {
		constructor(
			public status: number,
			message: string,
		) {
			super(message)
		}
	},
}))

import { ApiError, api } from '@/lib/api'
import {
	DraftChangedError,
	approveDraftText,
	clearDraftEdit,
	getDraftChange,
	getDraftEdit,
	saveDraftEdit,
	setDraftEdit,
	spliceDraftText,
} from '@/lib/draft-edits'

const POST = [
	'Account: sebk_personal',
	'Angle: hiring',
	'',
	'--- POST ---',
	'',
	'The hook.',
	'',
	'Second line.',
	'',
	'--- MEDIA ---',
	'diagram.png',
].join('\n')

describe('spliceDraftText', () => {
	it('replaces a text that is all message', () => {
		expect(spliceDraftText('Hej Hans.', 'Hej Hans.', 'Hej Hans, hvordan går det?')).toBe(
			'Hej Hans, hvordan går det?',
		)
	})

	it('changes only the lines between the POST and MEDIA markers', () => {
		const next = spliceDraftText(POST, 'The hook.\n\nSecond line.', 'A better hook.')
		expect(next).toBe(
			[
				'Account: sebk_personal',
				'Angle: hiring',
				'',
				'--- POST ---',
				'',
				'A better hook.',
				'',
				'--- MEDIA ---',
				'diagram.png',
			].join('\n'),
		)
	})

	it('keeps CRLF line endings', () => {
		const crlf = POST.replace(/\n/g, '\r\n')
		const next = spliceDraftText(crlf, 'The hook.\n\nSecond line.', 'New.')
		expect(next).toContain('--- POST ---\r\n\r\nNew.\r\n\r\n--- MEDIA ---\r\ndiagram.png')
	})

	it('leaves a post with no end marker open to the end', () => {
		const open = '--- POST ---\n\nBody.'
		expect(spliceDraftText(open, 'Body.', 'Changed.')).toBe('--- POST ---\n\nChanged.')
	})

	it('refuses a body where the message cannot be told from the rest', () => {
		expect(spliceDraftText('Header\nBody', 'Body', 'x')).toBeNull()
		expect(spliceDraftText(`${POST}\n--- POST ---\nAgain`, 'The hook.', 'x')).toBeNull()
		expect(spliceDraftText(`${POST}\n--- MEDIA ---`, 'The hook.', 'x')).toBeNull()
		expect(spliceDraftText(POST, 'Some other text', 'x')).toBeNull()
	})
})

describe('saveDraftEdit', () => {
	const draft = {
		object_id: 'obj-1',
		body: 'Hej Hans.',
		preview: { content_hash: 'h1' } as never,
	}

	beforeEach(() => {
		vi.mocked(api.objects.get).mockReset()
		vi.mocked(api.objects.update).mockReset()
		clearDraftEdit('obj-1')
	})

	it('saves the edit and returns the preview of the saved text', async () => {
		vi.mocked(api.objects.get).mockResolvedValue({
			content: 'Hej Hans.',
			preview: { body: 'Hej Hans.', content_hash: 'h1' },
		} as never)
		vi.mocked(api.objects.update).mockResolvedValue({
			content: 'Hej Hans, ses vi?',
			preview: { body: 'Hej Hans, ses vi?', content_hash: 'h2' },
		} as never)
		setDraftEdit('obj-1', 'Hej Hans, ses vi?')

		const preview = await saveDraftEdit(draft, 'Hej Hans, ses vi?')

		expect(api.objects.update).toHaveBeenCalledWith('obj-1', { content: 'Hej Hans, ses vi?' })
		expect(preview?.content_hash).toBe('h2')
		expect(getDraftEdit('obj-1')).toBeUndefined()
	})

	it('writes only the post block of a post that carries a header', async () => {
		vi.mocked(api.objects.get).mockResolvedValue({
			content: POST,
			preview: { body: 'The hook.\n\nSecond line.', content_hash: 'h1' },
		} as never)
		vi.mocked(api.objects.update).mockResolvedValue({ preview: { content_hash: 'h2' } } as never)

		await saveDraftEdit(draft, 'A better hook.')

		const sent = vi.mocked(api.objects.update).mock.calls[0]?.[1]?.content
		expect(sent).toContain('Account: sebk_personal')
		expect(sent).toContain('--- MEDIA ---\ndiagram.png')
		expect(sent).toContain('A better hook.')
		expect(sent).not.toContain('Second line.')
	})

	it('does not save or send when the draft changed under the person, and shows the new text', async () => {
		vi.mocked(api.objects.get).mockResolvedValue({
			content: 'Hej Hans, i morgen?',
			preview: { body: 'Hej Hans, i morgen?', content_hash: 'h-agent' },
		} as never)
		setDraftEdit('obj-1', 'Hej Hans, ses vi?')

		await expect(saveDraftEdit(draft, 'Hej Hans, ses vi?')).rejects.toBeInstanceOf(
			DraftChangedError,
		)

		expect(api.objects.update).not.toHaveBeenCalled()
		expect(getDraftEdit('obj-1')).toBeUndefined()
		expect(getDraftChange('obj-1')).toBe('Hej Hans, i morgen?')
	})

	it('compares the text of a draft with no preview', async () => {
		vi.mocked(api.objects.get).mockResolvedValue({ content: 'Changed.', preview: null } as never)
		await expect(
			saveDraftEdit({ object_id: 'obj-1', body: 'Plain.' }, 'Mine.'),
		).rejects.toBeInstanceOf(DraftChangedError)
		expect(api.objects.update).not.toHaveBeenCalled()
	})

	it('refuses an empty text', async () => {
		await expect(saveDraftEdit(draft, '   ')).rejects.toThrow('empty')
		expect(api.objects.get).not.toHaveBeenCalled()
	})
})

describe('approveDraftText', () => {
	const draft = {
		object_id: 'obj-1',
		body: 'Hej Hans.',
		preview: { content_hash: 'h1' } as never,
	}

	beforeEach(() => {
		vi.mocked(api.objects.get).mockReset()
		vi.mocked(api.objects.update).mockReset()
		vi.mocked(api.objects.approve).mockReset()
		clearDraftEdit('obj-1')
	})

	it('approves the hash the card showed when nothing was edited', async () => {
		vi.mocked(api.objects.approve).mockResolvedValue({ approval_id: 1, preview: {} } as never)
		await approveDraftText(draft, { conversation_id: 'c', agent_id: 'a' })
		expect(api.objects.update).not.toHaveBeenCalled()
		expect(api.objects.approve).toHaveBeenCalledWith('obj-1', 'h1', {
			conversation_id: 'c',
			agent_id: 'a',
		})
	})

	it('saves an edit first and approves the hash of the saved text', async () => {
		vi.mocked(api.objects.get).mockResolvedValue({
			content: 'Hej Hans.',
			preview: { body: 'Hej Hans.', content_hash: 'h1' },
		} as never)
		vi.mocked(api.objects.update).mockResolvedValue({
			preview: { body: 'Hej Hans, ses vi?', content_hash: 'h2' },
		} as never)
		vi.mocked(api.objects.approve).mockResolvedValue({ approval_id: 1, preview: {} } as never)
		setDraftEdit('obj-1', 'Hej Hans, ses vi?')

		await approveDraftText(draft)

		expect(api.objects.update).toHaveBeenCalledWith('obj-1', { content: 'Hej Hans, ses vi?' })
		expect(api.objects.approve).toHaveBeenCalledWith('obj-1', 'h2', undefined)
		expect(vi.mocked(api.objects.update).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(api.objects.approve).mock.invocationCallOrder[0] ?? 0,
		)
	})

	it('approves nothing when the draft changed before the save', async () => {
		vi.mocked(api.objects.get).mockResolvedValue({
			content: 'Hej Hans, i morgen?',
			preview: { body: 'Hej Hans, i morgen?', content_hash: 'h-agent' },
		} as never)
		setDraftEdit('obj-1', 'Hej Hans, ses vi?')

		await expect(approveDraftText(draft)).rejects.toBeInstanceOf(DraftChangedError)

		expect(api.objects.update).not.toHaveBeenCalled()
		expect(api.objects.approve).not.toHaveBeenCalled()
		expect(getDraftChange('obj-1')).toBe('Hej Hans, i morgen?')
	})

	it('shows the new text and approves nothing when the server answers 409', async () => {
		vi.mocked(api.objects.approve).mockRejectedValue(new ApiError(409, 'The draft changed'))
		vi.mocked(api.objects.get).mockResolvedValue({
			content: 'Hej Hans, i morgen?',
			preview: { body: 'Hej Hans, i morgen?', content_hash: 'h-agent' },
		} as never)

		await expect(approveDraftText(draft)).rejects.toBeInstanceOf(DraftChangedError)

		expect(getDraftChange('obj-1')).toBe('Hej Hans, i morgen?')
	})

	it('passes any other approval failure on unchanged', async () => {
		vi.mocked(api.objects.approve).mockRejectedValue(new ApiError(403, 'Only a person can approve'))
		await expect(approveDraftText(draft)).rejects.toBeInstanceOf(ApiError)
		expect(getDraftChange('obj-1')).toBeUndefined()
	})
})
