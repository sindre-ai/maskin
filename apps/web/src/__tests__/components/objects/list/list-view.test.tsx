import { ListView } from '@/components/objects/list/list-view'
import type { GroupingState, RowSelectionState, VisibilityState } from '@tanstack/react-table'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
	type ButtonHTMLAttributes,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	useState,
} from 'react'
import { describe, expect, it, vi } from 'vitest'
import { buildObjectResponse } from '../../../factories'

const mockNavigate = vi.fn()

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => mockNavigate,
	Link: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => {
		const { to, params, onClick, ...rest } = props
		return (
			<button
				type="button"
				{...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}
				onClick={(e) => {
					if (typeof onClick === 'function') {
						;(onClick as (ev: ReactMouseEvent<HTMLButtonElement>) => void)(e)
					}
					e.preventDefault()
					mockNavigate({ to, params })
				}}
			>
				{children}
			</button>
		)
	},
}))

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => <span>agent working</span>,
}))

// jsdom does not support IntersectionObserver; the sentinel effect needs it.
globalThis.IntersectionObserver = vi.fn().mockImplementation(() => ({
	observe: vi.fn(),
	unobserve: vi.fn(),
	disconnect: vi.fn(),
}))

const deployedAt = '2026-08-01T12:00:00.000Z'

// Wraps ListView so checkbox clicks and group-header toggles in tests visibly
// round-trip through the controlled rowSelection + expanded boundaries.
// Production wiring lives in the Objects route; this harness just keeps the
// primitive testable.
function StatefulListViewHarness(
	props: Omit<
		Parameters<typeof ListView>[0],
		'rowSelection' | 'onRowSelectionChange' | 'expanded' | 'onExpandedChange'
	>,
) {
	const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
	const [expanded, setExpanded] = useState<Record<string, boolean>>({})
	return (
		<ListView
			{...props}
			rowSelection={rowSelection}
			onRowSelectionChange={setRowSelection}
			expanded={expanded}
			onExpandedChange={setExpanded}
		/>
	)
}

interface ListViewRenderOverrides extends Partial<Parameters<typeof ListView>[0]> {
	data: Array<ReturnType<typeof buildObjectResponse>>
}

function renderListView(overrides: ListViewRenderOverrides) {
	const props = {
		workspaceId: 'ws-1',
		actors: [],
		columnVisibility: {} as VisibilityState,
		grouping: undefined as GroupingState | undefined,
		...overrides,
	}
	return render(<StatefulListViewHarness {...props} />)
}

function groupHeaders(): HTMLElement[] {
	return screen
		.getAllByRole('button')
		.filter((button) => button.getAttribute('aria-expanded') !== null)
}

// Indexed access is `T | undefined` under noUncheckedIndexedAccess and
// non-null assertions are banned by Biome — these guards keep the assertions
// explicit where a missing element means the fixture/setup is broken.
function indexAt<T>(list: readonly T[], index: number): T {
	const item = list[index]
	if (item === undefined) throw new Error(`expected an element at index ${index}`)
	return item
}

function queryRow(rowId: string): Element {
	const el = document.querySelector(`[data-obj-id="${rowId}"]`)
	if (!el) throw new Error(`row ${rowId} not found in the document`)
	return el
}

