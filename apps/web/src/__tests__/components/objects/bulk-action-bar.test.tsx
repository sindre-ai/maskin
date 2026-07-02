import { BulkActionBar } from '@/components/objects/bulk-action-bar'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/analytics', async () => {
	const actual = await vi.importActual<typeof import('@/lib/analytics')>('@/lib/analytics')
	return {
		...actual,
		trackBulkEditCommit: vi.fn(),
	}
})

import { trackBulkEditCommit } from '@/lib/analytics'

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

// Stash navigator descriptors per-test so the iOS UA stub doesn't bleed across
// describes (jsdom shares one navigator across the suite).
let savedUserAgent: PropertyDescriptor | undefined
let savedPlatform: PropertyDescriptor | undefined
let savedMaxTouchPoints: PropertyDescriptor | undefined

function stubNavigator(partial: {
	userAgent?: string
	platform?: string
	maxTouchPoints?: number
}) {
	if (partial.userAgent !== undefined) {
		Object.defineProperty(window.navigator, 'userAgent', {
			value: partial.userAgent,
			configurable: true,
		})
	}
	if (partial.platform !== undefined) {
		Object.defineProperty(window.navigator, 'platform', {
			value: partial.platform,
			configurable: true,
		})
	}
	if (partial.maxTouchPoints !== undefined) {
		Object.defineProperty(window.navigator, 'maxTouchPoints', {
			value: partial.maxTouchPoints,
			configurable: true,
		})
	}
}

describe('BulkActionBar', () => {
	beforeEach(() => {
		setMatchMedia(false)
		vi.mocked(trackBulkEditCommit).mockClear()
		savedUserAgent = Object.getOwnPropertyDescriptor(window.navigator, 'userAgent')
		savedPlatform = Object.getOwnPropertyDescriptor(window.navigator, 'platform')
		savedMaxTouchPoints = Object.getOwnPropertyDescriptor(window.navigator, 'maxTouchPoints')
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
		if (savedUserAgent) Object.defineProperty(window.navigator, 'userAgent', savedUserAgent)
		if (savedPlatform) Object.defineProperty(window.navigator, 'platform', savedPlatform)
		if (savedMaxTouchPoints)
			Object.defineProperty(window.navigator, 'maxTouchPoints', savedMaxTouchPoints)
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

	describe('bulk_edit_commit emitter (T4)', () => {
		// The ship metric is `avg(selected_count)` filtered to `platform_device=ios`.
		// Every commit path the bar triggers must fire trackBulkEditCommit exactly
		// once with the live selectedCount and the resolved platform_device.
		it('emits once with action=status_change and the current selectedCount on a status pick', () => {
			renderBar({ selectedCount: 4 })
			fireEvent.click(screen.getByRole('combobox', { name: 'Set status' }))
			fireEvent.click(screen.getByRole('option', { name: 'Done' }))
			expect(trackBulkEditCommit).toHaveBeenCalledTimes(1)
			expect(trackBulkEditCommit).toHaveBeenCalledWith({
				selected_count: 4,
				action: 'status_change',
				platform_device: 'desktop',
			})
		})

		it('emits once with action=owner_change on an owner pick', () => {
			renderBar({ selectedCount: 2 })
			fireEvent.click(screen.getByRole('combobox', { name: 'Set owner' }))
			fireEvent.click(screen.getByRole('option', { name: 'Bob' }))
			expect(trackBulkEditCommit).toHaveBeenCalledTimes(1)
			expect(trackBulkEditCommit).toHaveBeenCalledWith({
				selected_count: 2,
				action: 'owner_change',
				platform_device: 'desktop',
			})
		})

		it('emits action=copy for each of the four copy/open buttons', () => {
			renderBar({
				selectedCount: 3,
				onCopyLink: vi.fn(),
				onCopyTitle: vi.fn(),
				onCopyTitleAsLink: vi.fn(),
				onOpenLinks: vi.fn(),
			})
			fireEvent.click(screen.getByRole('button', { name: 'Copy links' }))
			fireEvent.click(screen.getByRole('button', { name: 'Copy titles' }))
			fireEvent.click(screen.getByRole('button', { name: 'Copy titles as links' }))
			fireEvent.click(screen.getByRole('button', { name: 'Open in new tabs' }))
			expect(trackBulkEditCommit).toHaveBeenCalledTimes(4)
			for (const call of vi.mocked(trackBulkEditCommit).mock.calls) {
				expect(call[0]).toEqual({
					selected_count: 3,
					action: 'copy',
					platform_device: 'desktop',
				})
			}
		})

		it('emits action=delete only after the confirm dialog is confirmed', () => {
			renderBar({ selectedCount: 5 })
			fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
			// Opening the dialog must not fire the event yet — Trash2 click is intent,
			// the dialog's Delete button is the commit.
			expect(trackBulkEditCommit).not.toHaveBeenCalled()
			fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
			expect(trackBulkEditCommit).toHaveBeenCalledTimes(1)
			expect(trackBulkEditCommit).toHaveBeenCalledWith({
				selected_count: 5,
				action: 'delete',
				platform_device: 'desktop',
			})
		})

		it('does NOT fire on delete when the user cancels the confirm dialog', () => {
			renderBar({ selectedCount: 5 })
			fireEvent.click(screen.getByRole('button', { name: 'Delete selected' }))
			fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
			expect(trackBulkEditCommit).not.toHaveBeenCalled()
		})

		// DoD: "the iOS branch must be tested explicitly — a green suite that never
		// enters the iOS branch is a failing DoD." Stub navigator.userAgent to an
		// iPhone string so resolvePlatformDevice walks its first branch.
		it('sets platform_device=ios when navigator.userAgent reports an iPhone', () => {
			stubNavigator({
				userAgent:
					'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
				platform: 'iPhone',
				maxTouchPoints: 5,
			})
			renderBar({ selectedCount: 6 })
			fireEvent.click(screen.getByRole('combobox', { name: 'Set status' }))
			fireEvent.click(screen.getByRole('option', { name: 'Done' }))
			expect(trackBulkEditCommit).toHaveBeenCalledWith({
				selected_count: 6,
				action: 'status_change',
				platform_device: 'ios',
			})
		})

		// iPadOS 13+ reports a Mac UA — covered by the second branch of
		// resolvePlatformDevice via maxTouchPoints.
		it('sets platform_device=ios on iPadOS 13+ (Mac UA + touch + mobile viewport)', () => {
			Object.defineProperty(window, 'innerWidth', { value: 700, configurable: true })
			stubNavigator({
				userAgent:
					'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
				platform: 'MacIntel',
				maxTouchPoints: 5,
			})
			renderBar({ selectedCount: 1 })
			fireEvent.click(screen.getByRole('combobox', { name: 'Set status' }))
			fireEvent.click(screen.getByRole('option', { name: 'Done' }))
			const last = vi.mocked(trackBulkEditCommit).mock.calls.at(-1)?.[0]
			expect(last?.platform_device).toBe('ios')
		})

		it('sets platform_device=android on an Android UA', () => {
			stubNavigator({
				userAgent:
					'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
				platform: 'Linux armv8l',
				maxTouchPoints: 5,
			})
			renderBar({ selectedCount: 1 })
			fireEvent.click(screen.getByRole('combobox', { name: 'Set status' }))
			fireEvent.click(screen.getByRole('option', { name: 'Done' }))
			expect(trackBulkEditCommit).toHaveBeenCalledWith(
				expect.objectContaining({ platform_device: 'android' }),
			)
		})
	})
})
