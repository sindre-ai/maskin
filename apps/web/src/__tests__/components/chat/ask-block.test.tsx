import { type Ask, AskBlock } from '@/components/chat/ask-block'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/api', () => ({
	api: {
		notifications: { respond: vi.fn() },
	},
}))

import { api } from '@/lib/api'

beforeEach(() => {
	vi.clearAllMocks()
})

function buildAsk(overrides: Partial<Ask> = {}): Ask {
	return {
		id: 'ask-1',
		title: null,
		content: null,
		question: 'Which direction?',
		options: [
			{ label: 'Proceed', value: 'proceed' },
			{ label: 'Hold', value: 'hold', description: 'Pause for now' },
		],
		suggestion: null,
		status: 'pending',
		response: null,
		...overrides,
	}
}

describe('AskBlock', () => {
	it('renders the question as tappable option rows with descriptions', () => {
		render(
			<TestWrapper>
				<AskBlock workspaceId="ws-1" ask={buildAsk()} />
			</TestWrapper>,
		)

		expect(screen.getByText('Ask')).toBeInTheDocument()
		expect(screen.getByText('Which direction?')).toBeInTheDocument()
		const proceed = screen.getByRole('button', { name: /Proceed/i })
		const hold = screen.getByRole('button', { name: /Hold/i })
		expect(proceed).toBeInTheDocument()
		expect(hold).toBeInTheDocument()
		expect(screen.getByText('Pause for now')).toBeInTheDocument()
		expect(screen.queryByText('REC')).not.toBeInTheDocument()
	})

	it('posts the tapped option value back via the respond mutation', async () => {
		render(
			<TestWrapper>
				<AskBlock workspaceId="ws-1" ask={buildAsk()} />
			</TestWrapper>,
		)

		fireEvent.click(screen.getByRole('button', { name: /Proceed/i }))

		await waitFor(() =>
			expect(api.notifications.respond).toHaveBeenCalledWith('ask-1', 'proceed', 'ws-1'),
		)
	})

	it('marks the producer-recommended option with a REC chip', () => {
		render(
			<TestWrapper>
				<AskBlock workspaceId="ws-1" ask={buildAsk({ suggestion: 'proceed' })} />
			</TestWrapper>,
		)

		expect(screen.getByText('REC')).toBeInTheDocument()
		// Recommendation driven by metadata.suggestion, not by option order.
		expect(api.notifications.respond).not.toHaveBeenCalled()
	})

	it('locks the block and shows the picked option once resolved', () => {
		render(
			<TestWrapper>
				<AskBlock workspaceId="ws-1" ask={buildAsk({ status: 'resolved', response: 'hold' })} />
			</TestWrapper>,
		)

		expect(screen.getByRole('button', { name: /Hold/i })).toBeDisabled()
		expect(screen.getByRole('button', { name: /Hold/i })).toHaveAttribute('aria-pressed', 'true')
		// The chosen option carries the picked indicator.
		expect(screen.getByLabelText('Picked')).toBeInTheDocument()
	})

	it('renders the question even when the payload has no coercible options', () => {
		// The bridge owns option coercion; a block with an empty option list
		// should still render its question without crashing.
		render(
			<TestWrapper>
				<AskBlock workspaceId="ws-1" ask={buildAsk({ options: [] })} />
			</TestWrapper>,
		)
		expect(screen.getByText('Which direction?')).toBeInTheDocument()
	})
})
