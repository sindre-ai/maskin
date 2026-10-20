import type { MessageDraft } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const transitionMutate = vi.fn()
const sendMutate = vi.fn()
const sendReset = vi.fn()
let task: Record<string, unknown> | undefined
let transitionError: Error | null = null
let sendError = false

vi.mock('@/hooks/use-objects', () => ({
	useObject: () => ({ data: task }),
	useDraftTransition: () => ({
		mutate: transitionMutate,
		isPending: false,
		variables: undefined,
		error: transitionError,
	}),
}))

vi.mock('@/hooks/use-conversation', () => ({
	useSendMessage: () => ({
		mutate: sendMutate,
		reset: sendReset,
		isPending: false,
		isError: sendError,
	}),
}))

import { DraftCard } from '@/components/chat/draft-card'

const EMAIL: MessageDraft = {
	object_id: 'task-1',
	kind: 'email',
	to: 'Mette Holm, Northwind',
}

const BODY = 'Hi Mette,\n\nBest,\nSeb'

function buildTask(overrides: { content?: string; draft?: Record<string, unknown> | null } = {}) {
	const draft =
		overrides.draft === null
			? {}
			: {
					draft_state: 'draft',
					draft_subject: 'Following up',
					draft_original_subject: 'Following up',
					draft_original_body: BODY,
					...overrides.draft,
				}
	return {
		id: 'task-1',
		content: overrides.content ?? BODY,
		metadata: { ...draft, unrelated: 'kept' },
	}
}

function renderCard(draft: MessageDraft = EMAIL) {
	return render(
		<DraftCard workspaceId="ws-1" conversationId="conv-1" agentId="agent-1" draft={draft} />,
		{ wrapper: TestWrapper },
	)
}

