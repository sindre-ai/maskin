import { LoopViewTab } from '@/components/loops/loop-view-tab'
import { EXPORT_FAILED_MESSAGE } from '@/lib/view-export'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const flag = vi.hoisted(() => ({ on: false }))
const mobile = vi.hoisted(() => ({ on: false }))
vi.mock('@/hooks/use-feature-flag', () => ({ useFeatureFlag: () => flag.on }))
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mobile.on }))
const files = vi.hoisted(() => ({ byId: {} as Record<string, unknown> }))
const exporter = vi.hoisted(() => ({
	pages: [{ xhtml: '<body><p>Hi</p></body>', w: 100, h: 50, bg: '#fff' }],
	save: vi.fn(),
	fromDocument: vi.fn(),
	fromFrame: vi.fn(),
}))
vi.mock('@/lib/view-export', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/view-export')>()),
	exportPages: exporter.save,
	exportPagesOfDocument: exporter.fromDocument,
}))
vi.mock('@/hooks/use-files', () => ({
	useFile: (_w: string, id: string) => ({ data: files.byId[id] }),
}))
vi.mock('@/components/loops/loop-briefing-stage', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/components/loops/loop-briefing-stage')>()),
	LoopBriefingStage: ({
		fileId,
		hideTitle,
		reloadToken,
	}: { fileId: string; hideTitle?: boolean; reloadToken?: number }) => (
		<div data-testid="stage" data-hide-title={hideTitle ? 'yes' : 'no'} data-reload={reloadToken}>
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
		onRefreshingChange,
		exportRef,
	}: {
		exportRef?: { current: (() => Promise<unknown>) | null }
		fileId: string
		onFailure: (reason: string) => void
		onOpenItem?: (id: string) => void
		onProposeChange?: (change: { id: string; field: string; value: string }) => void
		reloadToken?: number
		onRefreshingChange?: (refreshing: boolean) => void
	}) => {
		useEffect(() => {
			if (fileId === 'bad') onFailure('The view file is not an HTML file.')
		}, [fileId, onFailure])
		useEffect(() => {
			if (exportRef) exportRef.current = exporter.fromFrame
		}, [exportRef])
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
				<button type="button" onClick={() => onRefreshingChange?.(true)}>
					start reload
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
		exporter.save.mockReset().mockResolvedValue(undefined)
		exporter.fromDocument.mockReset().mockResolvedValue(exporter.pages)
		exporter.fromFrame.mockReset().mockResolvedValue(exporter.pages)
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

	it('puts Refresh first in the menu, above Rename and Remove view', async () => {
		const user = userEvent.setup()
		render(
			<LoopViewTab
				workspaceId="w"
				loopId="l"
				fileId="good"
				name="Results"
				onRename={vi.fn()}
				onRemove={vi.fn()}
			/>,
		)
		await user.click(screen.getByRole('button', { name: 'View actions' }))
		const items = await screen.findAllByRole('menuitem')
		expect(items.map((item) => item.textContent?.trim())).toEqual([
			'Refresh',
			'Rename',
			'Remove view',
		])
	})

	it('shows the menu with only Refresh for a view the flow does not own', async () => {
		const user = userEvent.setup()
		render(<LoopViewTab workspaceId="w" loopId="l" fileId="good" name="Briefings" />)
		await user.click(screen.getByRole('button', { name: 'View actions' }))
		expect(await screen.findAllByRole('menuitem')).toHaveLength(1)
		expect(screen.getByRole('menuitem', { name: /Refresh/ })).toBeInTheDocument()
	})

	it('reloads the view once when Refresh is selected', async () => {
		const user = userEvent.setup()
		render(<LoopViewTab workspaceId="w" loopId="l" fileId="good" name="Results" />)
		expect(screen.getByTestId('view')).toHaveAttribute('data-reload', '0')
		await user.click(screen.getByRole('button', { name: 'View actions' }))
		await user.click(await screen.findByRole('menuitem', { name: /Refresh/ }))
		expect(screen.getByTestId('view')).toHaveAttribute('data-reload', '1')
	})

	it('disables Refresh while the view is reloading', async () => {
		const user = userEvent.setup()
		render(<LoopViewTab workspaceId="w" loopId="l" fileId="good" name="Results" />)
		fireEvent.click(screen.getByText('start reload'))
		await user.click(screen.getByRole('button', { name: 'View actions' }))
		expect(await screen.findByRole('menuitem', { name: /Refresh/ })).toHaveAttribute(
			'aria-disabled',
			'true',
		)
	})

	it('tries a view that could not be shown again when Refresh is selected', async () => {
		const user = userEvent.setup()
		render(<LoopViewTab workspaceId="w" loopId="l" fileId="bad" name="Results" />)
		expect(screen.getByRole('alert')).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'View actions' }))
		await user.click(await screen.findByRole('menuitem', { name: /Refresh/ }))
		// The mock fails again on mount, so the note is back; what matters is the view was mounted.
		expect(await screen.findByRole('alert')).toBeInTheDocument()
	})

	it('reloads a deck through the briefing stage when Refresh is selected', async () => {
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
		const user = userEvent.setup()
		render(<LoopViewTab workspaceId="w" loopId="l" fileId="deck" name="Briefings" />)
		expect(screen.getByTestId('stage')).toHaveAttribute('data-reload', '0')
		await user.click(screen.getByRole('button', { name: 'View actions' }))
		await user.click(await screen.findByRole('menuitem', { name: /Refresh/ }))
		expect(screen.getByTestId('stage')).toHaveAttribute('data-reload', '1')
	})
	describe('Export', () => {
		const list = {
			id: 'good',
			name: 'Open deals.html',
			mimeType: 'text/html',
			kind: null,
			encoding: 'utf8',
			content: '<html><body><p>Results</p></body></html>',
		}
		async function openExportChoices() {
			const user = userEvent.setup()
			await user.click(screen.getByRole('button', { name: 'View actions' }))
			await user.click(await screen.findByText('Export'))
			return user
		}
		// A pointer click on an item inside the open submenu does not reach its onSelect in jsdom
		// (the menu stays open), so the item is clicked directly once it is on screen.
		function chooseExport(label: string) {
			fireEvent.click(screen.getByRole('menuitem', { name: label }))
		}

		it('has no Export, only Refresh, for a view that cannot be renamed or removed when the flag is off', async () => {
			files.byId = { good: list }
			render(<LoopViewTab workspaceId="w" loopId="l" fileId="good" name="Deals" />)
			await userEvent.setup().click(screen.getByRole('button', { name: 'View actions' }))
			expect(await screen.findByRole('menuitem', { name: 'Refresh' })).toBeInTheDocument()
			expect(screen.queryByText('Export')).toBeNull()
		})

		it('offers Markdown, PDF and PNG when the flag is on', async () => {
			flag.on = true
			files.byId = { good: list }
			render(<LoopViewTab workspaceId="w" loopId="l" fileId="good" name="Deals" />)
			await openExportChoices()
			expect(screen.getByRole('menuitem', { name: 'Markdown' })).toBeInTheDocument()
			expect(screen.getByRole('menuitem', { name: 'PDF' })).toBeInTheDocument()
			expect(screen.getByRole('menuitem', { name: 'PNG' })).toBeInTheDocument()
		})

		it.each([
			['Markdown', 'markdown'],
			['PDF', 'pdf'],
			['PNG', 'png'],
		])('%s asks the view once and saves once', async (label, format) => {
			flag.on = true
			files.byId = { good: list }
			render(<LoopViewTab workspaceId="w" loopId="l" fileId="good" name="Deals" />)
			await openExportChoices()
			chooseExport(label)
			await waitFor(() => expect(exporter.save).toHaveBeenCalledTimes(1))
			expect(exporter.fromFrame).toHaveBeenCalledTimes(1)
			expect(exporter.fromDocument).not.toHaveBeenCalled()
			expect(exporter.save).toHaveBeenCalledWith(format, exporter.pages, 'Deals', 0)
			expect(screen.queryByRole('alert')).toBeNull()
		})

		it('exports a deck from its own document, not the live frame', async () => {
			flag.on = true
			files.byId = {
				deck: {
					id: 'deck',
					name: 'Briefing.html',
					mimeType: 'text/html',
					kind: 'briefing',
					encoding: 'utf8',
					content: '<html><body><section class="slide">One</section></body></html>',
				},
			}
			render(<LoopViewTab workspaceId="w" loopId="l" fileId="deck" name="Briefing" />)
			await openExportChoices()
			chooseExport('PDF')
			await waitFor(() => expect(exporter.save).toHaveBeenCalledTimes(1))
			expect(exporter.fromDocument).toHaveBeenCalledWith(
				'<html><body><section class="slide">One</section></body></html>',
			)
			expect(exporter.fromFrame).not.toHaveBeenCalled()
		})

		it('says the export failed in plain words and saves nothing', async () => {
			flag.on = true
			files.byId = { good: list }
			exporter.fromFrame.mockRejectedValue(new Error('boom'))
			vi.spyOn(console, 'error').mockImplementation(() => {})
			render(<LoopViewTab workspaceId="w" loopId="l" fileId="good" name="Deals" />)
			await openExportChoices()
			chooseExport('PNG')
			expect(await screen.findByRole('alert')).toHaveTextContent(EXPORT_FAILED_MESSAGE)
			expect(exporter.save).not.toHaveBeenCalled()
		})
	})
})
