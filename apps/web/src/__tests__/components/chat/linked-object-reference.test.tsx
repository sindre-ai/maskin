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

import { ObjectReferenceCard, ObjectReferenceChip } from '@/components/chat/linked-object-reference'

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

// The round marks inside the chip's link: the type dot, then the status dot when there is one.
const chipDots = () =>
	Array.from(screen.getByRole('link').querySelectorAll<HTMLElement>('span.rounded-full'))

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

describe('ObjectReferenceChip plate', () => {
	beforeEach(() => useObject.mockReset())

	it('shows the part of the title before a long dash and keeps the full title in the name', () => {
		useObject.mockReturnValue({
			data: objectRow({ title: 'David Harboe \u2014 Norlix (CTO & Co-founder)' }),
			isLoading: false,
		})
		renderChip()
		const link = screen.getByRole('link', { name: /^Bet, Active: David Harboe \u2014 Norlix/ })
		expect(link).toHaveTextContent('David Harboe')
		expect(link).not.toHaveTextContent('Norlix')
	})

	it('cuts a title over 90 characters with an ellipsis and keeps the full title in the name', () => {
		const title = `${'word '.repeat(30)}end`
		useObject.mockReturnValue({ data: objectRow({ title }), isLoading: false })
		renderChip()
		const link = screen.getByRole('link', { name: `Bet, Active: ${title}, Developer` })
		expect(link.textContent).toMatch(/word…$/)
		expect(link.textContent?.length).toBeLessThan(95)
	})

	it('ends with a status dot in the status colour that assistive tech skips', () => {
		useObject.mockReturnValue({ data: objectRow({ status: 'blocked' }), isLoading: false })
		renderChip()
		const dots = chipDots()
		expect(dots).toHaveLength(2)
		expect(dots[1]).toHaveAttribute('aria-hidden', 'true')
		expect(dots[1].className).toContain('text-status-blocked-text')
	})

	it('draws no status dot for an object with no status', () => {
		useObject.mockReturnValue({ data: objectRow({ status: '' }), isLoading: false })
		renderChip()
		expect(chipDots()).toHaveLength(1)
	})

	it('has no status word and no owner avatar', () => {
		useObject.mockReturnValue({ data: objectRow(), isLoading: false })
		renderChip()
		const link = screen.getByRole('link', { name: /Bet, Active/ })
		expect(link).toHaveTextContent(/^\u2060?Chat preview cards\u2060?$/)
		expect(link.querySelector('img, [data-slot="avatar"]')).toBeNull()
	})

	it('draws the loading chip in the same plate with the original link text and a pulsing dot', () => {
		useObject.mockReturnValue({ data: undefined, isLoading: true })
		renderChip()
		const link = screen.getByText('the original link').closest('a')
		expect(link).toHaveAttribute('href', '/original')
		expect(link?.className).toContain('bg-muted')
		expect(link?.querySelector('[aria-hidden="true"]')?.className).toContain('animate-pulse')
	})

	it('draws the deleted chip with a dashed border at the sentence size', () => {
		useObject.mockReturnValue({ data: undefined, isLoading: false })
		renderChip()
		const chip = screen.getByText('Deleted object')
		expect(chip.className).toContain('border-dashed')
		expect(chip.className).not.toMatch(/text-\[/)
	})
})

describe('ObjectReferenceCard fold', () => {
	beforeEach(() => useObject.mockReset())
	const renderCard = () => render(<ObjectReferenceCard workspaceId={WS} objectId={ID} />)
	const card = () => document.querySelector('[data-linked-card]') as HTMLElement

	it('starts open, with the fold button beside the link and not inside it', () => {
		useObject.mockReturnValue({ data: objectRow(), isLoading: false })
		renderCard()
		const button = screen.getByRole('button', { name: 'Fold card' })
		expect(button).toHaveAttribute('aria-expanded', 'true')
		expect(button.closest('a')).toBeNull()
		expect(card().contains(screen.getByRole('link'))).toBe(true)
		expect(screen.getAllByRole('link')).toHaveLength(1)
	})

	it('folds to one row that unfolds again, and keeps focus on its button', async () => {
		const user = userEvent.setup()
		useObject.mockReturnValue({ data: objectRow(), isLoading: false })
		renderCard()
		await user.click(screen.getByRole('button', { name: 'Fold card' }))
		const row = screen.getByRole('button', { name: 'Unfold card: Chat preview cards' })
		expect(row).toHaveAttribute('aria-expanded', 'false')
		expect(screen.queryByRole('link')).toBeNull()
		expect(row).toHaveTextContent('Chat preview cards')
		expect(row).toHaveFocus()
		await user.click(row)
		expect(screen.getByRole('button', { name: 'Fold card' })).toHaveFocus()
		expect(screen.getByRole('link')).toBeInTheDocument()
	})

	it('folds and unfolds from the keyboard with Enter and Space', async () => {
		const user = userEvent.setup()
		useObject.mockReturnValue({ data: objectRow(), isLoading: false })
		renderCard()
		await user.tab()
		expect(screen.getByRole('link')).toHaveFocus()
		await user.tab()
		expect(screen.getByRole('button', { name: 'Fold card' })).toHaveFocus()
		await user.keyboard('{Enter}')
		expect(screen.getByRole('button', { name: /^Unfold card/ })).toHaveFocus()
		await user.keyboard(' ')
		expect(screen.getByRole('button', { name: 'Fold card' })).toHaveFocus()
	})

	it('does not navigate or open the card when the fold button is clicked', async () => {
		const user = userEvent.setup()
		const onClick = vi.fn()
		useObject.mockReturnValue({ data: objectRow(), isLoading: false })
		renderCard()
		const link = screen.getByRole('link')
		link.addEventListener('click', onClick)
		await user.click(screen.getByRole('button', { name: 'Fold card' }))
		expect(onClick).not.toHaveBeenCalled()
	})

	it('keeps one marker on the card for every state of it', async () => {
		const user = userEvent.setup()
		useObject.mockReturnValue({ data: objectRow(), isLoading: false })
		renderCard()
		expect(document.querySelectorAll('[data-linked-card]')).toHaveLength(1)
		await user.click(screen.getByRole('button', { name: 'Fold card' }))
		expect(document.querySelectorAll('[data-linked-card]')).toHaveLength(1)
	})

	it('has no fold button on the loading card or the deleted card', () => {
		useObject.mockReturnValue({ data: undefined, isLoading: true })
		const { unmount } = renderCard()
		expect(screen.queryByRole('button')).toBeNull()
		unmount()
		useObject.mockReturnValue({ data: undefined, isLoading: false })
		renderCard()
		expect(screen.queryByRole('button')).toBeNull()
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
