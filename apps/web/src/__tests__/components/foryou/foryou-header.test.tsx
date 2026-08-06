import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => mockNavigate,
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

import {
	ForYouHeader,
	ForYouHeaderActions,
	ForYouHeaderIdentity,
} from '@/components/foryou/foryou-header'

function renderHeader(overrides: Partial<React.ComponentProps<typeof ForYouHeader>> = {}) {
	const props: React.ComponentProps<typeof ForYouHeader> = {
		unreadCount: 7,
		typeFilter: undefined,
		onTypeFilterChange: vi.fn(),
		typeCounts: new Map([
			['bet', 3],
			['insight', 2],
		]),
		mentionCount: 3,
		mode: 'cards',
		onModeChange: vi.fn(),
		sort: 'priority',
		onSortChange: vi.fn(),
		...overrides,
	}
	return { props, ...render(<ForYouHeader {...props} />) }
}

function renderActions(overrides: Partial<React.ComponentProps<typeof ForYouHeaderActions>> = {}) {
	const props: React.ComponentProps<typeof ForYouHeaderActions> = {
		onStartConversation: vi.fn(),
		onCreateObject: vi.fn(),
		...overrides,
	}
	return { props, ...render(<ForYouHeaderActions {...props} />) }
}

describe('ForYouHeaderIdentity', () => {
	it('shows the unread count', () => {
		render(<ForYouHeaderIdentity unreadCount={7} />)
		expect(screen.getByText('7 unread')).toBeInTheDocument()
	})
})

describe('ForYouHeaderActions', () => {
	it("navigates to the briefing route when Today's brief is clicked", () => {
		renderActions()
		fireEvent.click(screen.getByRole('button', { name: /today.?s brief/i }))
		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId/briefing',
			params: { workspaceId: 'ws-1' },
		})
	})

	it('opens the New menu and starts a conversation', async () => {
		const user = userEvent.setup()
		const onStartConversation = vi.fn()
		renderActions({ onStartConversation })
		await user.click(screen.getByRole('button', { name: /^new$/i }))
		await user.click(screen.getByRole('menuitem', { name: /start conversation/i }))
		expect(onStartConversation).toHaveBeenCalledTimes(1)
	})

	it('opens the New menu and creates a bet', async () => {
		const user = userEvent.setup()
		const onCreateObject = vi.fn()
		renderActions({ onCreateObject })
		await user.click(screen.getByRole('button', { name: /^new$/i }))
		await user.click(screen.getByRole('menuitem', { name: /new bet/i }))
		expect(onCreateObject).toHaveBeenCalledWith('bet')
	})
})

describe('ForYouHeader', () => {
	it('renders All + Mentions plus one chip per type present in typeCounts', () => {
		renderHeader({
			unreadCount: 7,
			mentionCount: 3,
			typeCounts: new Map([
				['bet', 3],
				['insight', 2],
			]),
		})
		expect(screen.getByRole('button', { name: 'All (7)' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Mentions (3)' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Bet (3)' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Insight (2)' })).toBeInTheDocument()
	})

	it('calls onTypeFilterChange with undefined when All is clicked', () => {
		const onTypeFilterChange = vi.fn()
		renderHeader({ typeFilter: 'bet', onTypeFilterChange })
		fireEvent.click(screen.getByRole('button', { name: /^All/ }))
		expect(onTypeFilterChange).toHaveBeenCalledWith(undefined)
	})

	it('calls onTypeFilterChange with "mentions" when Mentions is clicked', () => {
		const onTypeFilterChange = vi.fn()
		renderHeader({ onTypeFilterChange })
		fireEvent.click(screen.getByRole('button', { name: /^Mentions/ }))
		expect(onTypeFilterChange).toHaveBeenCalledWith('mentions')
	})

	it('calls onTypeFilterChange with the raw type when a type chip is clicked', () => {
		const onTypeFilterChange = vi.fn()
		renderHeader({ onTypeFilterChange })
		fireEvent.click(screen.getByRole('button', { name: /^Bet/ }))
		expect(onTypeFilterChange).toHaveBeenCalledWith('bet')
	})

	it('hides the Mentions chip and zero-count type chips instead of showing (0)', () => {
		renderHeader({
			unreadCount: 4,
			mentionCount: 0,
			typeCounts: new Map([
				['task', 3],
				['bet', 1],
				['insight', 0],
			]),
		})
		expect(screen.getByRole('button', { name: 'All (4)' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Task (3)' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Bet (1)' })).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /^Mentions/ })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /^Insight/ })).not.toBeInTheDocument()
	})

	it('opens the Display popover with Cards/List tabs and Sort options', async () => {
		const user = userEvent.setup()
		renderHeader()
		await user.click(screen.getByRole('button', { name: /display options/i }))
		expect(screen.getByRole('tab', { name: /cards/i })).toBeInTheDocument()
		expect(screen.getByRole('tab', { name: /list/i })).toBeInTheDocument()
		expect(screen.getByRole('radio', { name: /priority/i })).toBeInTheDocument()
		expect(screen.getByRole('radio', { name: /latest activity/i })).toBeInTheDocument()
	})

	it('calls onModeChange when the List tab is clicked', async () => {
		const user = userEvent.setup()
		const onModeChange = vi.fn()
		renderHeader({ onModeChange })
		await user.click(screen.getByRole('button', { name: /display options/i }))
		await user.click(screen.getByRole('tab', { name: /list/i }))
		expect(onModeChange).toHaveBeenCalledWith('list')
	})

	it('calls onSortChange when Latest activity is selected', async () => {
		const user = userEvent.setup()
		const onSortChange = vi.fn()
		renderHeader({ onSortChange })
		await user.click(screen.getByRole('button', { name: /display options/i }))
		await user.click(screen.getByRole('radio', { name: /latest activity/i }))
		expect(onSortChange).toHaveBeenCalledWith('latest')
	})
})
