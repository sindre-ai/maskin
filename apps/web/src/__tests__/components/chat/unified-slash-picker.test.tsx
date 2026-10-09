import { detectUnifiedSlashTransition } from '@/components/chat/chat'
import {
	UnifiedChatSlashPicker,
	type UnifiedSlashSelection,
} from '@/components/chat/unified-slash-picker'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildObjectResponse } from '../../factories'

global.ResizeObserver = vi.fn().mockImplementation(() => ({
	observe: vi.fn(),
	unobserve: vi.fn(),
	disconnect: vi.fn(),
}))

Element.prototype.scrollIntoView = vi.fn()

vi.mock('@/lib/api', () => ({
	api: {
		objects: { list: vi.fn(), search: vi.fn() },
	},
}))

const trackErrorMock = vi.fn()
vi.mock('@/lib/analytics', async () => {
	const actual = await vi.importActual<typeof import('@/lib/analytics')>('@/lib/analytics')
	return {
		...actual,
		trackChatSlashPickerError: (...args: unknown[]) => trackErrorMock(...args),
	}
})

import { api } from '@/lib/api'

function renderPicker(
	overrides: Partial<React.ComponentProps<typeof UnifiedChatSlashPicker>> = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	})
	const onSelect = vi.fn<(s: UnifiedSlashSelection) => void>()
	const onOpenChange = vi.fn()
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	)
	render(
		<UnifiedChatSlashPicker
			workspaceId="ws-1"
			open
			onOpenChange={onOpenChange}
			query=""
			typeFilter={null}
			onSelect={onSelect}
			{...overrides}
		/>,
		{ wrapper },
	)
	return { onSelect, onOpenChange }
}

beforeEach(() => {
	vi.clearAllMocks()
	trackErrorMock.mockClear()
	vi.mocked(api.objects.list).mockResolvedValue([
		buildObjectResponse({ id: 'obj-1', title: 'Recent Bet', type: 'bet' }),
		buildObjectResponse({ id: 'obj-2', title: 'Older Task', type: 'task' }),
	])
	vi.mocked(api.objects.search).mockResolvedValue([
		buildObjectResponse({ id: 'obj-match', title: 'Alpha', type: 'bet' }),
	])
})

describe('detectUnifiedSlashTransition', () => {
	it('opens the picker when `/` is typed at the start of the input', () => {
		expect(
			detectUnifiedSlashTransition({
				next: '/',
				pos: 1,
				slashStart: null,
				typeFilterChip: null,
			}),
		).toEqual({ type: 'open', slashStart: 0 })
	})

	it('opens the picker when `/` follows whitespace', () => {
		expect(
			detectUnifiedSlashTransition({
				next: 'hello /',
				pos: 7,
				slashStart: null,
				typeFilterChip: null,
			}),
		).toEqual({ type: 'open', slashStart: 6 })
	})

	it('does not open when `/` is mid-word (URLs, paths)', () => {
		expect(
			detectUnifiedSlashTransition({
				next: 'https://example.com',
				pos: 8,
				slashStart: null,
				typeFilterChip: null,
			}),
		).toEqual({ type: 'noop' })
	})

	it('closes the picker when the `/` was deleted', () => {
		expect(
			detectUnifiedSlashTransition({
				next: 'hello',
				pos: 5,
				slashStart: 5,
				typeFilterChip: null,
			}),
		).toEqual({ type: 'close' })
	})

	it('promotes `/task ` to a type-filter chip', () => {
		expect(
			detectUnifiedSlashTransition({
				next: '/task ',
				pos: 6,
				slashStart: 0,
				typeFilterChip: null,
			}),
		).toEqual({
			type: 'promote_to_chip',
			objectType: 'task',
			nextValue: '',
			nextSlashStart: null,
			nextCaret: 0,
		})
	})

	it('does not promote when the chip is already set', () => {
		expect(
			detectUnifiedSlashTransition({
				next: 'bet ',
				pos: 4,
				slashStart: null,
				typeFilterChip: 'task',
			}),
		).toEqual({ type: 'noop' })
	})

	it('does nothing when the caret already matches the tracked `/`', () => {
		expect(
			detectUnifiedSlashTransition({
				next: '/al',
				pos: 3,
				slashStart: 0,
				typeFilterChip: null,
			}),
		).toEqual({ type: 'noop' })
	})
})

