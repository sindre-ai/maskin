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
	}: {
		fileId: string
		onFailure: (reason: string) => void
		onOpenItem?: (id: string) => void
	}) => {
		useEffect(() => {
			if (fileId === 'bad') onFailure('The view file is not an HTML file.')
		}, [fileId, onFailure])
		return (
			<div data-testid="view" data-can-open={onOpenItem ? 'yes' : 'no'}>
				<button type="button" onClick={() => onOpenItem?.('obj-1')}>
					open item
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
})
