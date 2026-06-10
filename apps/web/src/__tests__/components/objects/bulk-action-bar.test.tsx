import { BulkActionBar } from '@/components/objects/bulk-action-bar'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const statusOptions = [
	{ value: 'todo', label: 'Todo' },
	{ value: 'in_progress', label: 'In progress' },
	{ value: 'done', label: 'Done' },
]

const ownerOptions = [
	{ id: 'actor-1', name: 'Alice' },
	{ id: 'actor-2', name: 'Bob' },
]

function setMatchMedia(prefersReduced = false) {
	const mql = {
		matches: prefersReduced,
		media: '(prefers-reduced-motion: reduce)',
		onchange: null,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		addListener: vi.fn(),
		removeListener: vi.fn(),
		dispatchEvent: vi.fn(),
	}
	vi.stubGlobal('matchMedia', vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia)
	return mql
}

function renderBar(overrides: Partial<React.ComponentProps<typeof BulkActionBar>> = {}) {
	const props: React.ComponentProps<typeof BulkActionBar> = {
		selectedCount: 3,
		statusOptions,
		ownerOptions,
		onStatusChange: vi.fn(),
		onOwnerChange: vi.fn(),
		onDelete: vi.fn(),
		onClear: vi.fn(),
		...overrides,
	}
	return { ...render(<BulkActionBar {...props} />), props }
}