describe('<UnifiedChatSlashPicker>', () => {
	it('renders Reference (recent) + Create-new on empty query', async () => {
		renderPicker()
		expect(await screen.findByText('Recent Bet')).toBeInTheDocument()
		expect(screen.getByText('Older Task')).toBeInTheDocument()
		// The three built-in NEWKIND rows always render.
		expect(screen.getByText('Task')).toBeInTheDocument()
		expect(screen.getByText('Bet')).toBeInTheDocument()
		expect(screen.getByText('Insight')).toBeInTheDocument()
		// Section headings are rendered as eyebrow labels.
		expect(screen.getByText('Reference')).toBeInTheDocument()
		expect(screen.getByText('Create new')).toBeInTheDocument()
	})

	it('runs search_objects when a query is present, and reflects it in the copy', async () => {
		renderPicker({ query: 'alph' })
		await waitFor(() => expect(api.objects.search).toHaveBeenCalled())
		const lastCall = vi.mocked(api.objects.search).mock.calls.at(-1)
		expect(lastCall?.[1]).toMatchObject({ q: 'alph', limit: '5' })
		expect(await screen.findByText('Alpha')).toBeInTheDocument()
		// Create rows show the seeded verbatim copy.
		expect(screen.getByText('Create task "alph"')).toBeInTheDocument()
		expect(screen.getByText('Create bet "alph"')).toBeInTheDocument()
		expect(screen.getByText('Create insight "alph"')).toBeInTheDocument()
	})

	it('narrows both sections when a type-filter chip is set', async () => {
		renderPicker({ typeFilter: 'task', query: '' })
		await waitFor(() => expect(api.objects.list).toHaveBeenCalled())
		const lastCall = vi.mocked(api.objects.list).mock.calls.at(-1)
		expect(lastCall?.[1]).toMatchObject({ type: 'task' })
		// Only the single create row for the chip type is rendered.
		expect(screen.getByText('Create task')).toBeInTheDocument()
		expect(screen.queryByText('Create bet')).not.toBeInTheDocument()
	})

	it('shows the empty-result copy when a query has zero matches', async () => {
		vi.mocked(api.objects.search).mockResolvedValueOnce([])
		renderPicker({ query: 'nothing here' })
		expect(
			await screen.findByText('Nothing in this workspace matches "nothing here".'),
		).toBeInTheDocument()
		// Create-new section still renders — the picker never dead-ends.
		expect(screen.getByText('Create task "nothing here"')).toBeInTheDocument()
	})

	it('renders the footer strip with per-section counts', async () => {
		renderPicker()
		await screen.findByText('Recent Bet')
		expect(
			screen.getByText('↑↓ navigate · ↵ select · esc close · 2 recent · 3 create'),
		).toBeInTheDocument()
	})

	it('selecting a Reference row fires onSelect with the object', async () => {
		const { onSelect } = renderPicker()
		fireEvent.click(await screen.findByText('Recent Bet'))
		expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reference' }))
		expect(onSelect.mock.calls[0][0]).toMatchObject({
			kind: 'reference',
			object: { id: 'obj-1', title: 'Recent Bet' },
		})
	})

	it('selecting a Create-new row fires onSelect with the seeded title', () => {
		const { onSelect } = renderPicker({ query: 'seed title' })
		fireEvent.click(screen.getByText('Create task "seed title"'))
		expect(onSelect).toHaveBeenCalledWith({
			kind: 'create',
			objectType: 'task',
			seedTitle: 'seed title',
		})
	})

	it('shows the error state with a Retry button when search fails', async () => {
		vi.mocked(api.objects.search).mockRejectedValueOnce(new Error('boom'))
		renderPicker({ query: 'alph' })
		expect(await screen.findByText("Couldn't search — try again")).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
		await waitFor(() => expect(trackErrorMock).toHaveBeenCalled())
	})

	it('exposes role=listbox with role=option rows for keyboard navigation', async () => {
		renderPicker()
		expect(await screen.findByRole('listbox', { name: 'Reference or create' })).toBeInTheDocument()
		// Wait for the reference section to settle so both reference and create rows are present.
		await screen.findByText('Recent Bet')
		const options = screen.getAllByRole('option')
		// 2 references + 3 create rows.
		expect(options).toHaveLength(5)
	})
})
