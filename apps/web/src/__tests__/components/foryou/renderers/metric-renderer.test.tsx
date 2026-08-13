import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MetricRendererOption } from '@/components/foryou/renderers/metric-renderer'
import { MetricRenderer } from '@/components/foryou/renderers/metric-renderer'
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

const defaultOptions: MetricRendererOption[] = [
	{
		value: 'accept_threshold',
		label: 'Accept new threshold',
		tone: 'primary',
		description: 'Bank the improvement as the new baseline',
	},
	{
		value: 'investigate',
		label: 'Investigate',
		tone: 'secondary',
		description: 'Open the loop before locking in',
	},
]

function renderMetricCard(
	overrides: {
		options?: readonly MetricRendererOption[]
		onCommit?: (option: MetricRendererOption) => void
		onReverse?: () => void
		summary?: string | null
		objectId?: string | null
		metric?: Parameters<typeof MetricRenderer>[0]['metric']
	} = {},
) {
	const notification = buildNotificationResponse({
		title: 'Weekly signups crossed the target',
		content:
			overrides.summary === undefined ? 'First time above 1,000 in six weeks.' : overrides.summary,
		objectId: overrides.objectId === undefined ? 'metric-1' : overrides.objectId,
	})
	return render(
		<MetricRenderer
			workspaceId="ws-1"
			notification={notification}
			options={overrides.options ?? defaultOptions}
			metric={
				overrides.metric ?? {
					type: 'metric',
					status: 'in_review',
					value: '1,247',
					label: 'Weekly signups',
					unit: 'users',
					trend: 'up',
					delta: '+18% vs last week',
				}
			}
			onCommit={overrides.onCommit}
			onReverse={overrides.onReverse}
		/>,
		{ wrapper: TestWrapper },
	)
}

describe('MetricRenderer', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('renders the metric value, label, and trend direction with the referenced object link', () => {
		renderMetricCard()

		expect(screen.getByText('Weekly signups crossed the target')).toBeInTheDocument()
		expect(screen.getByTestId('foryou-metric-value')).toHaveTextContent('1,247')
		expect(screen.getByText('users')).toBeInTheDocument()
		expect(screen.getByText('Weekly signups')).toBeInTheDocument()
		const trend = screen.getByTestId('foryou-metric-trend')
		expect(trend).toHaveAttribute('data-trend', 'up')
		expect(trend).toHaveClass('text-success')
		expect(trend).toHaveTextContent('+18% vs last week')
		expect(screen.getByRole('link', { name: /open/i })).toBeInTheDocument()
	})

	it('maps trend direction to the semantic colour token', () => {
		renderMetricCard({
			metric: {
				type: 'metric',
				status: 'in_review',
				value: '3.2%',
				label: 'Churn',
				trend: 'down',
				delta: '−0.4pp',
			},
		})
		expect(screen.getByTestId('foryou-metric-trend')).toHaveClass('text-error')
	})

	it('renders the decision block with amber in_review tokens and a Waiting on you indicator', () => {
		renderMetricCard()

		const block = screen.getByTestId('decision-block')
		expect(block).toBeInTheDocument()
		expect(block).toHaveClass('bg-status-in_review-bg')

		const indicator = screen.getByTestId('waiting-on-you-indicator')
		expect(indicator).toHaveTextContent('Waiting on you')
		expect(indicator).toHaveClass('text-status-in_review-text')

		expect(screen.getByRole('button', { name: /Accept new threshold/i })).toHaveTextContent(
			'Bank the improvement as the new baseline',
		)
		expect(screen.getByRole('button', { name: /Investigate/i })).toHaveTextContent(
			'Open the loop before locking in',
		)
	})

	it('choosing an option shows the green active-token receipt with a live countdown, without committing yet', () => {
		vi.useFakeTimers()
		const onCommit = vi.fn()
		renderMetricCard({ onCommit })

		fireEvent.click(screen.getByRole('button', { name: /Accept new threshold/i }))

		expect(screen.queryByTestId('decision-block')).not.toBeInTheDocument()
		const receipt = screen.getByTestId('decision-receipt')
		expect(receipt).toBeInTheDocument()
		expect(receipt).toHaveClass('bg-status-active-bg')
		expect(receipt).toHaveTextContent('You chose Accept new threshold')
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
		renderMetricCard({ onCommit, onReverse })

		fireEvent.click(screen.getByRole('button', { name: /Accept new threshold/i }))
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
		renderMetricCard({ onCommit })

		fireEvent.click(screen.getByRole('button', { name: /Investigate/i }))

		expect(screen.getByTestId('decision-receipt')).not.toHaveTextContent(
			'Your choice was posted to the thread',
		)

		act(() => {
			vi.advanceTimersByTime(6000)
		})

		expect(onCommit).toHaveBeenCalledWith(
			expect.objectContaining({ value: 'investigate', label: 'Investigate' }),
		)
		const receipt = screen.getByTestId('decision-receipt')
		expect(receipt).toHaveTextContent('You chose Investigate')
		expect(receipt).toHaveTextContent('Your choice was posted to the thread')
	})

	it('gracefully omits the header link and comment input when the notification has no objectId', () => {
		renderMetricCard({ objectId: null })

		expect(screen.queryByRole('link', { name: /open/i })).not.toBeInTheDocument()
		expect(screen.getByText('Weekly signups crossed the target')).toBeInTheDocument()
		expect(screen.getByTestId('decision-block')).toBeInTheDocument()
	})
})
