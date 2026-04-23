import { SLASH_KINDS, SlashPicker, type SlashPickerResult } from '@/components/sindre/slash-picker'
import { queryKeys } from '@/lib/query-keys'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorListItem, buildObjectResponse } from '../../factories'
import { createTestQueryClient } from '../../setup'

global.ResizeObserver = vi.fn().mockImplementation(() => ({
	observe: vi.fn(),
	unobserve: vi.fn(),
	disconnect: vi.fn(),
}))

Element.prototype.scrollIntoView = vi.fn()

vi.mock('@/lib/api', () => ({
	api: {
		actors: { list: vi.fn() },
		objects: { list: vi.fn(), search: vi.fn() },
		notifications: { list: vi.fn() },
	},
}))

import { api } from '@/lib/api'

const listAgents = () => [
	buildActorListItem({ id: 'actor-a', name: 'Reviewer', type: 'agent', email: null }),
	buildActorListItem({ id: 'actor-b', name: 'Planner', type: 'agent', email: null }),
	// A human — should be filtered out by the agent kind.
	buildActorListItem({ id: 'actor-c', name: 'Hank Human', type: 'human', email: 'h@x.io' }),
]

const listObjects = () => [
	buildObjectResponse({ id: 'obj-1', title: 'Bet Alpha', type: 'bet' }),
	buildObjectResponse({ id: 'obj-2', title: 'Task Beta', type: 'task' }),
]

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(api.actors.list).mockResolvedValue(listAgents())
	vi.mocked(api.objects.list).mockResolvedValue(listObjects())
	vi.mocked(api.objects.search).mockResolvedValue(listObjects())
	vi.mocked(api.notifications.list).mockResolvedValue([])
})

function renderPicker(
	overrides: Partial<React.ComponentProps<typeof SlashPicker>> = {},
	queryClient: QueryClient = createTestQueryClient(),
): {
	onSelect: ReturnType<typeof vi.fn>
	onOpenChange: ReturnType<typeof vi.fn>
	queryClient: QueryClient
} {
	const onSelect = vi.fn<(r: SlashPickerResult) => void>()
	const onOpenChange = vi.fn()
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	)
	render(
		<SlashPicker
			workspaceId="ws-1"
			open
			onOpenChange={onOpenChange}
			onSelect={onSelect}
			{...overrides}
		/>,
		{ wrapper },
	)
	return { onSelect, onOpenChange, queryClient }
}

describe('SLASH_KINDS registry', () => {
	it('ships with the two initial kinds in a stable order', () => {
		expect(SLASH_KINDS.map((k) => k.id)).toEqual(['agent', 'item'])
		expect(SLASH_KINDS.find((k) => k.id === 'agent')?.multi).toBe(false)
		expect(SLASH_KINDS.find((k) => k.id === 'item')?.multi).toBe(true)
	})
})

