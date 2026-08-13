import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PostRendererOption } from '@/components/foryou/renderers/post-renderer'
import { PostRenderer } from '@/components/foryou/renderers/post-renderer'
import { buildNotificationResponse } from '../../../factories'
import { TestWrapper } from '../../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../../mocks/router')
	return mockTanStackRouter()
})

const mockCreateCommentMutate = vi.fn()

vi.mock('@/hooks/use-events', () => ({
	useCreateComment: () => ({ mutate: mockCreateCommentMutate, isPending: false }),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'viewer', name: 'Viewer', type: 'human', email: null }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActor: () => ({ data: { id: 'other', name: 'Other', type: 'human' } }),
	useActors: () => ({
		data: [
			{ id: 'viewer', name: 'Viewer', type: 'human', isSystem: false },
			{ id: 'other', name: 'Other', type: 'human', isSystem: false },
		],
	}),
}))

const defaultOptions: PostRendererOption[] = [
	{
		value: 'approve',
		label: 'Approve',
		tone: 'primary',
		description: 'Publish the post as drafted',
	},
	{
		value: 'send_back',
		label: 'Send back',
		tone: 'secondary',
		description: 'Needs revision',
	},
]

function renderPostCard(
	overrides: {
		options?: readonly PostRendererOption[]
		onCommit?: (option: PostRendererOption) => void
		onReverse?: () => void
		summary?: string | null
		objectId?: string | null
		postTitle?: string
	} = {},
) {
	const notification = buildNotificationResponse({
		title: 'Post ready for review',
		content: overrides.summary === undefined ? 'A brief summary of the post' : overrides.summary,
		objectId: overrides.objectId === undefined ? 'post-1' : overrides.objectId,
	})
	return render(
		<PostRenderer
			workspaceId="ws-1"
			notification={notification}
			options={overrides.options ?? defaultOptions}
			post={{ type: 'post', status: 'in_review', title: overrides.postTitle }}
			onCommit={overrides.onCommit}
			onReverse={overrides.onReverse}
		/>,
		{ wrapper: TestWrapper },
	)
}

describe('PostRenderer', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('renders title, summary, and contextual link to the referenced post', () => {
		renderPostCard()

		expect(screen.getByText('Post ready for review')).toBeInTheDocument()
		expect(screen.getByText(/A brief summary of the post/)).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /view post/i })).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /open/i })).toBeInTheDocument()
	})

	it('renders the decision block with amber in_review tokens and a Waiting on you indicator', () => {
		renderPostCard()

		const block = screen.getByTestId('decision-block')
		expect(block).toBeInTheDocument()
		expect(block).toHaveClass('bg-status-in_review-bg')

		const indicator = screen.getByTestId('waiting-on-you-indicator')
		expect(indicator).toHaveTextContent('Waiting on you')
		expect(indicator).toHaveClass('text-status-in_review-text')

		expect(screen.getByRole('button', { name: /Approve/i })).toHaveTextContent(
			'Publish the post as drafted',
		)
		expect(screen.getByRole('button', { name: /Send back/i })).toHaveTextContent('Needs revision')
	})

	it('choosing an option shows the green active-token receipt with a live countdown, without committing yet', () => {
		vi.useFakeTimers()
		const onCommit = vi.fn()
		renderPostCard({ onCommit })

		fireEvent.click(screen.getByRole('button', { name: /Approve/i }))

		expect(screen.queryByTestId('decision-block')).not.toBeInTheDocument()
		const receipt = screen.getByTestId('decision-receipt')
		expect(receipt).toBeInTheDocument()
		expect(receipt).toHaveClass('bg-status-active-bg')
		expect(receipt).toHaveTextContent('You chose Approve')
		expect(receipt).toHaveTextContent('Reversible for 6s')
		expect(onCommit).not.toHaveBeenCalled()

		act(() => {
			vi.advanceTimersByTime(3000)
		})
		expect(screen.getByTestId('decision-receipt')).toHaveTextContent('Reversible for 3s')
	})

	it('Reverse this returns to the idle decision block, cancels the timer, and never commits', () => {
		vi.useFakeTimers()
		const onCommit = vi.fn()
		const onReverse = vi.fn()
		renderPostCard({ onCommit, onReverse })

		fireEvent.click(screen.getByRole('button', { name: /Approve/i }))
		act(() => {
			vi.advanceTimersByTime(3000)
		})
		fireEvent.click(screen.getByRole('button', { name: 'Reverse this' }))

		expect(onReverse).toHaveBeenCalledTimes(1)
		expect(screen.getByTestId('decision-block')).toBeInTheDocument()
		expect(screen.queryByTestId('decision-receipt')).not.toBeInTheDocument()

		act(() => {
			vi.advanceTimersByTime(10000)
		})
		expect(onCommit).not.toHaveBeenCalled()
	})

	it('auto-commits once the reverse window elapses and shows the confirmed row on the receipt', () => {
		vi.useFakeTimers()
		const onCommit = vi.fn()
		renderPostCard({ onCommit })

		fireEvent.click(screen.getByRole('button', { name: /Send back/i }))

		expect(screen.getByTestId('decision-receipt')).not.toHaveTextContent(
			'Your choice was posted to the thread',
		)

		act(() => {
			vi.advanceTimersByTime(6000)
		})

		expect(onCommit).toHaveBeenCalledWith(
			expect.objectContaining({ value: 'send_back', label: 'Send back' }),
		)
		const receipt = screen.getByTestId('decision-receipt')
		expect(receipt).toHaveTextContent('You chose Send back')
		expect(receipt).toHaveTextContent('Your choice was posted to the thread')
	})

	it('gracefully omits the header link and comment input when the notification has no objectId', () => {
		renderPostCard({ objectId: null })

		expect(screen.queryByRole('link', { name: /view post/i })).not.toBeInTheDocument()
		expect(screen.queryByRole('link', { name: /open/i })).not.toBeInTheDocument()
		expect(screen.getByText('Post ready for review')).toBeInTheDocument()
		expect(screen.getByTestId('decision-block')).toBeInTheDocument()
	})
})
