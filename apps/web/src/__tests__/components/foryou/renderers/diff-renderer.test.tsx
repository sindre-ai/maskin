import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
	DiffRendererDiff,
	DiffRendererOption,
} from '@/components/foryou/renderers/diff-renderer'
import { DiffRenderer } from '@/components/foryou/renderers/diff-renderer'
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

const defaultOptions: DiffRendererOption[] = [
	{
		value: 'approve',
		label: 'Approve',
		tone: 'primary',
		description: 'Merge the change as drafted',
	},
	{
		value: 'send_back',
		label: 'Send back',
		tone: 'secondary',
		description: 'Needs revision',
	},
]

const defaultDiff: DiffRendererDiff = {
	filePath: 'apps/web/src/components/foryou/renderers/diff-renderer.tsx',
	title: 'Add Diff artifact renderer',
	lines: [
		{
			kind: 'context',
			text: 'export function DiffRenderer(',
			oldLineNumber: 12,
			newLineNumber: 12,
		},
		{ kind: 'removed', text: '  return null', oldLineNumber: 13 },
		{ kind: 'added', text: '  return renderDiff(props)', newLineNumber: 13 },
	],
	object: { type: 'task', status: 'in_review' },
}

function renderDiffCard(
	overrides: {
		options?: readonly DiffRendererOption[]
		onCommit?: (option: DiffRendererOption) => void
		onReverse?: () => void
		diff?: DiffRendererDiff
		objectId?: string | null
	} = {},
) {
	const notification = buildNotificationResponse({
		title: 'Review diff for foryou-decision-tool',
		objectId: overrides.objectId === undefined ? 'diff-1' : overrides.objectId,
	})
	return render(
		<DiffRenderer
			workspaceId="ws-1"
			notification={notification}
			options={overrides.options ?? defaultOptions}
			diff={overrides.diff ?? defaultDiff}
			onCommit={overrides.onCommit}
			onReverse={overrides.onReverse}
		/>,
		{ wrapper: TestWrapper },
	)
}

describe('DiffRenderer', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('renders title, file path, added/removed counts, and per-line rows', () => {
		renderDiffCard()

		expect(screen.getByText('Add Diff artifact renderer')).toBeInTheDocument()
		expect(screen.getByTestId('foryou-diff-file-path')).toHaveTextContent(
			'apps/web/src/components/foryou/renderers/diff-renderer.tsx',
		)
		expect(screen.getByText('+1')).toBeInTheDocument()
		expect(screen.getByText('-1')).toBeInTheDocument()
		expect(screen.getByTestId('foryou-diff-line-added')).toHaveTextContent(
			'return renderDiff(props)',
		)
		expect(screen.getByTestId('foryou-diff-line-removed')).toHaveTextContent('return null')
		expect(screen.getByRole('link', { name: /view diff/i })).toBeInTheDocument()
	})

	it('added/removed rows use the green active and red blocked tokens', () => {
		renderDiffCard()

		expect(screen.getByTestId('foryou-diff-line-added')).toHaveClass(
			'bg-status-active-bg',
			'text-status-active-text',
		)
		expect(screen.getByTestId('foryou-diff-line-removed')).toHaveClass(
			'bg-status-blocked-bg',
			'text-status-blocked-text',
		)
	})

	it('collapses overflowing hunks into a "+N more" footer', () => {
		const longDiff: DiffRendererDiff = {
			filePath: 'src/big-file.ts',
			lines: Array.from({ length: 12 }, (_, i) => ({
				kind: 'context' as const,
				text: `line ${i + 1}`,
				oldLineNumber: i + 1,
				newLineNumber: i + 1,
			})),
		}
		renderDiffCard({ diff: longDiff })

		const overflow = screen.getByTestId('foryou-diff-overflow')
		expect(overflow).toHaveTextContent('+4 more lines')
	})

	it('renders the decision block with amber in_review tokens and a Waiting on you indicator', () => {
		renderDiffCard()

		const block = screen.getByTestId('decision-block')
		expect(block).toBeInTheDocument()
		expect(block).toHaveClass('bg-status-in_review-bg')

		const indicator = screen.getByTestId('waiting-on-you-indicator')
		expect(indicator).toHaveTextContent('Waiting on you')
		expect(indicator).toHaveClass('text-status-in_review-text')

		expect(screen.getByRole('button', { name: /Approve/i })).toHaveTextContent(
			'Merge the change as drafted',
		)
		expect(screen.getByRole('button', { name: /Send back/i })).toHaveTextContent('Needs revision')
	})

	it('choosing an option shows the green active-token receipt with a live countdown, without committing yet', () => {
		vi.useFakeTimers()
		const onCommit = vi.fn()
		renderDiffCard({ onCommit })

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
		renderDiffCard({ onCommit, onReverse })

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
		renderDiffCard({ onCommit })

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

	it('gracefully omits the header link, view-diff link, and comment input when the notification has no objectId', () => {
		renderDiffCard({ objectId: null })

		expect(screen.queryByRole('link', { name: /view diff/i })).not.toBeInTheDocument()
		expect(screen.queryByRole('link', { name: /open/i })).not.toBeInTheDocument()
		expect(screen.getByText('Add Diff artifact renderer')).toBeInTheDocument()
		expect(screen.getByTestId('decision-block')).toBeInTheDocument()
	})
})
