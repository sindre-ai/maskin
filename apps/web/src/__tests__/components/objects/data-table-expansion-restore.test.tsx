import { getStaticColumns } from '@/components/objects/data-table/columns'
import { DataTable } from '@/components/objects/data-table/data-table'
import {
	__resetObjectsViewStateForTesting,
	getViewState,
	patchViewState,
} from '@/lib/objects-view-state'
import type {
	ExpandedState,
	OnChangeFn,
	RowSelectionState,
	VisibilityState,
} from '@tanstack/react-table'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ButtonHTMLAttributes, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildObjectResponse } from '../../factories'

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

vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => false,
	useIsTouchViewport: () => false,
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [] }),
}))

vi.mock('@tanstack/react-virtual', () => ({
	useVirtualizer: ({ count }: { count: number }) => ({
		getVirtualItems: () =>
			Array.from({ length: count }, (_, i) => ({
				index: i,
				key: i,
				start: i * 48,
				size: 48,
			})),
		getTotalSize: () => count * 48,
		measureElement: vi.fn(),
	}),
}))

globalThis.IntersectionObserver = vi.fn().mockImplementation(() => ({
	observe: vi.fn(),
	unobserve: vi.fn(),
	disconnect: vi.fn(),
}))

// Mirrors the objects route wiring for the pieces this test cares about: the
// controlled `expanded` lift, the write-on-change into the session store, and
// the POP-gated hydrate on the first render after arrival. Deliberately does
// not pull in the full route so this stays a unit-level regression on the
// DataTable + store contract.
function ObjectsPageHarness({
	workspaceId,
	displaySettingsKey,
	arrivalIsPop,
	data,
	grouping,
}: {
	workspaceId: string
	displaySettingsKey: string
	arrivalIsPop: boolean
	data: ReturnType<typeof buildObjectResponse>[]
	grouping: string[]
}) {
	const [expanded, setExpanded] = useState<ExpandedState>({})
	const hydratedRef = useRef(false)

	useEffect(() => {
		if (!arrivalIsPop || hydratedRef.current) return
		hydratedRef.current = true
		const { expandedGroupIds } = getViewState(workspaceId, displaySettingsKey)
		if (Object.keys(expandedGroupIds).length === 0) return
		setExpanded(expandedGroupIds)
	}, [arrivalIsPop, workspaceId, displaySettingsKey])

	const onExpandedChange: OnChangeFn<ExpandedState> = (updater) => {
		setExpanded((prev) => {
			const next = typeof updater === 'function' ? updater(prev) : updater
			const map: Record<string, boolean> = {}
			if (next !== true && next && typeof next === 'object') {
				for (const [id, on] of Object.entries(next)) if (on) map[id] = true
			}
			patchViewState(workspaceId, displaySettingsKey, { expandedGroupIds: map })
			return next
		})
	}

	return (
		<DataTable
			data={data}
			columns={getStaticColumns({ workspaceId })}
			workspaceId={workspaceId}
			rowSelection={{} as RowSelectionState}
			onRowSelectionChange={vi.fn()}
			columnVisibility={{} as VisibilityState}
			onColumnVisibilityChange={vi.fn()}
			grouping={grouping}
			expanded={expanded}
			onExpandedChange={onExpandedChange}
		/>
	)
}

beforeEach(() => {
	__resetObjectsViewStateForTesting()
	mockNavigate.mockClear()
})

describe('Objects list — group-expansion silent restore', () => {
	const data = [
		buildObjectResponse({ id: 'a', title: 'Alpha', status: 'active' }),
		buildObjectResponse({ id: 'b', title: 'Beta', status: 'active' }),
	]

	it('restores the group the user had open before back-navigating away', async () => {
		const user = userEvent.setup()

		const { unmount } = render(
			<ObjectsPageHarness
				workspaceId="ws-1"
				displaySettingsKey="bet"
				arrivalIsPop={false}
				data={data}
				grouping={['status']}
			/>,
		)

		const initialChevron = screen.getByRole('button', { expanded: false })
		await user.click(initialChevron)

		expect(screen.getByText('Alpha')).toBeInTheDocument()
		expect(screen.getByText('Beta')).toBeInTheDocument()
		expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument()

		const savedSnapshot = getViewState('ws-1', 'bet')
		expect(Object.values(savedSnapshot.expandedGroupIds).some(Boolean)).toBe(true)

		unmount()

		await act(async () => {
			render(
				<ObjectsPageHarness
					workspaceId="ws-1"
					displaySettingsKey="bet"
					arrivalIsPop={true}
					data={data}
					grouping={['status']}
				/>,
			)
		})

		expect(screen.getByText('Alpha')).toBeInTheDocument()
		expect(screen.getByText('Beta')).toBeInTheDocument()
		expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument()
	})

	it('does NOT restore expansion on a PUSH/REPLACE landing (the store slot exists but no back-nav happened)', async () => {
		patchViewState('ws-1', 'bet', { expandedGroupIds: { 'status:active': true } })

		render(
			<ObjectsPageHarness
				workspaceId="ws-1"
				displaySettingsKey="bet"
				arrivalIsPop={false}
				data={data}
				grouping={['status']}
			/>,
		)

		expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument()
		expect(screen.queryByText('Alpha')).not.toBeInTheDocument()
		expect(screen.queryByText('Beta')).not.toBeInTheDocument()
	})
})
