import { BulkSelectionContext, useBulkSelection } from '@/components/objects/bulk-selection-context'
import type { RowSelectionState } from '@tanstack/react-table'
import { act, render, renderHook, screen } from '@testing-library/react'
import { useCallback, useEffect, useMemo, useState } from 'react'

interface Row {
	id: string
	label: string
}

interface HarnessProps {
	workspaceId: string
	data: Row[]
}

function Harness({ workspaceId, data }: HarnessProps) {
	const [rowSelection, setRowSelection] = useState<RowSelectionState>({})

	const selectedIds = useMemo(() => Object.keys(rowSelection), [rowSelection])
	const clearSelection = useCallback(() => setRowSelection({}), [])
	// biome-ignore lint/correctness/useExhaustiveDependencies: mirror the route's workspace-switch reset
	useEffect(() => {
		setRowSelection({})
	}, [workspaceId])
	const bulkSelection = useMemo(
		() => ({ selectedIds, clearSelection }),
		[selectedIds, clearSelection],
	)

	return (
		<BulkSelectionContext.Provider value={bulkSelection}>
			<ul>
				{data.map((row) => (
					<li key={row.id}>
						<button
							type="button"
							data-testid={`toggle-${row.id}`}
							onClick={() =>
								setRowSelection((prev) =>
									prev[row.id]
										? Object.fromEntries(Object.entries(prev).filter(([k]) => k !== row.id))
										: { ...prev, [row.id]: true },
								)
							}
						>
							{row.label}
						</button>
					</li>
				))}
			</ul>
			<Consumer />
		</BulkSelectionContext.Provider>
	)
}

function Consumer() {
	const { selectedIds, clearSelection } = useBulkSelection()
	return (
		<div>
			<span data-testid="selected">{selectedIds.join(',')}</span>
			<button type="button" data-testid="clear" onClick={clearSelection}>
				Clear
			</button>
		</div>
	)
}

describe('BulkSelectionContext / useBulkSelection', () => {
	it('keeps selectedIds keyed by row id across re-render with reordered data', () => {
		const data: Row[] = [
			{ id: 'a', label: 'Alpha' },
			{ id: 'b', label: 'Bravo' },
			{ id: 'c', label: 'Charlie' },
		]
		const { rerender } = render(<Harness workspaceId="ws-1" data={data} />)

		act(() => {
			screen.getByTestId('toggle-a').click()
			screen.getByTestId('toggle-c').click()
		})

		expect(screen.getByTestId('selected').textContent).toBe('a,c')

		const sorted = [...data].reverse()
		rerender(<Harness workspaceId="ws-1" data={sorted} />)

		expect(screen.getByTestId('selected').textContent).toBe('a,c')
	})

	it('clearSelection empties selectedIds', () => {
		render(
			<Harness
				workspaceId="ws-1"
				data={[
					{ id: 'a', label: 'A' },
					{ id: 'b', label: 'B' },
				]}
			/>,
		)

		act(() => {
			screen.getByTestId('toggle-a').click()
			screen.getByTestId('toggle-b').click()
		})
		expect(screen.getByTestId('selected').textContent).toBe('a,b')

		act(() => {
			screen.getByTestId('clear').click()
		})
		expect(screen.getByTestId('selected').textContent).toBe('')
	})

	it('resets selection when workspaceId changes', () => {
		const data: Row[] = [
			{ id: 'a', label: 'A' },
			{ id: 'b', label: 'B' },
		]
		const { rerender } = render(<Harness workspaceId="ws-1" data={data} />)

		act(() => {
			screen.getByTestId('toggle-a').click()
		})
		expect(screen.getByTestId('selected').textContent).toBe('a')

		rerender(<Harness workspaceId="ws-2" data={data} />)
		expect(screen.getByTestId('selected').textContent).toBe('')
	})

	it('throws when useBulkSelection is called outside the provider', () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
		expect(() => renderHook(() => useBulkSelection())).toThrow(
			/useBulkSelection must be used within BulkSelectionContext.Provider/,
		)
		consoleError.mockRestore()
	})
})