describe('DraftCard', () => {
	beforeEach(() => {
		transitionMutate.mockReset()
		sendMutate.mockReset()
		sendReset.mockReset()
		transitionError = null
		sendError = false
		task = buildTask()
	})

	it('shows the recipient, subject and body of the task', () => {
		renderCard()

		expect(screen.getByText('EMAIL DRAFT')).toBeInTheDocument()
		expect(screen.getByText('Mette Holm, Northwind')).toBeInTheDocument()
		expect(screen.getByRole('textbox', { name: 'Subject' })).toHaveValue('Following up')
		expect(screen.getByRole('textbox', { name: 'Draft text' })).toHaveValue(BODY)
		expect(screen.getByText('Draft')).toBeInTheDocument()
	})

	it('renders nothing when the task carries no draft state', () => {
		task = buildTask({ draft: null })

		const { container } = renderCard()

		expect(container).toBeEmptyDOMElement()
	})

	it('saves an edited body through the draft transition on blur', async () => {
		const user = userEvent.setup()
		renderCard()

		const body = screen.getByRole('textbox', { name: 'Draft text' })
		await user.clear(body)
		await user.type(body, 'Short version.')
		await user.tab()

		expect(transitionMutate).toHaveBeenCalledTimes(1)
		const { id, data } = transitionMutate.mock.calls[0][0]
		expect(id).toBe('task-1')
		expect(data).toEqual({
			action: 'edit',
			expected_state: 'draft',
			body: 'Short version.',
			subject: 'Following up',
		})
	})

	it('does not save on blur when nothing was typed', async () => {
		const user = userEvent.setup()
		renderCard()

		await user.click(screen.getByRole('textbox', { name: 'Draft text' }))
		await user.tab()

		expect(transitionMutate).not.toHaveBeenCalled()
	})

	it('keeps what the person typed until the server has accepted the save', async () => {
		const user = userEvent.setup()
		renderCard()

		const body = screen.getByRole('textbox', { name: 'Draft text' })
		await user.clear(body)
		await user.type(body, 'Short version.')
		await user.tab()

		// The mutation never calls onSuccess, as when the server refuses it.
		expect(screen.getByRole('textbox', { name: 'Draft text' })).toHaveValue('Short version.')
	})

	it('shows the server error when a change is refused', () => {
		transitionError = new Error('The draft has changed since you opened it')

		renderCard()

		expect(screen.getByText('The draft has changed since you opened it')).toBeInTheDocument()
	})

	it('marks a draft whose text differs from the original as Edited and offers a restore', async () => {
		task = buildTask({ content: 'Changed.' })

		renderCard()
		await userEvent.click(screen.getByRole('button', { name: /restore original/i }))

		expect(screen.getByText('Edited')).toBeInTheDocument()
		expect(transitionMutate.mock.calls[0][0].data).toEqual({
			action: 'restore',
			expected_state: 'draft',
		})
	})

	it('approves with the text and subject on screen, from the draft state it saw', async () => {
		renderCard()

		await userEvent.click(screen.getByRole('button', { name: 'Approve and send' }))

		expect(transitionMutate.mock.calls[0][0].data).toEqual({
			action: 'approve',
			expected_state: 'draft',
			body: BODY,
			subject: 'Following up',
		})
	})

	it('approves text that was typed but not yet saved', async () => {
		const user = userEvent.setup()
		renderCard()

		const body = screen.getByRole('textbox', { name: 'Draft text' })
		await user.clear(body)
		await user.type(body, 'Typed last.')
		await user.click(screen.getByRole('button', { name: 'Approve and send' }))

		const approve = transitionMutate.mock.calls.find(([v]) => v.data.action === 'approve')
		expect(approve?.[0].data.body).toBe('Typed last.')
	})

	it('tells the agent in the chat only after the approval is saved', async () => {
		renderCard()

		await userEvent.click(screen.getByRole('button', { name: 'Approve and send' }))

		expect(sendMutate).not.toHaveBeenCalled()
		transitionMutate.mock.calls[0][1].onSuccess()
		const message = sendMutate.mock.calls[0][0]
		expect(message.content).toBe(
			'Approved the email to Mette Holm, Northwind. Send it exactly as saved in task task-1.',
		)
		expect(message.metadata).toEqual({ mentions: ['agent-1'] })
	})

	it('does not message the agent while the approval has not been accepted', async () => {
		renderCard()

		await userEvent.click(screen.getByRole('button', { name: 'Approve and send' }))

		// A refused approval (409) never reaches onSuccess, so a second tab that lost
		// the race does not tell the agent a second time.
		expect(sendMutate).not.toHaveBeenCalled()
	})

	it('does not message the agent when an approval is undone', async () => {
		task = buildTask({ draft: { draft_state: 'approved' } })

		renderCard()
		await userEvent.click(screen.getByRole('button', { name: 'Undo' }))

		expect(sendMutate).not.toHaveBeenCalled()
		expect(sendReset).toHaveBeenCalled()
	})

	it('says the agent was not told when the approval message fails, and lets the person retry', async () => {
		task = buildTask({ draft: { draft_state: 'approved' } })
		sendError = true

		renderCard()

		expect(screen.getByText('Approved, but the agent was not told.')).toBeInTheDocument()
		await userEvent.click(screen.getByRole('button', { name: 'Tell the agent' }))
		expect(sendMutate.mock.calls[0][0].metadata).toEqual({ mentions: ['agent-1'] })
	})

	it('locks an approved draft and lets the person undo the approval', async () => {
		task = buildTask({ draft: { draft_state: 'approved' } })

		renderCard()

		expect(screen.getByRole('textbox', { name: 'Draft text' })).toBeDisabled()
		expect(screen.getByText('Approved to send')).toBeInTheDocument()
		await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
		expect(transitionMutate.mock.calls[0][0].data).toEqual({
			action: 'undo',
			expected_state: 'approved',
		})
	})

	it('blocks approval while a LinkedIn note is over its character limit', () => {
		task = buildTask({ content: 'x'.repeat(301) })

		renderCard({ object_id: 'task-1', kind: 'linkedin_message', char_limit: 300 })

		expect(screen.getByText('301 / 300')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
	})

	it('uses the label and approve text of a draft kind the app has no preset for', () => {
		renderCard({
			object_id: 'task-1',
			kind: 'text',
			label: 'Slack message',
			approve_label: 'Approve and post',
		})

		expect(screen.getByText('SLACK MESSAGE')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Approve and post' })).toBeInTheDocument()
	})

	it('shows no email fields for a post, and takes its button text from approve_label', () => {
		renderCard({ object_id: 'task-1', kind: 'linkedin_post', approve_label: 'Approve and post' })

		expect(screen.getByText('LINKEDIN POST')).toBeInTheDocument()
		expect(screen.queryByRole('textbox', { name: 'Subject' })).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Approve and post' })).toBeInTheDocument()
	})

	it('sends no subject when approving a post', async () => {
		renderCard({ object_id: 'task-1', kind: 'linkedin_post' })

		await userEvent.click(screen.getByRole('button', { name: 'Approve' }))

		expect(transitionMutate.mock.calls[0][0].data).toEqual({
			action: 'approve',
			expected_state: 'draft',
			body: BODY,
		})
	})

	it('handles a channel the app has never heard of with no code change', () => {
		renderCard({ object_id: 'task-1', kind: 'instagram_caption', char_limit: 2200 })

		expect(screen.getByText('INSTAGRAM CAPTION')).toBeInTheDocument()
		expect(screen.queryByRole('textbox', { name: 'Subject' })).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
		expect(screen.getByText(/\/ 2200/)).toBeInTheDocument()
	})
})
