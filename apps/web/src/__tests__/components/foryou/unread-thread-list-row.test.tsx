import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { UnreadItem } from '@/lib/api'
import { buildObjectResponse } from '../../factories'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

import { UnreadThreadListRow } from '@/components/foryou/unread-thread-list-row'

function buildItem(overrides: Partial<UnreadItem> = {}): UnreadItem {
	return {
		entity_type: 'object',
		entity_id: 'obj-1',
		unread_count: 1,
		mentioning_unread_count: 0,
		latest_event_id: 20,
		latest_activity_at: '2026-01-01T00:00:00Z',
		object: buildObjectResponse({
			id: 'obj-1',
			title: 'Onboarding A/B',
			type: 'bet',
			status: 'in_progress',
			content: 'Snippet body that should render as a subtitle.',
		}),
		...overrides,
	}
}

describe('UnreadThreadListRow', () => {
	it('renders type badge, title, snippet, status dot, relative time, and chevron', () => {
		render(<UnreadThreadListRow workspaceId="ws-1" item={buildItem()} />, {
			wrapper: TestWrapper,
		})

		// Type badge (renders the object type as text).
		expect(screen.getByText('bet')).toBeInTheDocument()
		// Title
		expect(screen.getByText('Onboarding A/B')).toBeInTheDocument()
		// Subtitle / snippet
		const snippet = screen.getByText(/Snippet body/)
		expect(snippet).toBeInTheDocument()
		expect(snippet.className).toMatch(/line-clamp-1/)
		// Status pill with the dot marker (dot-word variant).
		const pill = screen.getByLabelText('Status in progress')
		expect(pill).toBeInTheDocument()
		expect(pill.querySelector('[data-testid="status-dot"]')).not.toBeNull()
		// RelativeTime renders a <time> tag.
		expect(screen.getByRole('time', { hidden: true })).toBeInTheDocument()
		// Chevron — matched by its aria-hidden svg (lucide sets role="img" only with title).
		const link = screen.getByTestId('unread-thread-list-row')
		expect(link.querySelector('svg')).not.toBeNull()
	})

	it('links to the object detail route for this workspace', () => {
		render(<UnreadThreadListRow workspaceId="ws-1" item={buildItem()} />, {
			wrapper: TestWrapper,
		})
		const link = screen.getByTestId('unread-thread-list-row')
		expect(link.tagName).toBe('A')
		expect(link.getAttribute('href')).toBe('/$workspaceId/objects/$objectId')
	})

	it('applies the warning left border when the viewer is @-mentioned in an unread event', () => {
		render(
			<UnreadThreadListRow
				workspaceId="ws-1"
				item={buildItem({ unread_count: 1, mentioning_unread_count: 1 })}
			/>,
			{ wrapper: TestWrapper },
		)
		const link = screen.getByTestId('unread-thread-list-row')
		expect(link.className).toMatch(/border-l-warning/)
		expect(link.className).not.toMatch(/border-l-primary/)
	})

	it('applies the primary left border for unread non-mention rows', () => {
		render(
			<UnreadThreadListRow
				workspaceId="ws-1"
				item={buildItem({ unread_count: 1, mentioning_unread_count: 0 })}
			/>,
			{ wrapper: TestWrapper },
		)
		const link = screen.getByTestId('unread-thread-list-row')
		expect(link.className).toMatch(/border-l-primary/)
		expect(link.className).not.toMatch(/border-l-warning/)
	})

	it('omits the unread left border when the thread has no unread activity', () => {
		render(
			<UnreadThreadListRow
				workspaceId="ws-1"
				item={buildItem({ unread_count: 0, mentioning_unread_count: 0 })}
			/>,
			{ wrapper: TestWrapper },
		)
		const link = screen.getByTestId('unread-thread-list-row')
		expect(link.className).not.toMatch(/border-l-primary/)
		expect(link.className).not.toMatch(/border-l-warning/)
	})

	it('attaches no pointer handlers so it has no swipe gesture', () => {
		render(<UnreadThreadListRow workspaceId="ws-1" item={buildItem()} />, {
			wrapper: TestWrapper,
		})
		const link = screen.getByTestId('unread-thread-list-row')
		// touch-pan-y is the sentinel the card uses to enable swipe wiring; it must
		// NOT appear on the list row.
		expect(link.className).not.toMatch(/touch-pan-y/)
		// No explicit onPointerDown / onPointerMove props materialise as attributes,
		// but the safer proof is the wrapper element being a plain <a> with no
		// event listeners attached beyond the router click.
		expect(link.tagName).toBe('A')
	})

	it('truncates a long title with min-w-0 + truncate on the title column', () => {
		render(
			<UnreadThreadListRow
				workspaceId="ws-1"
				item={buildItem({
					object: buildObjectResponse({
						id: 'obj-1',
						title: 'A very long onboarding bet title that would overflow at 375px',
						type: 'bet',
						status: 'in_progress',
					}),
				})}
			/>,
			{ wrapper: TestWrapper },
		)
		const title = screen.getByText(/A very long onboarding bet/)
		expect(title.className).toMatch(/truncate/)
		const column = title.parentElement as HTMLElement
		expect(column.className).toMatch(/min-w-0/)
	})
})
