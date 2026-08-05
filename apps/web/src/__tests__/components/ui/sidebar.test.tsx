import {
	Sidebar,
	SidebarProvider,
	SidebarRightProvider,
	SidebarTrigger,
	useSidebar,
	useSidebarRight,
} from '@/components/ui/sidebar'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => false,
}))

function LeftStatePeek() {
	const { open } = useSidebar()
	return <span data-testid="left-state">{open ? 'open' : 'closed'}</span>
}

function RightStatePeek() {
	const { open } = useSidebarRight()
	return <span data-testid="right-state">{open ? 'open' : 'closed'}</span>
}

function fireCmd(key: string, extra: Partial<KeyboardEventInit> = {}) {
	act(() => {
		fireEvent.keyDown(window, { key, metaKey: true, ...extra })
	})
}

describe('SidebarProvider + SidebarRightProvider — dual-instance shortcut wiring', () => {
	it('⌘B toggles only the left instance', () => {
		render(
			<SidebarProvider defaultOpen={true}>
				<LeftStatePeek />
				<SidebarRightProvider defaultOpen={false}>
					<RightStatePeek />
				</SidebarRightProvider>
			</SidebarProvider>,
		)

		expect(screen.getByTestId('left-state').textContent).toBe('open')
		expect(screen.getByTestId('right-state').textContent).toBe('closed')

		fireCmd('b')

		expect(screen.getByTestId('left-state').textContent).toBe('closed')
		expect(screen.getByTestId('right-state').textContent).toBe('closed')
	})

	it('⌘I toggles only the right instance', () => {
		render(
			<SidebarProvider defaultOpen={true}>
				<LeftStatePeek />
				<SidebarRightProvider defaultOpen={false}>
					<RightStatePeek />
				</SidebarRightProvider>
			</SidebarProvider>,
		)

		fireCmd('i')

		expect(screen.getByTestId('left-state').textContent).toBe('open')
		expect(screen.getByTestId('right-state').textContent).toBe('open')
	})

	it('Ctrl+I toggles the right instance (Windows/Linux)', () => {
		render(
			<SidebarRightProvider defaultOpen={false}>
				<RightStatePeek />
			</SidebarRightProvider>,
		)

		act(() => {
			fireEvent.keyDown(window, { key: 'i', ctrlKey: true })
		})

		expect(screen.getByTestId('right-state').textContent).toBe('open')
	})

	it('does not fire on ⌘⇧I — leaves inspect-element chord alone', () => {
		render(
			<SidebarRightProvider defaultOpen={false}>
				<RightStatePeek />
			</SidebarRightProvider>,
		)

		fireCmd('I', { shiftKey: true })

		expect(screen.getByTestId('right-state').textContent).toBe('closed')
	})
})

describe('SidebarRightProvider — controlled vs uncontrolled', () => {
	it('falls back to internal state when no controlled props are passed', () => {
		render(
			<SidebarRightProvider defaultOpen={false}>
				<RightStatePeek />
			</SidebarRightProvider>,
		)

		expect(screen.getByTestId('right-state').textContent).toBe('closed')
		fireCmd('i')
		expect(screen.getByTestId('right-state').textContent).toBe('open')
	})

	it('mirrors external `open` and calls `onOpenChange` on toggle without writing internal state', () => {
		const onOpenChange = vi.fn()

		function Host() {
			const [open, setOpen] = useState(false)
			return (
				<SidebarRightProvider
					open={open}
					onOpenChange={(next) => {
						onOpenChange(next)
						setOpen(next)
					}}
				>
					<RightStatePeek />
				</SidebarRightProvider>
			)
		}

		render(<Host />)

		expect(screen.getByTestId('right-state').textContent).toBe('closed')
		fireCmd('i')
		expect(onOpenChange).toHaveBeenCalledWith(true)
		expect(screen.getByTestId('right-state').textContent).toBe('open')

		fireCmd('i')
		expect(onOpenChange).toHaveBeenLastCalledWith(false)
		expect(screen.getByTestId('right-state').textContent).toBe('closed')
	})

	it('does not write a cookie for the right-side state (architecture decision)', () => {
		const originalCookie = document.cookie
		render(
			<SidebarRightProvider defaultOpen={false}>
				<RightStatePeek />
			</SidebarRightProvider>,
		)
		fireCmd('i')
		expect(document.cookie).toBe(originalCookie)
		expect(document.cookie).not.toContain('sidebar_state_right')
	})
})

describe('Sidebar component — side="right" routing', () => {
	function getSidebarWrapper(container: HTMLElement, side: 'left' | 'right') {
		return container.querySelector(`[data-side="${side}"]`)
	}

	it('renders and reads state from the right context when a SidebarRightProvider wraps it', () => {
		const { container } = render(
			<SidebarProvider defaultOpen={true}>
				<Sidebar side="left">
					<div>left content</div>
				</Sidebar>
				<SidebarRightProvider defaultOpen={true}>
					<Sidebar side="right">
						<div>right content</div>
					</Sidebar>
				</SidebarRightProvider>
			</SidebarProvider>,
		)

		expect(screen.getByText('left content')).toBeInTheDocument()
		expect(screen.getByText('right content')).toBeInTheDocument()

		const left = getSidebarWrapper(container, 'left')
		const right = getSidebarWrapper(container, 'right')
		expect(left?.getAttribute('data-state')).toBe('expanded')
		expect(right?.getAttribute('data-state')).toBe('expanded')
	})

	it('right sidebar toggles independently from the left via SidebarTrigger side="right"', () => {
		const { container } = render(
			<SidebarProvider defaultOpen={true}>
				<Sidebar side="left">
					<div>left</div>
				</Sidebar>
				<SidebarRightProvider defaultOpen={false}>
					<Sidebar side="right">
						<div>right</div>
					</Sidebar>
					<SidebarTrigger side="right" aria-label="toggle right" />
				</SidebarRightProvider>
			</SidebarProvider>,
		)

		expect(getSidebarWrapper(container, 'left')?.getAttribute('data-state')).toBe('expanded')
		expect(getSidebarWrapper(container, 'right')?.getAttribute('data-state')).toBe('collapsed')

		fireEvent.click(screen.getByRole('button', { name: 'toggle right' }))

		expect(getSidebarWrapper(container, 'left')?.getAttribute('data-state')).toBe('expanded')
		expect(getSidebarWrapper(container, 'right')?.getAttribute('data-state')).toBe('expanded')
	})

	it('falls back to left context when side="right" but no right provider is mounted', () => {
		// Preserves the ChatSidebarProvider fork's contract: it provides only the
		// left SidebarContext yet mounts <Sidebar side="right">.
		const { container } = render(
			<SidebarProvider defaultOpen={true}>
				<Sidebar side="right">
					<div>chat-style</div>
				</Sidebar>
			</SidebarProvider>,
		)

		expect(getSidebarWrapper(container, 'right')?.getAttribute('data-state')).toBe('expanded')
	})

	it('left-nav shortcut and existing single-instance API keep working when no right provider is mounted', () => {
		render(
			<SidebarProvider defaultOpen={true}>
				<LeftStatePeek />
			</SidebarProvider>,
		)

		expect(screen.getByTestId('left-state').textContent).toBe('open')
		fireCmd('b')
		expect(screen.getByTestId('left-state').textContent).toBe('closed')
	})
})
