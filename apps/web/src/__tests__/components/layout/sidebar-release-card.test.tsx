import { SidebarReleaseCard } from '@/components/layout/sidebar-release-card'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// An in-memory localStorage keeps the card's real dismissal path under test —
// jsdom's own storage is shared across files and Node's bare global is unusable.
beforeEach(() => {
	const store = new Map<string, string>()
	vi.stubGlobal('localStorage', {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => {
			store.set(k, v)
		},
		removeItem: (k: string) => {
			store.delete(k)
		},
		clear: () => store.clear(),
	})
})

describe('SidebarReleaseCard', () => {
	it('renders the current release note with its NEW label', () => {
		render(<SidebarReleaseCard />)
		expect(screen.getByTestId('sidebar-release-card')).toBeInTheDocument()
		expect(screen.getByText('Version 2.32 is live')).toBeInTheDocument()
		expect(screen.getByText('New')).toBeInTheDocument()
	})

	it('omits the "What\'s new" link when the release carries no href', () => {
		render(<SidebarReleaseCard />)
		expect(screen.queryByRole('link')).not.toBeInTheDocument()
	})

	it('disappears when dismissed', () => {
		render(<SidebarReleaseCard />)
		fireEvent.click(screen.getByLabelText('Dismiss release note'))
		expect(screen.queryByTestId('sidebar-release-card')).not.toBeInTheDocument()
	})

	it('stays hidden on a fresh mount once that version was dismissed', () => {
		const first = render(<SidebarReleaseCard />)
		fireEvent.click(screen.getByLabelText('Dismiss release note'))
		first.unmount()
		render(<SidebarReleaseCard />)
		expect(screen.queryByTestId('sidebar-release-card')).not.toBeInTheDocument()
	})

	it('reappears for a version that was never dismissed', () => {
		const first = render(<SidebarReleaseCard />)
		fireEvent.click(screen.getByLabelText('Dismiss release note'))
		first.unmount()
		localStorage.clear()
		render(<SidebarReleaseCard />)
		expect(screen.getByTestId('sidebar-release-card')).toBeInTheDocument()
	})

	it('hides in icon-collapsed mode', () => {
		render(<SidebarReleaseCard />)
		expect(screen.getByTestId('sidebar-release-card').className).toContain(
			'group-data-[collapsible=icon]:hidden',
		)
	})
})
