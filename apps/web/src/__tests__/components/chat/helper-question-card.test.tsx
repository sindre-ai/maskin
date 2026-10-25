import type { MessageQuestion } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@/hooks/use-conversation', () => ({
	useSendMessage: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}))
vi.mock('@/hooks/use-sessions', () => ({
	useSendSessionInput: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}))

import { HelperQuestionCard } from '@/components/chat/helper-question-card'

const QUESTION: MessageQuestion = {
	session_id: '11111111-1111-1111-1111-111111111111',
	reply_to_session: true,
	questions: [
		{
			question: 'Which job board should I try first?',
			header: 'Job board',
			multi_select: false,
			options: [{ label: 'Jobindex' }, { label: 'The Hub' }],
		},
	],
}

function renderCard(onViewThread?: (id: string) => void) {
	return render(
		<HelperQuestionCard
			workspaceId="ws-1"
			conversationId="conv-1"
			questionMessageId={7}
			actorId="actor-1"
			actorName="Gig Scout"
			question={QUESTION}
			answered={false}
			onViewThread={onViewThread}
		/>,
		{ wrapper: TestWrapper },
	)
}

describe('HelperQuestionCard', () => {
	it('shows who is asking and the options to pick from', () => {
		renderCard()
		expect(screen.getByText('Needs your input')).toBeInTheDocument()
		expect(screen.getByText('Gig Scout')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Jobindex' })).toBeInTheDocument()
	})

	it("opens the helper's thread from View thread", async () => {
		const onViewThread = vi.fn()
		renderCard(onViewThread)
		await userEvent.setup().click(screen.getByRole('button', { name: 'View thread' }))
		expect(onViewThread).toHaveBeenCalledWith(QUESTION.session_id)
	})

	it('has no View thread button when the chat has no Threads pane', () => {
		renderCard()
		expect(screen.queryByRole('button', { name: 'View thread' })).not.toBeInTheDocument()
	})
})
