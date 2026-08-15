import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VisualRendererOption } from '@/components/foryou/renderers/visual-renderer'
import { VisualRenderer } from '@/components/foryou/renderers/visual-renderer'
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

const defaultOptions: VisualRendererOption[] = [
	{
		value: 'ship',
		label: 'Ship it',
		tone: 'primary',
		description: 'Publish this asset',
	},
	{
		value: 'revise',
		label: 'Revise',
		tone: 'secondary',
		description: 'Send back for edits',
	},
]

function renderVisualCard(
	overrides: {
		options?: readonly VisualRendererOption[]
		onCommit?: (option: VisualRendererOption) => void
		onReverse?: () => void
		caption?: string | null
		objectId?: string | null
		visual?: Parameters<typeof VisualRenderer>[0]['visual']
		object?: Parameters<typeof VisualRenderer>[0]['object']
	} = {},
) {
	const notification = buildNotificationResponse({
		title: 'Hero image ready to review',
		content: overrides.caption === undefined ? 'A brief caption for the visual' : overrides.caption,
		objectId: overrides.objectId === undefined ? 'visual-1' : overrides.objectId,
	})
	return render(
		<VisualRenderer
			workspaceId="ws-1"
			notification={notification}
			options={overrides.options ?? defaultOptions}
			visual={
				overrides.visual === undefined
					? { src: 'https://cdn.example/hero.png', alt: 'Hero banner' }
					: overrides.visual
			}
			object={overrides.object ?? { type: 'visual', status: 'in_review' }}
			onCommit={overrides.onCommit}
			onReverse={overrides.onReverse}
		/>,
		{ wrapper: TestWrapper },
	)
}

describe('VisualRenderer', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('renders title, image preview with alt text, and caption', () => {
		renderVisualCard()

		expect(screen.getByText('Hero image ready to review')).toBeInTheDocument()
		const preview = screen.getByTestId('foryou-visual-preview') as HTMLImageElement
		expect(preview).toBeInTheDocument()
		expect(preview.src).toBe('https://cdn.example/hero.png')
		expect(preview.alt).toBe('Hero banner')
		expect(screen.getByText(/A brief caption for the visual/)).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /open/i })).toBeInTheDocument()
	})

	it('falls back to a placeholder with alt-labelled role when no src is provided', () => {
		renderVisualCard({ visual: { alt: 'Missing hero image' } })

		expect(screen.queryByTestId('foryou-visual-preview')).not.toBeInTheDocument()
		const placeholder = screen.getByTestId('foryou-visual-placeholder')
		expect(placeholder).toBeInTheDocument()
		expect(placeholder).toHaveAttribute('role', 'img')
		expect(placeholder).toHaveAttribute('aria-label', 'Missing hero image')
	})

	it('renders the decision block with amber in_review tokens and a Waiting on you indicator', () => {
		renderVisualCard()

		const block = screen.getByTestId('decision-block')
		expect(block).toBeInTheDocument()
		expect(block).toHaveClass('bg-status-in_review-bg')

		const indicator = screen.getByTestId('waiting-on-you-indicator')
		expect(indicator).toHaveTextContent('Waiting on you')
		expect(indicator).toHaveClass('text-status-in_review-text')

		expect(screen.getByRole('button', { name: /Ship it/i })).toHaveTextContent('Publish this asset')
		expect(screen.getByRole('button', { name: /Revise/i })).toHaveTextContent('Send back for edits')
	})

	it('choosing an option shows the green active-token receipt with a live countdown, without committing yet', () => {
		vi.useFakeTimers()
		const onCommit = vi.fn()
		renderVisualCard({ onCommit })

		fireEvent.click(screen.getByRole('button', { name: /Ship it/i }))

		expect(screen.queryByTestId('decision-block')).not.toBeInTheDocument()
		const receipt = screen.getByTestId('decision-receipt')
		expect(receipt).toBeInTheDocument()
		expect(receipt).toHaveClass('bg-status-active-bg')
		expect(receipt).toHaveTextContent('You chose Ship it')
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
		renderVisualCard({ onCommit, onReverse })

		fireEvent.click(screen.getByRole('button', { name: /Ship it/i }))
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
		renderVisualCard({ onCommit })

		fireEvent.click(screen.getByRole('button', { name: /Revise/i }))

		expect(screen.getByTestId('decision-receipt')).not.toHaveTextContent(
			'Your choice was posted to the thread',
		)

		act(() => {
			vi.advanceTimersByTime(6000)
		})

		expect(onCommit).toHaveBeenCalledWith(
			expect.objectContaining({ value: 'revise', label: 'Revise' }),
		)
		const receipt = screen.getByTestId('decision-receipt')
		expect(receipt).toHaveTextContent('You chose Revise')
		expect(receipt).toHaveTextContent('Your choice was posted to the thread')
	})

	it('gracefully omits the header link and comment input when the notification has no objectId', () => {
		renderVisualCard({ objectId: null })

		expect(screen.queryByRole('link', { name: /open/i })).not.toBeInTheDocument()
		expect(screen.getByText('Hero image ready to review')).toBeInTheDocument()
		expect(screen.getByTestId('decision-block')).toBeInTheDocument()
	})

	it('falls back to the placeholder for non-image media types', () => {
		renderVisualCard({
			visual: {
				src: 'https://cdn.example/clip.mp4',
				alt: 'Product demo clip',
				mediaType: 'video',
			},
		})

		expect(screen.queryByTestId('foryou-visual-preview')).not.toBeInTheDocument()
		const placeholder = screen.getByTestId('foryou-visual-placeholder')
		expect(placeholder).toHaveAttribute('aria-label', 'Product demo clip')
	})
})
