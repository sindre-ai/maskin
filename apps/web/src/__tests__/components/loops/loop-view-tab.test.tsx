import { LoopViewTab } from '@/components/loops/loop-view-tab'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const flag = vi.hoisted(() => ({ on: false }))
const mobile = vi.hoisted(() => ({ on: false }))
vi.mock('@/hooks/use-feature-flag', () => ({ useFeatureFlag: () => flag.on }))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mobile.on }))
const files = vi.hoisted(() => ({ byId: {} as Record<string, unknown> }))
vi.mock('@/hooks/use-files', () => ({
	useFile: (_w: string, id: string) => ({ data: files.byId[id] }),
}))
vi.mock('@/components/loops/loop-briefing-stage', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/components/loops/loop-briefing-stage')>()),
	LoopBriefingStage: ({ fileId, hideTitle }: { fileId: string; hideTitle?: boolean }) => (
		<div data-testid="stage" data-hide-title={hideTitle ? 'yes' : 'no'}>
			{fileId}
		</div>
	),
}))

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
		files.byId = {}
	})

	it('shows a deck in the tall viewer, under the view name, not in the frame', () => {
		files.byId = {
			deck: {
				id: 'deck',
				name: 'Briefing.html',
				mimeType: 'text/html',
				kind: 'briefing',
				encoding: 'utf8',
				content: '<html></html>',
			},
		}
		render(<LoopViewTab workspaceId="w" loopId="l" fileId="deck" name="Briefing" />)
		expect(screen.getByRole('heading', { name: 'Briefing' })).toBeInTheDocument()
		expect(screen.getByTestId('stage')).toHaveAttribute('data-hide-title', 'yes')
		expect(screen.queryByTestId('view')).toBeNull()
	})

	it('keeps a list view in the self-sizing frame', () => {
		files.byId = {
			good: {
				id: 'good',
				name: 'Results.html',
				mimeType: 'text/html',
				kind: null,
				encoding: 'utf8',
				content: '<html><body><p>Results</p></body></html>',
			},
		}
		render(<LoopViewTab workspaceId="w" loopId="l" fileId="good" />)
		expect(screen.getByTestId('view')).toBeInTheDocument()
		expect(screen.queryByTestId('stage')).toBeNull()
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

	it('offers rename and remove from the ··· menu', async () => {
		const onRename = vi.fn()
		const onRemove = vi.fn()
		const user = userEvent.setup()
		render(
			<LoopViewTab
				workspaceId="w"
				loopId="l"
				fileId="good"
				name="Results"
				onRename={onRename}
				onRemove={onRemove}
			/>,
		)
		await user.click(screen.getByRole('button', { name: 'View actions' }))
		await user.click(await screen.findByRole('menuitem', { name: /Rename/ }))
		const input = screen.getByLabelText('View name')
		await user.clear(input)
		await user.type(input, 'Scorecard')
		await user.click(screen.getByRole('button', { name: 'Save' }))
		expect(onRename).toHaveBeenCalledWith('Scorecard')

		await user.click(screen.getByRole('button', { name: 'View actions' }))
		await user.click(await screen.findByRole('menuitem', { name: /Remove view/ }))
		expect(onRemove).toHaveBeenCalled()
	})

	it('shows no menu for a view the flow does not own', () => {
		render(<LoopViewTab workspaceId="w" loopId="l" fileId="good" name="Briefings" />)
		expect(screen.queryByRole('button', { name: 'View actions' })).not.toBeInTheDocument()
	})
})