describe('<SlashPicker>', () => {
	it('renders the top-level kind menu when no initialKindId is set', () => {
		renderPicker()

		expect(screen.getByPlaceholderText('Choose a kind…')).toBeInTheDocument()
		expect(screen.getByText('Agent')).toBeInTheDocument()
		expect(screen.getByText('Item')).toBeInTheDocument()
	})

	it('drills into a kind when its menu entry is clicked', async () => {
		const user = userEvent.setup()
		renderPicker()

		await user.click(screen.getByText('Agent'))
		expect(await screen.findByPlaceholderText('Search agents…')).toBeInTheDocument()
	})

	it('opens directly in a kind when initialKindId is provided', async () => {
		renderPicker({ initialKindId: 'agent' })

		expect(screen.getByPlaceholderText('Search agents…')).toBeInTheDocument()
		// Top-level kind menu heading is not shown.
		expect(screen.queryByText(/Pick a kind/i)).not.toBeInTheDocument()
	})

	it('loads and displays agent items, filters out humans', async () => {
		renderPicker({ initialKindId: 'agent' })

		expect(await screen.findByText('Reviewer')).toBeInTheDocument()
		expect(screen.getByText('Planner')).toBeInTheDocument()
		expect(screen.queryByText('Hank Human')).not.toBeInTheDocument()
	})

	it('single-selecting an agent fires onSelect and requests close', async () => {
		const user = userEvent.setup()
		const { onSelect, onOpenChange } = renderPicker({ initialKindId: 'agent' })

		const item = await screen.findByText('Reviewer')
		await user.click(item)

		expect(onSelect).toHaveBeenCalledTimes(1)
		expect(onSelect.mock.calls[0][0]).toEqual({
			kind: 'agent',
			ref: { id: 'actor-a', name: 'Reviewer' },
		})
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it('multi-selecting an object fires onSelect without closing', async () => {
		const user = userEvent.setup()
		const { onSelect, onOpenChange } = renderPicker({ initialKindId: 'item' })

		const item = await screen.findByText('Bet Alpha')
		await user.click(item)

		expect(onSelect).toHaveBeenCalledWith({
			kind: 'object',
			ref: { id: 'obj-1', title: 'Bet Alpha', type: 'bet' },
		})
		// Multi-select does NOT close the picker.
		expect(onOpenChange).not.toHaveBeenCalledWith(false)
	})

	it('renders a checkmark for already-selected objects', async () => {
		renderPicker({
			initialKindId: 'item',
			selected: { objects: [{ id: 'obj-1', title: 'Bet Alpha', type: 'bet' }] },
		})

		const row = await screen.findByRole('option', { name: /Bet Alpha/ })
		expect(within(row).getByLabelText('Selected')).toBeInTheDocument()

		const otherRow = screen.getByRole('option', { name: /Task Beta/ })
		expect(within(otherRow).queryByLabelText('Selected')).not.toBeInTheDocument()
	})

	it('calls the object search endpoint when a query is entered', async () => {
		const user = userEvent.setup()
		renderPicker({ initialKindId: 'item' })

		await user.type(screen.getByPlaceholderText('Search items…'), 'alpha')

		await waitFor(() => expect(api.objects.search).toHaveBeenCalled())
		const lastCall = vi.mocked(api.objects.search).mock.calls.at(-1)
		expect(lastCall?.[0]).toBe('ws-1')
		expect(lastCall?.[1]).toMatchObject({ q: 'alpha' })
	})

	it('shows a Load more button after a full first page and appends the next page on click', async () => {
		const fullPage = Array.from({ length: 20 }, (_, i) =>
			buildObjectResponse({ id: `obj-p1-${i}`, title: `First ${i}`, type: 'task' }),
		)
		const nextPage = Array.from({ length: 5 }, (_, i) =>
			buildObjectResponse({ id: `obj-p2-${i}`, title: `Second ${i}`, type: 'task' }),
		)
		vi.mocked(api.objects.list).mockResolvedValueOnce(fullPage).mockResolvedValueOnce(nextPage)

		const user = userEvent.setup()
		renderPicker({ initialKindId: 'item' })

		const loadMore = await screen.findByRole('button', { name: 'Load more' })
		expect(api.objects.list).toHaveBeenCalledTimes(1)

		await user.click(loadMore)

		await waitFor(() => expect(api.objects.list).toHaveBeenCalledTimes(2))
		expect(vi.mocked(api.objects.list).mock.calls[1][1]).toMatchObject({
			limit: '20',
			offset: '20',
		})
		expect(await screen.findByText('Second 0')).toBeInTheDocument()
		// Second page returned fewer than the page size, so the button is gone.
		await waitFor(() => {
			expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
		})
	})

	it('walks back to the kind menu when Backspace is pressed on an empty query', async () => {
		const user = userEvent.setup()
		renderPicker()

		await user.click(screen.getByText('Agent'))
		const input = await screen.findByPlaceholderText('Search agents…')
		expect(input).toBeInTheDocument()

		fireEvent.keyDown(input, { key: 'Backspace' })

		await waitFor(() => expect(screen.getByPlaceholderText('Choose a kind…')).toBeInTheDocument())
	})

	it('requests close on Escape', async () => {
		const { onOpenChange } = renderPicker()

		fireEvent.keyDown(screen.getByPlaceholderText('Choose a kind…'), { key: 'Escape' })
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it('shows an error message when the kind search throws', async () => {
		vi.mocked(api.actors.list).mockRejectedValueOnce(new Error('boom'))
		renderPicker({ initialKindId: 'agent' })

		expect(await screen.findByText('boom')).toBeInTheDocument()
	})

	it('shows the empty copy when a kind returns zero items', async () => {
		vi.mocked(api.actors.list).mockResolvedValueOnce([])
		renderPicker({ initialKindId: 'agent' })

		expect(await screen.findByText('No agents found.')).toBeInTheDocument()
	})

	it('reuses the useActors query cache instead of refetching on open', async () => {
		const cached = [
			buildActorListItem({ id: 'cached-1', name: 'Cached Agent', type: 'agent', email: null }),
		]
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		})
		queryClient.setQueryData(queryKeys.actors.all('ws-1'), cached)

		renderPicker({ initialKindId: 'agent' }, queryClient)

		expect(await screen.findByText('Cached Agent')).toBeInTheDocument()
		expect(api.actors.list).not.toHaveBeenCalled()
	})
})
