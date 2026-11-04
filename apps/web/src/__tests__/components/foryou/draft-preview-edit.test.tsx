import { DraftPreview } from '@/components/foryou/draft-preview'
import type { LatestMentionDecisionDraft } from '@/lib/api'
import { clearDraftEdit, getDraftEdit } from '@/lib/foryou-draft-edits'
import { act, cleanup, render as rtlRender, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const render = (ui: React.ReactElement) => rtlRender(ui, { wrapper: TestWrapper })

const flag = vi.fn(() => true)
vi.mock('@/hooks/use-feature-flag', () => ({ useFeatureFlag: () => flag() }))
const useObject = vi.fn()
vi.mock('@/hooks/use-objects', () => ({ useObject: (id: string) => useObject(id) }))
vi.mock('@/components/shared/file-preview', () => ({ FilePreview: () => null }))

const POST = '--- POST ---\n\nThe post.\n\n--- MEDIA ---\nimage.png'
const draft: LatestMentionDecisionDraft = { object_id: 'obj-1', label: 'Email', body: 'Hej Hans.' }

const loaded = (content: string, previewBody?: string) =>
	useObject.mockReturnValue({
		data: {
			workspaceId: 'ws-1',
			content,
			preview: previewBody ? { body: previewBody, content_hash: 'h' } : null,
		},
	})

afterEach(() => {
	// Unmount first: clearing an edit tells every mounted box.
	cleanup()
	clearDraftEdit('obj-1')
	flag.mockReturnValue(true)
	useObject.mockReset()
})

describe('DraftPreview editing', () => {
	it('shows the text as a box the person can change, and holds the change', async () => {
		loaded('Hej Hans.')
		render(<DraftPreview workspaceId="ws-1" draft={draft} />)
		const box = screen.getByRole('textbox', { name: 'Edit the text' })
		expect(box).toHaveValue('Hej Hans.')

		await userEvent.type(box, ' Ses vi?')

		expect(box).toHaveValue('Hej Hans. Ses vi?')
		expect(getDraftEdit('obj-1')).toBe('Hej Hans. Ses vi?')
	})

	it('drops the held change when the text is put back', async () => {
		loaded('Hej')
		render(<DraftPreview workspaceId="ws-1" draft={{ ...draft, body: 'Hej' }} />)
		const box = screen.getByRole('textbox', { name: 'Edit the text' })
		await userEvent.type(box, '!')
		await userEvent.type(box, '{Backspace}')
		expect(getDraftEdit('obj-1')).toBeUndefined()
	})

	it('edits only the post of a LinkedIn post that carries a header', () => {
		loaded(POST, 'The post.')
		render(<DraftPreview workspaceId="ws-1" draft={{ ...draft, body: 'The post.' }} />)
		expect(screen.getByRole('textbox', { name: 'Edit the text' })).toHaveValue('The post.')
	})

	it('follows the object when an agent edits it, with no reload', () => {
		loaded('Hej Hans.')
		const { rerender } = render(<DraftPreview workspaceId="ws-1" draft={draft} />)
		loaded('Hej Hans, ny tekst.')
		act(() => rerender(<DraftPreview workspaceId="ws-1" draft={draft} />))
		expect(screen.getByRole('textbox', { name: 'Edit the text' })).toHaveValue(
			'Hej Hans, ny tekst.',
		)
	})

	it('stays read only when the message cannot be told from the rest of the text', () => {
		loaded('Header line\nThe post.', 'The post.')
		render(<DraftPreview workspaceId="ws-1" draft={{ ...draft, body: 'The post.' }} />)
		expect(screen.queryByRole('textbox')).toBeNull()
		expect(screen.getByText('The post.')).toBeInTheDocument()
	})

	it('stays read only while the object has not loaded', () => {
		useObject.mockReturnValue({ data: undefined })
		render(<DraftPreview workspaceId="ws-1" draft={draft} />)
		expect(screen.queryByRole('textbox')).toBeNull()
		expect(screen.getByText('Hej Hans.')).toBeInTheDocument()
	})

	it('stays read only with the flag off', () => {
		flag.mockReturnValue(false)
		render(<DraftPreview workspaceId="ws-1" draft={draft} />)
		expect(screen.queryByRole('textbox')).toBeNull()
		expect(useObject).not.toHaveBeenCalled()
	})
})
