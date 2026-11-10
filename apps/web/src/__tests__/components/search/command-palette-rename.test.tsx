import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

const navigateMock = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => navigateMock,
	useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
		select({ location: { pathname: '/ws-1/objects' } }),
}))
vi.mock('@/lib/command-palette-context', () => ({
	useCommandPalette: () => ({ open: true, setOpen: vi.fn() }),
}))
vi.mock('@/lib/theme', () => ({
	useTheme: () => ({ theme: 'light', resolvedTheme: 'light', setTheme: vi.fn() }),
}))
vi.mock('@/lib/api', () => ({ api: { search: { query: vi.fn() } } }))
vi.mock('@/hooks/use-objects', () => ({ useObjects: () => ({ data: [] }) }))
vi.mock('@/hooks/use-actors', () => ({ useActors: () => ({ data: [] }) }))
vi.mock('@/hooks/use-conversations', () => ({
	useConversationsInfinite: () => ({ data: { pages: [{ conversations: [] }] } }),
}))
vi.mock('@/hooks/use-loops', () => ({ useLoops: () => ({ data: [] }) }))
vi.mock('@/hooks/use-subscriptions', () => ({
	useUnread: () => ({ data: { items: [] } }),
	useMarkRead: () => ({ mutateAsync: vi.fn() }),
}))
vi.mock('@/hooks/use-available-object-types', () => ({
	useAvailableObjectTypes: () => [{ value: 'bet', label: 'Bets' }],
}))
vi.mock('@/components/shared/create-picker', () => ({ CreatePicker: () => null }))
vi.mock('@/lib/analytics', () => ({
	trackCommandPaletteOpened: vi.fn(),
	trackSearchFilterChanged: vi.fn(),
	trackSearchPerformed: vi.fn(),
	trackSearchResultOpened: vi.fn(),
}))

import { CommandPaletteV2 } from '@/components/search/command-palette-v2'
import { api } from '@/lib/api'

const field = () => screen.getByRole('combobox', { name: 'Search or run a command' })

beforeEach(() => {
	vi.mocked(api.search.query).mockResolvedValue({
		results: [],
		total: 0,
		capped: false,
		facets: {
			types: {},
			statuses: { needs_you: 0, in_progress: 0, new: 0, done: 0, archived: 0 },
		},
		relaxed: { withoutFilters: 0, withoutStatuses: 0 },
		partial: [],
	})
})

describe('launcher Go to and Commands after the rename', () => {
	it.each([
		['flows', 'Flows'],
		['loops', 'Flows'],
		['items', 'Items'],
		['objects', 'Items'],
	])('finds the %s view as "%s" in Go to', async (query, title) => {
		const user = userEvent.setup()
		render(<CommandPaletteV2 />, { wrapper: createWorkspaceWrapper({ id: 'ws-1' }) })
		await user.type(field(), query)
		const group = await screen.findByRole('group', { name: 'Go to' })
		expect(within(group).getByRole('option', { name: new RegExp(`^${title}`) })).toBeTruthy()
	})

	it.each(['new flow', 'new loop'])('finds the New flow command for "%s"', async (query) => {
		const user = userEvent.setup()
		render(<CommandPaletteV2 />, { wrapper: createWorkspaceWrapper({ id: 'ws-1' }) })
		await user.type(field(), query)
		const group = await screen.findByRole('group', { name: 'Commands' })
		expect(within(group).getByRole('option', { name: /New flow/ })).toBeTruthy()
	})
})
