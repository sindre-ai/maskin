import type { MessageQuestion } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const sendMutate = vi.fn()

vi.mock('@/hooks/use-conversation', () => ({
	useSendMessage: () => ({ mutate: sendMutate, isPending: false, isError: false }),
}))

import { QuestionOptions } from '@/components/chat/question-options'

const QUESTION: MessageQuestion = {
	session_id: '11111111-1111-1111-1111-111111111111',
	questions: [
		{
			question: 'How should I reach Spotify?',
			header: 'Spotify access',
			multi_select: false,
			options: [
				{ label: 'API token', description: 'You create a developer app' },
				{ label: 'No login' },
			],
		},
	],
}

function renderOptions(question: MessageQuestion = QUESTION, answered = false) {
	return render(
		<QuestionOptions
			conversationId="conv-1"
			workspaceId="ws-1"
			questionMessageId={7}
			question={question}
			answered={answered}
		/>,
		{ wrapper: TestWrapper },
	)
}

describe('QuestionOptions', () => {
	it('sends the pick as a chat message tagged with the question it answers', async () => {
		sendMutate.mockClear()
		const user = userEvent.setup()
		renderOptions()

		await user.click(screen.getByRole('button', { name: 'API token' }))
		await user.click(screen.getByRole('button', { name: 'Send answer' }))

		expect(sendMutate).toHaveBeenCalledTimes(1)
		const payload = sendMutate.mock.calls[0]?.[0]
		expect(payload.metadata.question_answer).toEqual({
			question_message_id: 7,
			answers: [{ header: 'Spotify access', selected: ['API token'] }],
		})
		// The agent's next turn sees only this content, so it has to restate the
		// question — a bare "API token" is ambiguous across a multi-question set.
		expect(payload.content).toContain('How should I reach Spotify?')
		expect(payload.content).toContain('API token')
	})

	it('cannot send until every question has a pick', async () => {
		const user = userEvent.setup()
		renderOptions({
			...QUESTION,
			questions: [
				...QUESTION.questions,
				{
					question: 'Which city is the office in?',
					header: 'City',
					multi_select: false,
					options: [{ label: 'Oslo' }, { label: 'Bergen' }],
				},
			],
		})

		expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled()
		await user.click(screen.getByRole('button', { name: 'API token' }))
		expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled()
		await user.click(screen.getByRole('button', { name: 'Oslo' }))
		expect(screen.getByRole('button', { name: 'Send answer' })).toBeEnabled()
	})

	it('keeps two questions independent when they share a header', async () => {
		// Nothing makes headers unique — the schema validates each one on its own,
		// and the hook defaults an unheadered question to the literal 'Question',
		// so two unheadered questions always collide. Header-keyed state made one
		// click select both and let a single pick satisfy the whole set.
		sendMutate.mockClear()
		const user = userEvent.setup()
		renderOptions({
			...QUESTION,
			questions: [
				{
					question: 'Which environment?',
					header: 'Question',
					multi_select: false,
					options: [{ label: 'Staging' }, { label: 'Production' }],
				},
				{
					question: 'Which region?',
					header: 'Question',
					multi_select: false,
					options: [{ label: 'Oslo' }, { label: 'Helsinki' }],
				},
			],
		})

		await user.click(screen.getByRole('button', { name: 'Staging' }))
		// A collision would satisfy both questions off this one click.
		expect(screen.getByRole('button', { name: 'Send answer' })).toBeDisabled()
		expect(screen.getByRole('button', { name: 'Oslo' })).toHaveAttribute('aria-pressed', 'false')

		await user.click(screen.getByRole('button', { name: 'Oslo' }))
		await user.click(screen.getByRole('button', { name: 'Send answer' }))

		expect(sendMutate.mock.calls[0]?.[0].metadata.question_answer.answers).toEqual([
			{ header: 'Question', selected: ['Staging'] },
			{ header: 'Question', selected: ['Oslo'] },
		])
	})

	it('replaces the pick on a single-select question', async () => {
		const user = userEvent.setup()
		renderOptions()

		await user.click(screen.getByRole('button', { name: 'API token' }))
		await user.click(screen.getByRole('button', { name: 'No login' }))

		expect(screen.getByRole('button', { name: 'API token' })).toHaveAttribute(
			'aria-pressed',
			'false',
		)
		expect(screen.getByRole('button', { name: 'No login' })).toHaveAttribute('aria-pressed', 'true')
	})

	it('accumulates picks on a multi-select question', async () => {
		const user = userEvent.setup()
		const [single] = QUESTION.questions
		if (!single) throw new Error('fixture is missing its question')
		renderOptions({ ...QUESTION, questions: [{ ...single, multi_select: true }] })

		await user.click(screen.getByRole('button', { name: 'API token' }))
		await user.click(screen.getByRole('button', { name: 'No login' }))

		expect(screen.getByRole('button', { name: 'API token' })).toHaveAttribute(
			'aria-pressed',
			'true',
		)
		expect(screen.getByRole('button', { name: 'No login' })).toHaveAttribute('aria-pressed', 'true')
	})

	it('renders nothing once the question has been answered', () => {
		renderOptions(QUESTION, true)
		expect(screen.queryByRole('button', { name: 'Send answer' })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'API token' })).not.toBeInTheDocument()
	})
})
