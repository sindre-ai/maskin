import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const useObject = vi.fn()
const toast = vi.fn()
// The field list per type in the workspace schema, which the card reads its fact rows from.
let fieldDefinitions: Record<string, { name: string; type: string }[]> = {}

vi.mock('sonner', () => ({ toast: (...args: unknown[]) => toast(...args) }))
vi.mock('@/hooks/use-objects', () => ({ useObject: (id: string) => useObject(id) }))
vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [{ id: 'actor-1', name: 'Developer', type: 'agent' }] }),
}))
vi.mock('@/hooks/use-object-type-label', () => ({
	useObjectTypeLabel: () => (type: string) => type.charAt(0).toUpperCase() + type.slice(1),
}))
vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspace: { settings: { field_definitions: fieldDefinitions } } }),
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

// The round marks inside the chip's link: the status dot, when there is one. The type is an icon.
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
		expect(dots).toHaveLength(1)
		expect(dots[0]).toHaveAttribute('aria-hidden', 'true')
		expect(dots[0].className).toContain('text-status-blocked-text')
	})

	it('draws no status dot for an object with no status', () => {
		useObject.mockReturnValue({ data: objectRow({ status: '' }), isLoading: false })
		renderChip()
		expect(chipDots()).toHaveLength(0)
	})

	it('leads with a kind icon at 0.85em in the type colour, not a dot', () => {
		useObject.mockReturnValue({ data: objectRow(), isLoading: false })
		renderChip()
		const icon = screen.getByRole('link').querySelector('svg')
		expect(icon).toHaveAttribute('aria-hidden', 'true')
		expect(icon).toHaveAttribute('width', '0.85em')
		expect(icon?.getAttribute('class')).toContain('text-type-bet-text')
	})

	it('gives each built-in type its icon and a custom type the neutral tag', () => {
		const iconOf = (type: string) => {
			useObject.mockReturnValue({ data: objectRow({ type }), isLoading: false })
			const { unmount } = renderChip()
			const classes = screen.getByRole('link').querySelector('svg')?.getAttribute('class') ?? ''
			unmount()
			return classes
		}
		const icons = ['contact', 'company', 'insight', 'bet', 'task', 'file'].map(iconOf)
		expect(icons[0]).toContain('lucide-user')
		expect(icons[1]).toContain('lucide-building')
		expect(icons[2]).toContain('lucide-lightbulb')
		expect(icons[3]).toContain('lucide-target')
		expect(icons[4]).toContain('lucide-square-check')
		expect(icons[5]).toContain('lucide-file-text')
		const custom = iconOf('article')
		expect(custom).toContain('lucide-tag')
		expect(custom).toContain('text-muted-foreground')
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

	it('draws the deleted chip with a trash icon and a dashed border at the sentence size', () => {
		useObject.mockReturnValue({ data: undefined, isLoading: false })
		renderChip()
		const chip = screen.getByText('Deleted object')
		expect(chip.className).toContain('border-dashed')
		expect(chip.className).not.toMatch(/text-\[/)
		expect(chip.querySelector('svg')?.getAttribute('class')).toContain('lucide-trash')
	})
})

describe('ObjectReferenceCard face', () => {
	beforeEach(() => {
		useObject.mockReset()
		fieldDefinitions = {
			bet: [
				{ name: 'title', type: 'text' },
				{ name: 'priority', type: 'enum' },
				{ name: 'Owner team', type: 'text' },
				{ name: 'Source', type: 'text' },
				{ name: 'Budget', type: 'number' },
			],
		}
	})
	afterEach(() => {
		fieldDefinitions = {}
	})
	const renderCard = () => render(<ObjectReferenceCard workspaceId={WS} objectId={ID} />)

	it('has an icon tile in the type colours, the type name as the eyebrow and the status as a badge', () => {
		useObject.mockReturnValue({ data: objectRow(), isLoading: false })
		renderCard()
		const link = screen.getByRole('link')
		const tile = link.querySelector('span.size-6')
		expect(tile?.className).toContain('bg-type-bet-bg')
		expect(tile?.querySelector('svg')).not.toBeNull()
		expect(screen.getByText('Bet')).toHaveClass('eyebrow')
		expect(link).toHaveTextContent(/active/i)
		expect(link).toHaveTextContent('Chat preview cards')
		expect(link).toHaveTextContent('Text')
	})

	it('uses the secondary tile colours for a type with no colour of its own', () => {
		useObject.mockReturnValue({ data: objectRow({ type: 'contact' }), isLoading: false })
		renderCard()
		expect(screen.getByRole('link').querySelector('span.size-6')?.className).toContain(
			'bg-secondary',
		)
	})

	it('draws no fact rows when no field is filled in', () => {
		useObject.mockReturnValue({ data: objectRow({ metadata: { priority: '' } }), isLoading: false })
		renderCard()
		expect(screen.queryByText('priority')).not.toBeInTheDocument()
		expect(screen.queryByText('Owner team')).not.toBeInTheDocument()
	})

	it('draws one fact row for one filled field, labelled with the field name', () => {
		useObject.mockReturnValue({
			data: objectRow({ metadata: { priority: 'P2' } }),
			isLoading: false,
		})
		renderCard()
		expect(screen.getByText('priority')).toBeInTheDocument()
		expect(screen.getByText('P2')).toBeInTheDocument()
		expect(screen.queryByText('Source')).not.toBeInTheDocument()
	})

	it('draws at most three fact rows, in the order of the schema', () => {
		useObject.mockReturnValue({
			data: objectRow({
				metadata: { Budget: 5, Source: 'Referral', 'Owner team': 'Growth', priority: 'P1' },
			}),
			isLoading: false,
		})
		renderCard()
		const labels = ['priority', 'Owner team', 'Source']
		for (const label of labels) expect(screen.getByText(label)).toBeInTheDocument()
		expect(screen.queryByText('Budget')).not.toBeInTheDocument()
		const text = screen.getByRole('link').textContent ?? ''
		expect(text.indexOf('priority')).toBeLessThan(text.indexOf('Owner team'))
		expect(text.indexOf('Owner team')).toBeLessThan(text.indexOf('Source'))
	})

	it('says an object was deleted, with a trash icon, in the dashed look', () => {
		useObject.mockReturnValue({ data: undefined, isLoading: false })
		renderCard()
		const card = screen.getByText('This object was deleted')
		expect(card).toHaveClass('border-dashed', 'italic')
		expect(card.querySelector('svg')?.getAttribute('class')).toContain('lucide-trash')
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

	it('opens on keyboard focus and closes when focus leaves it', async () => {
		const user = userEvent.setup()
		renderChip()
		await user.tab()
		expect(chip()).toHaveFocus()
		expect(preview()).not.toBeNull()
		await user.tab()
		await user.tab()
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

	it('is a non-modal dialog named Object preview, in the accessibility tree', async () => {
		const user = userEvent.setup()
		renderChip()
		await user.hover(chip())
		const dialog = screen.getByRole('dialog', { name: 'Object preview' })
		expect(dialog).toBe(preview())
		expect(dialog).not.toHaveAttribute('aria-hidden')
		expect(dialog).not.toHaveAttribute('aria-modal')
	})

	it('holds the card as plain content with Copy link and Open as its only controls', async () => {
		const user = userEvent.setup()
		renderChip()
		await user.hover(chip())
		const dialog = screen.getByRole('dialog', { name: 'Object preview' })
		expect(dialog).toHaveTextContent('Chat preview cards')
		expect(dialog.querySelectorAll('a')).toHaveLength(1)
		expect(screen.getByRole('link', { name: 'Open' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument()
		expect(dialog.querySelectorAll('button')).toHaveLength(1)
		expect(dialog.querySelector('[data-linked-card]')).toBeNull()
	})

	it('moves from the chip into Copy link and then Open with Tab', async () => {
		const user = userEvent.setup()
		renderChip()
		await user.tab()
		expect(chip()).toHaveFocus()
		await user.tab()
		expect(screen.getByRole('button', { name: 'Copy link' })).toHaveFocus()
		await user.tab()
		expect(screen.getByRole('link', { name: 'Open' })).toHaveFocus()
	})

	it('closes on Escape from inside the preview and puts focus back on the chip', async () => {
		const user = userEvent.setup()
		renderChip()
		await user.tab()
		await user.tab()
		expect(screen.getByRole('button', { name: 'Copy link' })).toHaveFocus()
		await user.keyboard('{Escape}')
		expect(preview()).toBeNull()
		expect(chip()).toHaveFocus()
	})

	it('copies the address the chip links to and says so', async () => {
		const user = userEvent.setup()
		toast.mockReset()
		const writeText = vi.fn().mockResolvedValue(undefined)
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
		renderChip()
		await user.hover(chip())
		await user.click(screen.getByRole('button', { name: 'Copy link' }))
		expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/${WS}/objects/${ID}`)
		expect(toast).toHaveBeenCalledWith('Link copied', { duration: 1800 })
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

describe('ObjectReferenceChip sheet', () => {
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
	const sheet = () => screen.queryByRole('dialog', { name: 'Object preview' })

	beforeEach(() => {
		useObject.mockReset()
		toast.mockReset()
		useObject.mockReturnValue({ data: objectRow(), isLoading: false })
		setPointerDesktop(false)
	})
	afterEach(() => {
		window.matchMedia = realMatchMedia
	})

	it('opens the sheet on a tap instead of leaving, with the card as plain content', async () => {
		const user = userEvent.setup()
		renderChip()
		expect(sheet()).toBeNull()
		await user.click(chip())
		const dialog = sheet()
		expect(dialog).toHaveAttribute('aria-modal', 'true')
		expect(dialog?.textContent).toContain('Chat preview cards')
		expect(dialog?.textContent).toContain('Developer')
		// The card is not a link: the only link in the sheet is Open.
		expect(screen.getAllByRole('link', { name: 'Open' })).toHaveLength(1)
		expect(dialog?.querySelectorAll('a')).toHaveLength(1)
		expect(screen.getByRole('button', { name: 'Copy link' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument()
		// The sheet's card is not counted as a card of the message.
		expect(dialog?.querySelector('[data-linked-card]')).toBeNull()
	})

	it('closes with Close and Escape, and focus goes back to the chip', async () => {
		const user = userEvent.setup()
		renderChip()
		await user.click(chip())
		await user.click(screen.getByRole('button', { name: 'Close' }))
		expect(sheet()).toBeNull()
		await waitFor(() => expect(chip()).toHaveFocus())
		await user.click(chip())
		expect(sheet()).not.toBeNull()
		await user.keyboard('{Escape}')
		expect(sheet()).toBeNull()
		await waitFor(() => expect(chip()).toHaveFocus())
	})

	it('copies the address and says so; says nothing when there is no clipboard', async () => {
		const user = userEvent.setup()
		const writeText = vi.fn().mockResolvedValue(undefined)
		Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
		renderChip()
		await user.click(chip())
		await user.click(screen.getByRole('button', { name: 'Copy link' }))
		expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/${WS}/objects/${ID}`)
		expect(toast).toHaveBeenCalledWith('Link copied', { duration: 1800 })

		toast.mockReset()
		Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
		await user.click(screen.getByRole('button', { name: 'Copy link' }))
		expect(toast).not.toHaveBeenCalled()
	})

	it('shows the card skeleton in the sheet while the object loads', async () => {
		const user = userEvent.setup()
		useObject.mockReturnValue({ data: undefined, isLoading: true })
		renderChip()
		await user.click(screen.getByText('the original link'))
		expect(sheet()?.querySelector('[aria-busy="true"]')).not.toBeNull()
		expect(screen.getByRole('link', { name: 'Open' })).toBeInTheDocument()
	})

	it('opens no sheet for a deleted object', async () => {
		const user = userEvent.setup()
		useObject.mockReturnValue({ data: undefined, isLoading: false })
		renderChip()
		await user.click(screen.getByText('Deleted object'))
		expect(sheet()).toBeNull()
	})

	it('opens no sheet on a pointer device at 640px or wider', async () => {
		const user = userEvent.setup()
		setPointerDesktop(true)
		renderChip()
		await user.click(chip())
		expect(sheet()).toBeNull()
	})
})
