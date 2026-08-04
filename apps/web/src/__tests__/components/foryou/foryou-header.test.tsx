import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ForYouHeader } from '@/components/foryou/foryou-header'

function renderHeader(overrides: Partial<React.ComponentProps<typeof ForYouHeader>> = {}) {
	const props: React.ComponentProps<typeof ForYouHeader> = {
		unreadCount: 7,
		filter: 'all',
		onFilterChange: vi.fn(),
		allCount: 7,
		mentionCount: 3,
		mode: 'cards',
		onModeChange: vi.fn(),
		sort: 'priority',
		onSortChange: vi.fn(),
		briefOpen: false,
		onBriefToggle: vi.fn(),
		onStartConversation: vi.fn(),
		onCreateObject: vi.fn(),
		...overrides,
	}
	return { props, ...render(<ForYouHeader {...props} />) }
}

// Selector contract test — every assertion here maps to a getByRole call in
// T5's Playwright regression spec (`foryou-prototype-responsive.spec.ts`).
// Failing this test means the header lost a control the ship-gate E2E relies
// on, which is faster to catch here than in a full browser run.
describe('ForYouHeader', () => {
	it('exposes Cards/List as tabs', () => {
		renderHeader()
		expect(screen.getByRole('tab', { name: /cards/i })).toBeInTheDocument()
		expect(screen.getByRole('tab', { name: /list/i })).toBeInTheDocument()
	})

	it('exposes Sort, New, and Today\u2019s brief triggers as buttons', () => {
		renderHeader()
		expect(screen.getByRole('button', { name: /sort/i })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /^new$/i })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /today.?s brief/i })).toBeInTheDocument()
	})

	it('toggles the brief when its trigger is clicked', () => {
		const onBriefToggle = vi.fn()
		renderHeader({ onBriefToggle })
		fireEvent.click(screen.getByRole('button', { name: /today.?s brief/i }))
		expect(onBriefToggle).toHaveBeenCalledTimes(1)
	})

	it('marks the active mode tab as selected', () => {
		renderHeader({ mode: 'list' })
		const listTab = screen.getByRole('tab', { name: /list/i })
		const cardsTab = screen.getByRole('tab', { name: /cards/i })
		expect(listTab).toHaveAttribute('aria-selected', 'true')
		expect(cardsTab).toHaveAttribute('aria-selected', 'false')
	})
})
