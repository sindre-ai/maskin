import { LoopViewTab } from '@/components/loops/loop-view-tab'
import { fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const flag = vi.hoisted(() => ({ on: false }))
const mobile = vi.hoisted(() => ({ on: false }))
vi.mock('@/hooks/use-feature-flag', () => ({ useFeatureFlag: () => flag.on }))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mobile.on }))

vi.mock('@/components/loops/loop-custom-view', () => ({
	LoopCustomView: ({
		fileId,
		onFailure,
		onOpenItem,
		onProposeChange,
		reloadToken,
	}: {
		fileId: string
		onFailure: (reason: string) => void
		onOpenItem?: (id: string) => void
		onProposeChange?: (change: { id: string; field: string; value: string }) => void
		reloadToken?: number
	}) => {
		useEffect(() => {
			if (fileId === 'bad') onFailure('The view file is not an HTML file.')
		}, [fileId, onFailure])
		return (
			<div
				data-testid="view"
				data-can-open={onOpenItem ? 'yes' : 'no'}
				data-can-propose={onProposeChange ? 'yes' : 'no'}
				data-reload={reloadToken}
			>
				<button type="button" onClick={() => onOpenItem?.('obj-1')}>
					open item
				</button>
				<button
					type="button"
					onClick={() =>
						onProposeChange?.({ id: 'obj-1', field: 'scheduled_date', value: '2026-11-14' })
					}
				>
					propose
				</button>
			</div>
		)
	},
}))
vi.mock('@/components/loops/loop-view-item-panel', () => ({
	LoopViewItemPanel: ({
		objectId,
		loopId,
		onClose,
	}: { objectId: string; loopId: string; onClose: () => void }) => (
		<div data-testid="panel">
			{loopId}:{objectId}
			<button type="button" onClick={onClose}>
				close panel
			</button>
		</div>
	),
}))

vi.mock('@/components/loops/loop-view-change-prompt', () => ({
	LoopViewChangePrompt: ({
		change,
		onCancel,
		onSaved,
	}: {
		change: { id: string; value: string } | null
		onCancel: () => void
		onSaved: () => void
	}) =>
		change ? (
			<div data-testid="prompt">
				{change.id}:{change.value}
				<button type="button" onClick={onCancel}>
					no
				</button>
				<button type="button" onClick={onSaved}>
					yes
				</button>
			</div>
		) : null,
}))

describe('LoopViewTab', () => {
	beforeEach(() => {
		flag.on = false
		mobile.on = false
	})

	it('renders the view with no note when it loads', () => {
		render(<LoopViewTab workspaceId="w" loopId="l" fileId="good" />)
		expect(screen.getByTestId('view')).toBeInTheDocument()
		expect(screen.queryByRole('alert')).toBeNull()
	})

	it('says in its own tab why a view cannot be shown', () => {
		render(<LoopViewTab workspaceId="w" loopId="l" fileId="bad" />)
		expect(screen.getByRole('alert')).toHaveTextContent(
			"This view can't be shown: The view file is not an HTML file.",
		)
		expect(screen.queryByTestId('view')).toBeNull()
	})

	it('leaves Open to go to the object page when the flag is off', () => {
		render(<LoopViewTab workspaceId="w" loopId="l" fileId="good" />)
		expect(screen.getByTestId('view')).toHaveAttribute('data-can-open', 'no')
		fireEvent.click(screen.getByText('open item'))
		expect(screen.queryByTestId('panel')).toBeNull()
	})

	it('shows the opened item beside the view, keeps the view mounted, and closes', () => {
		flag.on = true
		render(<LoopViewTab workspaceId="w" loopId="l" fileId="good" />)
		const view = screen.getByTestId('view')
		fireEvent.click(screen.getByText('open item'))
		expect(screen.getByTestId('panel')).toHaveTextContent('l:obj-1')
		expect(screen.getByTestId('view')).toBe(view)
		fireEvent.click(screen.getByText('close panel'))
		expect(screen.queryByTestId('panel')).toBeNull()
		expect(screen.getByTestId('view')).toBe(view)
	})

	it('shows the opened item in a sheet on a phone', () => {
		flag.on = true
		mobile.on = true
		render(<LoopViewTab workspaceId="w" loopId="l" fileId="good" />)
		fireEvent.click(screen.getByText('open item'))
		expect(screen.getByRole('dialog')).toContainElement(screen.getByTestId('panel'))
	})

	it('ignores a proposed change, and shows no question, when the flag is off', () => {
		render(<LoopViewTab workspaceId="w" loopId="l" fileId="good" />)
		expect(screen.getByTestId('view')).toHaveAttribute('data-can-propose', 'no')
		expect(screen.queryByTestId('prompt')).toBeNull()
	})

	it('asks before anything is saved, and a no leaves the view as it was', () => {
		flag.on = true
		render(<LoopViewTab workspaceId="w" loopId="l" fileId="good" />)
		fireEvent.click(screen.getByText('propose'))
		expect(screen.getByTestId('prompt')).toHaveTextContent('obj-1:2026-11-14')
		fireEvent.click(screen.getByText('no'))
		expect(screen.queryByTestId('prompt')).toBeNull()
		expect(screen.getByTestId('view')).toHaveAttribute('data-reload', '0')
	})

	it('reloads the view after a yes saved the change', () => {
		flag.on = true
		render(<LoopViewTab workspaceId="w" loopId="l" fileId="good" />)
		fireEvent.click(screen.getByText('propose'))
		fireEvent.click(screen.getByText('yes'))
		expect(screen.queryByTestId('prompt')).toBeNull()
		expect(screen.getByTestId('view')).toHaveAttribute('data-reload', '1')
	})
})