describe('BulkActionBar', () => {
	beforeEach(() => {
		setMatchMedia(false)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it('is hidden when selectedCount is 0', () => {
		renderBar({ selectedCount: 0 })
		const bar = screen.getByRole('region', { hidden: true })
		expect(bar).toHaveAttribute('aria-label', 'Bulk actions')
		expect(bar).toHaveAttribute('aria-hidden', 'true')
		expect(bar).toHaveAttribute('inert')
		expect(bar.className).toMatch(/opacity-0/)
	})

	it('is visible when selectedCount is ≥ 1', () => {
		renderBar({ selectedCount: 1 })
		const bar = screen.getByRole('region', { name: 'Bulk actions' })
		expect(bar).toHaveAttribute('aria-hidden', 'false')
		expect(bar).not.toHaveAttribute('inert')
		expect(within(bar).getByLabelText('1 selected')).toHaveTextContent('1')
	})

	it('uses a horizontally scrollable mobile layout and hides selected copy below sm', () => {
		renderBar()
		const bar = screen.getByRole('region', { name: 'Bulk actions' })
		expect(bar.className).toMatch(/overflow-x-auto/)
		expect(bar.className).toMatch(/rounded-md/)
		expect(bar.className).toMatch(/bg-white/)
		expect(within(bar).getByText('selected').className).toMatch(/hidden/)
		expect(within(bar).getByText('selected').className).toMatch(/sm:inline/)
		expect(within(bar).getByLabelText('3 selected').className).toMatch(/shrink-0/)
	})

	it('renders status and owner selects with provided options', () => {
		renderBar()
		expect(screen.getByRole('combobox', { name: 'Set status' })).not.toBeDisabled()
		expect(screen.getByRole('combobox', { name: 'Set owner' })).not.toBeDisabled()
	})

	it('fires onStatusChange when a status option is picked', () => {
		const { props } = renderBar()
		fireEvent.click(screen.getByRole('combobox', { name: 'Set status' }))
		fireEvent.click(screen.getByRole('option', { name: 'Done' }))
		expect(props.onStatusChange).toHaveBeenCalledWith('done')
	})

	it('fires onOwnerChange when an owner option is picked', () => {
		const { props } = renderBar()
		fireEvent.click(screen.getByRole('combobox', { name: 'Set owner' }))
		fireEvent.click(screen.getByRole('option', { name: 'Alice' }))
		expect(props.onOwnerChange).toHaveBeenCalledWith('actor-1')
	})

	it('fires onClear when the X button is clicked', () => {
		const { props } = renderBar()
		fireEvent.click(screen.getByRole('button', { name: 'Clear selection' }))
		expect(props.onClear).toHaveBeenCalledTimes(1)
	})

	it('opens a confirm dialog when Delete is clicked and does not call onDelete yet', () => {
		const { props } = renderBar()
		fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
		const dialog = screen.getByRole('dialog')
		expect(within(dialog).getByText(/Delete 3 selected\?/i)).toBeInTheDocument()
		expect(props.onDelete).not.toHaveBeenCalled()
	})

	it('fires onDelete only after confirming in the dialog', () => {
		const { props } = renderBar()
		fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
		const dialog = screen.getByRole('dialog')
		fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
		expect(props.onDelete).toHaveBeenCalledTimes(1)
	})

	it('does not call onDelete when the user cancels the confirm dialog', () => {
		const { props } = renderBar()
		fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
		fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
		expect(props.onDelete).not.toHaveBeenCalled()
	})

	it('calls onClear when ESC is pressed', () => {
		const { props } = renderBar()
		act(() => {
			fireEvent.keyDown(window, { key: 'Escape' })
		})
		expect(props.onClear).toHaveBeenCalledTimes(1)
	})

	it('does not call onClear on ESC while the confirm dialog is open', () => {
		const { props } = renderBar()
		fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
		act(() => {
			fireEvent.keyDown(window, { key: 'Escape' })
		})
		expect(props.onClear).not.toHaveBeenCalled()
	})

	it('disables the transition classes when prefers-reduced-motion is set', () => {
		setMatchMedia(true)
		renderBar()
		const bar = screen.getByRole('region', { name: 'Bulk actions' })
		expect(bar.className).not.toMatch(/transition-all/)
	})

	it('does not render a delete button when onDelete is not provided', () => {
		renderBar({ onDelete: undefined })
		expect(screen.queryByRole('button', { name: 'Delete selected' })).toBeNull()
	})

	it('does not render copy/open buttons when their handlers are not provided', () => {
		renderBar()
		expect(screen.queryByRole('button', { name: /Copy links?/ })).toBeNull()
		expect(screen.queryByRole('button', { name: /Copy titles?$/ })).toBeNull()
		expect(screen.queryByRole('button', { name: /Copy titles? as links?/ })).toBeNull()
		expect(screen.queryByRole('button', { name: /Open in new tabs?/ })).toBeNull()
	})

	it('fires onCopyLink, onCopyTitle, onCopyTitleAsLink, and onOpenLinks when their buttons are clicked', () => {
		const onCopyLink = vi.fn()
		const onCopyTitle = vi.fn()
		const onCopyTitleAsLink = vi.fn()
		const onOpenLinks = vi.fn()
		renderBar({ onCopyLink, onCopyTitle, onCopyTitleAsLink, onOpenLinks })
		// selectedCount=3 by default → plural labels
		fireEvent.click(screen.getByRole('button', { name: 'Copy links' }))
		fireEvent.click(screen.getByRole('button', { name: 'Copy titles' }))
		fireEvent.click(screen.getByRole('button', { name: 'Copy titles as links' }))
		fireEvent.click(screen.getByRole('button', { name: 'Open in new tabs' }))
		expect(onCopyLink).toHaveBeenCalledTimes(1)
		expect(onCopyTitle).toHaveBeenCalledTimes(1)
		expect(onCopyTitleAsLink).toHaveBeenCalledTimes(1)
		expect(onOpenLinks).toHaveBeenCalledTimes(1)
	})

	it('uses singular labels when exactly one row is selected', () => {
		renderBar({
			selectedCount: 1,
			onCopyLink: vi.fn(),
			onCopyTitle: vi.fn(),
			onCopyTitleAsLink: vi.fn(),
			onOpenLinks: vi.fn(),
		})
		expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Copy title' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Copy title as link' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Open in new tab' })).toBeInTheDocument()
	})

	it('does not render the status select when no statusOptions are provided', () => {
		renderBar({ statusOptions: [] })
		expect(screen.queryByRole('combobox', { name: 'Set status' })).toBeNull()
	})

	it('does not render the status select when onStatusChange is omitted', () => {
		renderBar({ onStatusChange: undefined })
		expect(screen.queryByRole('combobox', { name: 'Set status' })).toBeNull()
	})
})
