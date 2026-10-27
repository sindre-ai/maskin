import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const useObject = vi.fn()

vi.mock('@/hooks/use-objects', () => ({ useObject: (id: string) => useObject(id) }))
vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [{ id: 'actor-1', name: 'Developer', type: 'agent' }] }),
}))
vi.mock('@/hooks/use-object-type-label', () => ({
	useObjectTypeLabel: () => (type: string) => type.charAt(0).toUpperCase() + type.slice(1),
}))
vi.mock('@tanstack/react-router', () => ({
	Link: ({
		children,
		className,
		...rest
	}: { children: React.ReactNode; className?: string } & Record<string, unknown>) => (
		<a
			href="/x"
			className={className}
			aria-label={rest['aria-label'] as string | undefined}
			tabIndex={rest.tabIndex as number | undefined}
		>
			{children}
		</a>
	),
}))

import { ObjectReferenceChip } from '@/components/chat/linked-object-reference'

const WS = 'ws-1'
const ID = 'a7167fde-3f84-42ce-800d-2ba2362944ea'
const fallback = <a href="/original">the original link</a>

function objectRow(overrides: Record<string, unknown> = {}) {
	return {
		id: ID,
		workspaceId: WS,
		type: 'bet',
		status: 'active',
		title: 'Chat preview cards',
		content: 'Text',
		driver: 'actor-1',
		...overrides,
	}
}

const renderChip = () =>
	render(<ObjectReferenceChip workspaceId={WS} objectId={ID} fallback={fallback} />)

describe('ObjectReferenceChip', () => {
	beforeEach(() => useObject.mockReset())

	it('keeps the original link while the object loads', () => {
		useObject.mockReturnValue({ data: undefined, isLoading: true })
		renderChip()
		expect(screen.getByText('the original link')).toBeInTheDocument()
	})

	it('reads type, status, title and owner as one link', () => {
		useObject.mockReturnValue({ data: objectRow(), isLoading: false })
		renderChip()
		expect(
			screen.getByRole('link', { name: 'Bet, Active: Chat preview cards, Developer' }),
		).toBeInTheDocument()
		expect(screen.queryByText('the original link')).not.toBeInTheDocument()
	})

	it('leaves the owner out of the name when nobody has the object', () => {
		useObject.mockReturnValue({ data: objectRow({ driver: null }), isLoading: false })
		renderChip()
		expect(
			screen.getByRole('link', { name: 'Bet, Active: Chat preview cards' }),
		).toBeInTheDocument()
	})

	it('says Deleted object when the object is missing or in another workspace', () => {
		for (const data of [undefined, objectRow({ workspaceId: 'other' })]) {
			useObject.mockReturnValue({ data, isLoading: false })
			const { unmount } = renderChip()
			expect(screen.getByText('Deleted object')).toBeInTheDocument()
			unmount()
		}
	})
})

describe('ObjectReferenceChip preview', () => {
	const realMatchMedia = window.matchMedia
	const setPointerDesktop = (matches: boolean) => {
		window.matchMedia = ((query: string) => ({
			matches,
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		})) as unknown as typeof window.matchMedia
	}
	const chip = () => screen.getByRole('link', { name: /Bet, Active: Chat preview cards/ })
	const preview = () => document.querySelector('[data-linked-preview]')

	beforeEach(() => {
		useObject.mockReset()
		useObject.mockReturnValue({ data: objectRow(), isLoading: false })
		setPointerDesktop(true)
	})
	afterEach(() => {
		window.matchMedia = realMatchMedia
	})

	it('opens the card under the chip on hover and closes it on leave', async () => {
		const user = userEvent.setup()
		renderChip()
		expect(preview()).toBeNull()
		await user.hover(chip())
		expect(preview()).not.toBeNull()
		expect(preview()?.textContent).toContain('Chat preview cards')
		await user.unhover(chip())
		expect(preview()).toBeNull()
	})

	it('opens on keyboard focus and closes on blur', async () => {
		const user = userEvent.setup()
		renderChip()
		await user.tab()
		expect(chip()).toHaveFocus()
		expect(preview()).not.toBeNull()
		await user.tab()
		expect(preview()).toBeNull()
	})

	it('closes on Escape', async () => {
		const user = userEvent.setup()
		renderChip()
		await user.hover(chip())
		expect(preview()).not.toBeNull()
		await user.keyboard('{Escape}')
		expect(preview()).toBeNull()
	})

	it('is hidden from assistive tech and is not a second tab stop', async () => {
		const user = userEvent.setup()
		renderChip()
		await user.hover(chip())
		expect(preview()).toHaveAttribute('aria-hidden', 'true')
		expect(screen.getAllByRole('link')).toHaveLength(1)
		expect(preview()?.querySelector('a')).toHaveAttribute('tabindex', '-1')
	})

	it('shows the card skeleton while the object loads', () => {
		useObject.mockReturnValue({ data: undefined, isLoading: true })
		renderChip()
		fireEvent.mouseEnter(screen.getByText('the original link').parentElement as HTMLElement)
		expect(preview()?.querySelector('[aria-busy="true"]')).not.toBeNull()
	})

	it('opens nothing below 640px or on touch', async () => {
		setPointerDesktop(false)
		const user = userEvent.setup()
		renderChip()
		await user.hover(chip())
		await user.tab()
		expect(preview()).toBeNull()
	})

	it('has no preview for a deleted object', () => {
		useObject.mockReturnValue({ data: undefined, isLoading: false })
		renderChip()
		act(() => {
			fireEvent.mouseEnter(screen.getByText('Deleted object'))
		})
		expect(preview()).toBeNull()
	})
})
