import type { MessageDraft } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const updateMutate = vi.fn()
let task: Record<string, unknown> | undefined

vi.mock('@/hooks/use-objects', () => ({
	useObject: () => ({ data: task }),
	useUpdateObject: () => ({ mutate: updateMutate, isPending: false }),
}))

import { DraftCard } from '@/components/chat/draft-card'

const EMAIL: MessageDraft = {
	object_id: 'task-1',
	kind: 'email',
	to: 'Mette Holm, Northwind',
}

function buildTask(overrides: { content?: string; draft?: Record<string, unknown> | null } = {}) {
	const draft =
		overrides.draft === null
			? {}
			: {
					draft_state: 'draft',
					draft_subject: 'Following up',
					draft_original_subject: 'Following up',
					draft_original_body: 'Hi Mette,\n\nBest,\nSeb',
					...overrides.draft,
				}
	return {
		id: 'task-1',
		content: overrides.content ?? 'Hi Mette,\n\nBest,\nSeb',
		metadata: { ...draft, unrelated: 'kept' },
	}
}

function renderCard(draft: MessageDraft = EMAIL) {
	return render(<DraftCard workspaceId="ws-1" draft={draft} />, { wrapper: TestWrapper })
}

describe('DraftCard', () => {
	beforeEach(() => {
		updateMutate.mockReset()
		task = buildTask()
	})

	it('shows the recipient, subject and body of the task', () => {
		renderCard()

		expect(screen.getByText('EMAIL DRAFT')).toBeInTheDocument()
		expect(screen.getByText('Mette Holm, Northwind')).toBeInTheDocument()
		expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveValue('Following up')
		expect(screen.getByRole('textbox', { name: 'Draft text' })).toHaveValue(
			'Hi Mette,\n\nBest,\nSeb',
		)
		expect(screen.getByText('Draft')).toBeInTheDocument()
	})

	it('renders nothing when the task carries no draft state', () => {
		task = buildTask({ draft: null })

		const { container } = renderCard()

		expect(container).toBeEmptyDOMElement()
	})

	it('saves an edited body to the task on blur and keeps other metadata', async () => {
		const user = userEvent.setup()
		renderCard()

		const body = screen.getByRole('textbox', { name: 'Draft text' })
		await user.clear(body)
		await user.type(body, 'Short version.')
		await user.tab()

		expect(updateMutate).toHaveBeenCalledTimes(1)
		const { id, data } = updateMutate.mock.calls[0][0]
		expect(id).toBe('task-1')
		expect(data.content).toBe('Short version.')
		expect(data.metadata.unrelated).toBe('kept')
		expect(data.metadata.draft_original_body).toBe('Hi Mette,\n\nBest,\nSeb')
	})

	it('marks a draft whose text differs from the original as Edited and offers a restore', async () => {
		task = buildTask({ content: 'Changed.' })

		renderCard()
		await userEvent.click(screen.getByRole('button', { name: /restore original/i }))

		expect(screen.getByText('Edited')).toBeInTheDocument()
		const { data } = updateMutate.mock.calls[0][0]
		expect(data.content).toBe('Hi Mette,\n\nBest,\nSeb')
	})

	it('records the approval on the task with the current text', async () => {
		renderCard()

		await userEvent.click(screen.getByRole('button', { name: 'Approve and send' }))

		const { data } = updateMutate.mock.calls[0][0]
		expect(data.metadata.draft_state).toBe('approved')
		expect(data.metadata.draft_approved_at).toEqual(expect.any(String))
		expect(data.content).toBe('Hi Mette,\n\nBest,\nSeb')
	})

	it('locks an approved draft and lets the person undo the approval', async () => {
		task = buildTask({ draft: { draft_state: 'approved' } })

		renderCard()

		expect(screen.getByRole('textbox', { name: 'Draft text' })).toBeDisabled()
		expect(screen.getByText('Approved to send')).toBeInTheDocument()
		await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
		expect(updateMutate.mock.calls[0][0].data.metadata.draft_state).toBe('draft')
	})

	it('blocks approval while a LinkedIn note is over its character limit', () => {
		task = buildTask({ content: 'x'.repeat(301) })

		renderCard({ object_id: 'task-1', kind: 'linkedin_message', char_limit: 300 })

		expect(screen.getByText('301 / 300')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Approve and send' })).toBeDisabled()
	})

	it('uses the post verb and no email fields for a LinkedIn post', () => {
		renderCard({ object_id: 'task-1', kind: 'linkedin_post' })

		expect(screen.getByText('LINKEDIN POST')).toBeInTheDocument()
		expect(screen.queryByRole('textbox', { name: 'Subject' })).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Approve and post' })).toBeInTheDocument()
	})
})
