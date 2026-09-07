import { CommentDecisionBlock } from '@/components/activity/comment-decision-block'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildEventResponse } from '../../factories'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/analytics', () => ({ trackForyouCardAction: vi.fn() }))

const createMutate = vi.fn()
vi.mock('@/hooks/use-events', () => ({
	useCreateComment: () => ({ mutate: createMutate, isPending: false }),
}))

const decision = {
	title: 'Ship the retry backoff?',
	summary: '3 sessions stalled last night. The patch is written and tested.',
	ask: 'This changes what every running session does, so I will not ship it alone.',
	options: [
		{ label: 'Hold', consequences: ['Nothing ships', 'Stalls keep happening'] },
		{ label: 'Ship', recommended: true, consequences: ['Goes out tonight', 'No rollback'] },
	],
}

function decisionComment() {
	return buildEventResponse({ id: 42, action: 'commented', data: { content: 'Pick', decision } })
}

function renderBlock(props: Partial<Parameters<typeof CommentDecisionBlock>[0]> = {}) {
	return render(
		<CommentDecisionBlock
			event={decisionComment()}
			workspaceId="ws-1"
			objectId="obj-1"
			{...props}
		/>,
		{ wrapper: TestWrapper },
	)
}

describe('CommentDecisionBlock', () => {
	beforeEach(() => {
		createMutate.mockReset()
	})

	it('renders every option with its consequences, so the ask is answerable here', () => {
		renderBlock()
		expect(screen.getByRole('button', { name: /Ship/ })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Hold/ })).toBeInTheDocument()
		expect(screen.getByText('Goes out tonight')).toBeInTheDocument()
		expect(screen.getByText('Stalls keep happening')).toBeInTheDocument()
	})

	it('shows the ask above the options', () => {
		renderBlock()
		expect(screen.getByText(decision.ask)).toBeInTheDocument()
	})

	// The answer has to land under the question. A loose comment on the object
	// makes the agent guess which of its asks was just answered.
	it('posts the taken option threaded under the comment that asked', async () => {
		const user = userEvent.setup()
		renderBlock()

		await user.click(screen.getByRole('button', { name: /Ship/ }))

		await waitFor(() => expect(createMutate).toHaveBeenCalledTimes(1))
		expect(createMutate.mock.calls[0][0]).toMatchObject({
			entity_id: 'obj-1',
			content: 'Ship',
			parent_event_id: 42,
		})
	})

	it('renders nothing for a comment with no decision', () => {
		const { container } = renderBlock({
			event: buildEventResponse({ action: 'commented', data: { content: 'Plain comment' } }),
		})
		expect(container).toBeEmptyDOMElement()
	})

	// A malformed block is not a decision. The timeline used to accept anything
	// object-shaped here while the feed parsed it properly.
	it('renders nothing for a malformed decision block', () => {
		const { container } = renderBlock({
			event: buildEventResponse({ action: 'commented', data: { decision: {} } }),
		})
		expect(container).toBeEmptyDOMElement()
	})

	it('shows the answer instead of the buttons once an option has been taken', () => {
		renderBlock({
			replies: [buildEventResponse({ id: 43, action: 'commented', data: { content: 'Ship' } })],
		})
		expect(screen.getByText('Answered:')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /Hold/ })).not.toBeInTheDocument()
	})

	it('ignores replies that are not one of the options', () => {
		renderBlock({
			replies: [
				buildEventResponse({ id: 43, action: 'commented', data: { content: 'what do you mean?' } }),
			],
		})
		expect(screen.getByRole('button', { name: /Ship/ })).toBeInTheDocument()
	})
})
