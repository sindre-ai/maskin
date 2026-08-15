import { fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MailRendererOption } from '@/components/foryou/renderers/mail-renderer'
import { MailRenderer } from '@/components/foryou/renderers/mail-renderer'
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

const defaultOptions: MailRendererOption[] = [
	{
		value: 'send_reply',
		label: 'Send reply',
		tone: 'primary',
		description: 'Reply with the drafted message',
	},
	{
		value: 'archive',
		label: 'Archive',
		tone: 'secondary',
		description: 'No response needed',
	},
]

function renderMailCard(
	overrides: {
		options?: readonly MailRendererOption[]
		onCommit?: (option: MailRendererOption) => void
		onReverse?: () => void
		preview?: string | null
		sender?: string
		objectId?: string | null
		subject?: string
	} = {},
) {
	const notification = buildNotificationResponse({
		title: 'Reply to: Q3 partnership terms',
		content:
			overrides.preview === undefined ? 'Fallback preview from notification' : overrides.preview,
		objectId: overrides.objectId === undefined ? 'mail-1' : overrides.objectId,
	})
	return render(
		<MailRenderer
			workspaceId="ws-1"
			notification={notification}
			options={overrides.options ?? defaultOptions}
			mail={{
				type: 'mail',
				status: 'in_review',
				subject: overrides.subject,
				sender: overrides.sender ?? 'From: partner@acme.co',
				preview: overrides.preview === undefined ? 'Two open items on the terms sheet…' : undefined,
			}}
			onCommit={overrides.onCommit}
			onReverse={overrides.onReverse}
		/>,
		{ wrapper: TestWrapper },
	)
}

describe('MailRenderer', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('renders subject, sender summary, and contextual link to the referenced mail', () => {
		renderMailCard()

		expect(screen.getByText('Reply to: Q3 partnership terms')).toBeInTheDocument()
		expect(screen.getByTestId('mail-sender')).toHaveTextContent('From: partner@acme.co')
		expect(screen.getByText(/Two open items on the terms sheet/)).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /view mail/i })).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /open/i })).toBeInTheDocument()
	})

	it('renders the decision block with amber in_review tokens and a Waiting on you indicator', () => {
		renderMailCard()

		const block = screen.getByTestId('decision-block')
		expect(block).toBeInTheDocument()
		expect(block).toHaveClass('bg-status-in_review-bg')

		const indicator = screen.getByTestId('waiting-on-you-indicator')
		expect(indicator).toHaveTextContent('Waiting on you')
		expect(indicator).toHaveClass('text-status-in_review-text')

		expect(screen.getByRole('button', { name: /Send reply/i })).toHaveTextContent(
			'Reply with the drafted message',
		)
		expect(screen.getByRole('button', { name: /Archive/i })).toHaveTextContent('No response needed')
	})

	it('choosing an option shows the green active-token receipt with a live countdown, without committing yet', () => {
		vi.useFakeTimers()
		const onCommit = vi.fn()
		renderMailCard({ onCommit })

		fireEvent.click(screen.getByRole('button', { name: /Send reply/i }))

		expect(screen.queryByTestId('decision-block')).not.toBeInTheDocument()
		const receipt = screen.getByTestId('decision-receipt')
		expect(receipt).toBeInTheDocument()
		expect(receipt).toHaveClass('bg-status-active-bg')
		expect(receipt).toHaveTextContent('You chose Send reply')
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
		renderMailCard({ onCommit, onReverse })

		fireEvent.click(screen.getByRole('button', { name: /Send reply/i }))
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

	it('auto-commits once the reverse window elapses and shows the sent confirmation on the receipt', () => {
		vi.useFakeTimers()
		const onCommit = vi.fn()
		renderMailCard({ onCommit })

		fireEvent.click(screen.getByRole('button', { name: /Archive/i }))

		expect(screen.getByTestId('decision-receipt')).not.toHaveTextContent('Your reply was sent')

		act(() => {
			vi.advanceTimersByTime(6000)
		})

		expect(onCommit).toHaveBeenCalledWith(
			expect.objectContaining({ value: 'archive', label: 'Archive' }),
		)
		const receipt = screen.getByTestId('decision-receipt')
		expect(receipt).toHaveTextContent('You chose Archive')
		expect(receipt).toHaveTextContent('Your reply was sent')
	})

	it('gracefully omits the header link and comment input when the notification has no objectId', () => {
		renderMailCard({ objectId: null })

		expect(screen.queryByRole('link', { name: /view mail/i })).not.toBeInTheDocument()
		expect(screen.queryByRole('link', { name: /open/i })).not.toBeInTheDocument()
		expect(screen.getByText('Reply to: Q3 partnership terms')).toBeInTheDocument()
		expect(screen.getByTestId('decision-block')).toBeInTheDocument()
	})
})