describe('ListView', () => {
	beforeEach(() => {
		mockNavigate.mockClear()
	})

	it('renders real objects grouped by the shared filter model, in first-occurrence order', () => {
		const data = [
			buildObjectResponse({ id: 'obj-1', title: 'Alpha', status: 'active', updatedAt: deployedAt }),
			buildObjectResponse({ id: 'obj-2', title: 'Beta', status: 'done', updatedAt: deployedAt }),
			buildObjectResponse({ id: 'obj-3', title: 'Gamma', status: 'active', updatedAt: deployedAt }),
		]
		renderListView({ data, grouping: ['status'] as GroupingState })

		const headers = groupHeaders()
		// Heads follow the shared model's ordering — the API-sorted data order,
		// not an alphabetised status sort: active (rows 1,3) before done (row 2).
		expect(headers).toHaveLength(2)
		expect(headers[0]?.textContent).toContain('active')
		expect(headers[0]?.textContent).toContain('2')
		expect(headers[1]?.textContent).toContain('done')
		expect(headers[1]?.textContent).toContain('1')

		// Rows land under their owning group (expanded group in DOM).
		act(() => {
			headers[0]?.click()
		})
		expect(screen.getByText('Alpha')).toBeInTheDocument()
		expect(screen.getByText('Gamma')).toBeInTheDocument()
	})

	it('shows type label, name link, status tag, updated time and chevron on each row', () => {
		const data = [
			buildObjectResponse({
				id: 'obj-1',
				type: 'bet',
				title: 'Alpha',
				status: 'in_progress',
				updatedAt: deployedAt,
			}),
		]
		renderListView({ data })

		// Type label (monospace uppercase chip).
		expect(screen.getByText('bet')).toBeInTheDocument()

		// Name is the shared Link → mock button; clicking navigates.
		const titleLink = screen.getByRole('button', { name: 'Alpha' })
		titleLink.click()
		expect(mockNavigate).toHaveBeenCalledWith({
			to: '/$workspaceId/objects/$objectId',
			params: { workspaceId: 'ws-1', objectId: 'obj-1' },
		})

		// Status tag (StatusBadge dot-word renders the de-underscored status).
		expect(screen.getByText('in progress')).toBeInTheDocument()

		// Updated-time (RelativeTime) renders something for a known date.
		expect(screen.getByText(/ago/i)).toBeInTheDocument()

		// Per-row open chevron.
		expect(screen.getAllByRole('button', { name: /open object/i })).not.toHaveLength(0)
	})

	it('toggles row selection through the controlled rowSelection boundary', async () => {
		const user = userEvent.setup()
		const data = [
			buildObjectResponse({ id: 'obj-1', title: 'Alpha', updatedAt: deployedAt }),
			buildObjectResponse({ id: 'obj-2', title: 'Beta', updatedAt: deployedAt }),
		]
		renderListView({ data })

		const checkboxes = screen.getAllByRole('checkbox')
		expect(checkboxes).toHaveLength(2)
		expect(checkboxes[0]).not.toBeChecked()

		await user.click(indexAt(checkboxes, 0))
		expect(checkboxes[0]).toBeChecked()
		expect(checkboxes[1]).not.toBeChecked()

		await user.click(indexAt(checkboxes, 0))
		expect(checkboxes[0]).not.toBeChecked()
	})

	it('extends selection to a range on shift-click within the same group', async () => {
		const user = userEvent.setup()
		const data = [
			buildObjectResponse({ id: 'obj-1', title: 'Alpha', status: 'active', updatedAt: deployedAt }),
			buildObjectResponse({ id: 'obj-2', title: 'Beta', status: 'active', updatedAt: deployedAt }),
			buildObjectResponse({ id: 'obj-3', title: 'Gamma', status: 'active', updatedAt: deployedAt }),
		]
		renderListView({ data })

		const checkboxes = screen.getAllByRole('checkbox')
		// Anchor the range on the first row's checkbox...
		await user.click(indexAt(checkboxes, 0))

		// ...then shift-click the third row's background. The checkbox and the
		// title Link both stop propagation, so the shift-click must land on the
		// row's own surface (what a real user does in the gap between cells).
		// fireEvent (not a raw dispatchEvent) so the click is act-flushed and
		// reconciles against the committed rowSelection before the range runs.
		fireEvent.click(queryRow('obj-3'), { shiftKey: true })

		expect(screen.getAllByRole('checkbox')[0]).toBeChecked()
		expect(screen.getAllByRole('checkbox')[1]).toBeChecked()
		expect(screen.getAllByRole('checkbox')[2]).toBeChecked()
	})

	it('caps a group at six rows with an expandable "Show N more" affordance', async () => {
		const user = userEvent.setup()
		const data = Array.from({ length: 8 }, (_, i) =>
			buildObjectResponse({
				id: `obj-${i + 1}`,
				title: `Row ${i + 1}`,
				status: 'active',
				updatedAt: deployedAt,
			}),
		)
		renderListView({ data, grouping: ['status'] as GroupingState })
		act(() => {
			groupHeaders()[0]?.click()
		})

		expect(screen.getAllByRole('checkbox')).toHaveLength(6)
		const showMore = screen.getByRole('button', { name: /show 2 more/i })
		expect(showMore).toBeInTheDocument()

		await user.click(showMore)
		expect(screen.getAllByRole('checkbox')).toHaveLength(8)
		expect(screen.queryByRole('button', { name: /show 2 more/i })).toBeNull()
	})

	it('collapsing a group removes its rows while other groups stay intact', async () => {
		const user = userEvent.setup()
		const data = [
			buildObjectResponse({ id: 'obj-1', title: 'Alpha', status: 'active', updatedAt: deployedAt }),
			buildObjectResponse({ id: 'obj-2', title: 'Beta', status: 'done', updatedAt: deployedAt }),
		]
		renderListView({ data, grouping: ['status'] as GroupingState })
		// Expand both groups so collapsing one can be checked against the other.
		act(() => {
			groupHeaders()[0]?.click()
		})
		act(() => {
			groupHeaders()[1]?.click()
		})
		expect(screen.getByText('Alpha')).toBeInTheDocument()
		expect(screen.getByText('Beta')).toBeInTheDocument()

		await user.click(indexAt(groupHeaders(), 0))
		expect(screen.queryByText('Alpha')).toBeNull()
		expect(screen.getByText('Beta')).toBeInTheDocument()
	})

	it('composes shared primitives — Checkbox, StatusBadge, RelativeTime — instead of bespoke markup', () => {
		const data = [
			buildObjectResponse({
				id: 'obj-1',
				title: 'Alpha',
				type: 'task',
				status: 'done',
				updatedAt: deployedAt,
			}),
		]
		renderListView({ data })

		// ui/checkbox renders a native checkbox role.
		expect(screen.getAllByRole('checkbox').length).toBeGreaterThan(0)
		// shared/status-badge renders the status word (dot-word variant).
		// shared/relative-time renders the "x ago" timestamp.
		// shared/actor-avatar is absent (no driver) — null driver renders nothing.
		expect(screen.getAllByText('done').length).toBeGreaterThan(0)
		expect(screen.getByText(/ago/i)).toBeInTheDocument()
	})
})
