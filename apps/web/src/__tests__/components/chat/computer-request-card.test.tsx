import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

const sendMutate = vi.fn()
let cardAnswer: 'declined' | 'done' | null = null
vi.mock('@/hooks/use-conversation', () => ({
	useSendMessage: () => ({ mutate: sendMutate }),
	useCardAnswer: () => cardAnswer,
}))

// The live view needs noVNC; the card only decides WHEN and for WHOM to show it.
const mounted = vi.fn()
vi.mock('@/components/desktop/expandable-desktop', () => ({
	ExpandableDesktop: (props: { agentId: string; workspaceId: string; agentName: string }) => {
		mounted(props)
		return <div data-testid="live-computer">{props.agentId}</div>
	},
}))

import { ComputerRequestCard } from '@/components/chat/computer-request-card'

const AGENT = '44444444-4444-4444-8444-444444444444'
const request = {
	session_id: '11111111-1111-4111-8111-111111111111',
	task: 'Approve the 2FA prompt on e-conomic.',
}

const renderCard = () =>
	render(
		<TestWrapper>
			<ComputerRequestCard
				workspaceId="ws-1"
				conversationId="conv-1"
				messageId={7}
				agentId={AGENT}
				agentName="Ledger"
				request={request}
			/>
		</TestWrapper>,
	)

describe('ComputerRequestCard', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		cardAnswer = null
	})

	it('says what to do, and does not connect to the computer by itself', () => {
		renderCard()

		expect(screen.getByText('Ledger needs your help on its computer')).toBeInTheDocument()
		expect(screen.getByText('Approve the 2FA prompt on e-conomic.')).toBeInTheDocument()
		// A chat can hold many of these: scrolling past one must not wake a computer.
		expect(mounted).not.toHaveBeenCalled()
		expect(screen.queryByTestId('live-computer')).not.toBeInTheDocument()
	})

	it("opens the asking agent's computer when the person asks, and nobody else's", async () => {
		const user = userEvent.setup()
		renderCard()

		await user.click(screen.getByRole('button', { name: 'Open computer' }))

		expect(await screen.findByTestId('live-computer')).toHaveTextContent(AGENT)
		expect(mounted).toHaveBeenCalledWith(
			expect.objectContaining({ agentId: AGENT, workspaceId: 'ws-1', agentName: 'Ledger' }),
		)
	})

	it('hands control back with Done: posts a message and closes the live view', async () => {
		const user = userEvent.setup()
		renderCard()
		await user.click(screen.getByRole('button', { name: 'Open computer' }))

		await user.click(await screen.findByRole('button', { name: 'Done' }))

		expect(sendMutate).toHaveBeenCalledTimes(1)
		expect(sendMutate.mock.calls[0]?.[0].content).toMatch(/finished on the computer/i)
		expect(screen.getByText('Handed back to Ledger.')).toBeInTheDocument()
		expect(screen.queryByTestId('live-computer')).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument()
	})

	it('has no Done before the computer is open: there is nothing to have finished', () => {
		renderCard()

		expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument()
	})

	it('offers no way to decline: the person skips it by writing a message', () => {
		renderCard()

		expect(screen.getByRole('button', { name: 'Open computer' })).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: "Can't do this" })).not.toBeInTheDocument()
		expect(sendMutate).not.toHaveBeenCalled()
	})

	it('posts plain text, never anything that carries the task or the screen', async () => {
		const user = userEvent.setup()
		renderCard()
		await user.click(screen.getByRole('button', { name: 'Open computer' }))

		await user.click(await screen.findByRole('button', { name: 'Done' }))

		const sent = JSON.stringify(sendMutate.mock.calls[0]?.[0])
		expect(sent).not.toContain('e-conomic')
	})

	it('reads as handed back when the chat already holds the person’s Done', () => {
		cardAnswer = 'done'
		renderCard()

		expect(screen.getByText('Handed back to Ledger.')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Open computer' })).not.toBeInTheDocument()
	})
})
