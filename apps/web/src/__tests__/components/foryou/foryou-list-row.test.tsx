import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import type { UnreadItem } from '@/lib/api'
import { buildObjectResponse } from '../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

import { ForYouListRow } from '@/components/foryou/foryou-list-row'

function buildItem(overrides: Partial<UnreadItem> = {}): UnreadItem {
	return {
		entity_type: 'object',
		entity_id: 'obj-1',
		unread_count: 3,
		mentioning_unread_count: 0,
		max_unread_attention: null,
		latest_event_id: 20,
		latest_activity_at: '2026-01-01T00:00:00Z',
		object: buildObjectResponse({
			id: 'obj-1',
			title: 'Renewal terms need a read',
			type: 'bet',
			status: 'active',
		}),
		...overrides,
	}
}

describe('ForYouListRow', () => {
	it('selects the item instead of navigating to object detail', async () => {
		const user = userEvent.setup()
		const onSelect = vi.fn()
		const item = buildItem()
		render(<ForYouListRow item={item} onSelect={onSelect} />)

		const row = screen.getByRole('button', { name: 'Renewal terms need a read' })
		await user.click(row)

		expect(onSelect).toHaveBeenCalledWith(item)
		// The row is a chooser for the card queue — the card's own "Open →" is
		// what routes to object detail.
		expect(screen.queryByRole('link')).not.toBeInTheDocument()
	})

	it('renders the title, sub line and the status dot-word', () => {
		render(<ForYouListRow item={buildItem()} onSelect={vi.fn()} subtitle="Bet · 3 unread" />)

		expect(screen.getByText('Renewal terms need a read')).toBeInTheDocument()
		expect(screen.getByText('Bet · 3 unread')).toBeInTheDocument()
		expect(screen.getByLabelText('Status active')).toBeInTheDocument()
	})

	it('marks the row the queue is parked on as current', () => {
		render(<ForYouListRow item={buildItem()} onSelect={vi.fn()} current />)
		expect(screen.getByRole('button', { name: 'Renewal terms need a read' })).toHaveAttribute(
			'aria-current',
			'true',
		)
	})
})
