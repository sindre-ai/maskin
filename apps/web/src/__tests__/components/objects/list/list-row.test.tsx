import { ListRow } from '@/components/objects/list/list-row'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	buildActorListItem,
	buildNotificationResponse,
	buildObjectResponse,
} from '../../../factories'

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => vi.fn(),
	useRouter: () => ({ invalidate: vi.fn() }),
	Link: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => {
		const { to: _to, params: _params, ...rest } = props
		return (
			<button type="button" {...(rest as ButtonHTMLAttributes<HTMLButtonElement>)}>
				{children}
			</button>
		)
	},
}))

// The list row now owns the star affordance via `useStar` (D5 client
// migration). Mock the hook so tests can drive isStarred + assert toggle
// without wiring a QueryClient + WorkspaceContext into every render.
const toggleMock = vi.fn()
let mockStarState: { isStarred: boolean; isSaving: boolean } = {
	isStarred: false,
	isSaving: false,
}
vi.mock('@/hooks/use-star', () => ({
	useStar: () => ({ ...mockStarState, toggle: toggleMock }),
}))

const baseProps = {
	workspaceId: 'ws-1',
	onSelect: vi.fn(),
	onOpen: vi.fn(),
	onShiftClick: vi.fn(),
	columnVisibility: {},
}

function renderRow(overrides: Partial<React.ComponentProps<typeof ListRow>> = {}) {
	const object = buildObjectResponse({ id: 'obj-1', type: 'bet', title: 'Ship the thing' })
	return {
		object,
		...render(<ListRow {...baseProps} object={object} isSelected={false} {...overrides} />),
	}
}

describe('ListRow select affordance', () => {
	beforeEach(() => {
		toggleMock.mockClear()
		mockStarState = { isStarred: false, isSaving: false }
	})

	// Mockup 756–758: a star at rest, a checkbox once anything is selected.
	it('shows the resting star alongside a hover-revealed checkbox when nothing is selected', () => {
		renderRow({ anySelected: false, isSelected: false })
		expect(screen.getByRole('button', { name: 'Star this item' })).toBeInTheDocument()
		const checkbox = screen.getByRole('checkbox', { name: 'Select row' })
		expect(checkbox).toHaveAttribute('data-state', 'unchecked')
		expect(checkbox.className).toContain('opacity-0')
	})

	// Touch: a 16px visible box (no touch-size primitive) with a 44px tap area
	// made of real padding (a wrapper for the checkbox, the button itself for the star),
	// and the star stays visible beside it instead of standing down.
	it('keeps the checkbox at 16px with a 44px tap area and the star visible on touch', () => {
		renderRow({ anySelected: false, isSelected: false })
		const checkbox = screen.getByRole('checkbox', { name: 'Select row' })
		expect(checkbox).toHaveAttribute('data-size', 'sm')
		expect(checkbox.className).toContain('h-4')
		expect(checkbox.className).not.toContain('after:')
		const wrapper = checkbox.parentElement
		expect(wrapper?.className).toContain('max-[1024.02px]:p-3.5')
		expect(wrapper?.className).toContain('max-[1024.02px]:-m-3.5')
		const star = screen.getByRole('button', { name: 'Star this item' })
		expect(star.className).not.toContain('max-[1024.02px]:hidden')
		expect(star.className).not.toContain('pointer-coarse:hidden')
		expect(star.className).not.toContain('after:')
		expect(star.className).toContain('max-[1024.02px]:p-3.5')
		expect(star.className).toContain('max-[1024.02px]:-m-3.5')
	})

	// The padding around the 16px box is part of the tap area, so a tap there
	// selects the row without opening it.
	it('selects the row, and does not open it, on a tap in the checkbox tap area', () => {
		const onSelect = vi.fn()
		const onOpen = vi.fn()
		renderRow({ onSelect, onOpen, isSelected: false })
		const wrapper = screen.getByRole('checkbox', { name: 'Select row' }).parentElement
		expect(wrapper).not.toBeNull()
		if (!wrapper) return
		fireEvent.click(wrapper)
		expect(onSelect).toHaveBeenCalledWith(true)
		expect(onOpen).not.toHaveBeenCalled()
	})

	it('draws a filled star and offers to remove it once the row is starred', () => {
		mockStarState = { isStarred: true, isSaving: false }
		renderRow({ anySelected: false, isSelected: false })
		const star = screen.getByRole('button', { name: 'Starred (click to remove)' })
		expect(star).toHaveTextContent('★')
		expect(star).toHaveAttribute('aria-pressed', 'true')
		fireEvent.click(star)
		expect(toggleMock).toHaveBeenCalledTimes(1)
	})

	it('drops opacity to 60% while the server round-trip is in flight', () => {
		mockStarState = { isStarred: false, isSaving: true }
		renderRow({ anySelected: false, isSelected: false })
		const star = screen.getByRole('button', { name: 'Star this item' })
		expect(star.className).toContain('opacity-60')
	})

	it('replaces the star with a checkbox on every row once any row is selected', () => {
		renderRow({ anySelected: true, isSelected: false })
		expect(screen.queryByRole('button', { name: /star/i })).toBeNull()
		const checkbox = screen.getByRole('checkbox', { name: 'Select row' })
		expect(checkbox).toHaveAttribute('data-state', 'unchecked')
		expect(checkbox.className).not.toContain('opacity-0')
	})

	it('renders a checked checkbox for the selected row', () => {
		renderRow({ anySelected: true, isSelected: true })
		expect(screen.getByRole('checkbox', { name: 'Select row' })).toHaveAttribute(
			'data-state',
			'checked',
		)
	})

	// SPEC §D5 keyboard shortcut: pressing `s` on the focused row toggles it.
	it('toggles the star when `s` is pressed on the row', () => {
		renderRow({ anySelected: false, isSelected: false })
		const row = screen.getByRole('button', { name: 'Ship the thing' }).closest('div')
		expect(row).not.toBeNull()
		if (!row) return
		fireEvent.keyDown(row, { key: 's' })
		expect(toggleMock).toHaveBeenCalledTimes(1)
	})

	it('ignores `s` inside an editable target so metadata fields keep the keystroke', () => {
		const { container } = renderRow({ anySelected: false, isSelected: false })
		const input = document.createElement('input')
		container.appendChild(input)
		fireEvent.keyDown(input, { key: 's', bubbles: true })
		expect(toggleMock).not.toHaveBeenCalled()
	})
})

describe('ListRow pending ask', () => {
	beforeEach(() => {
		toggleMock.mockClear()
		mockStarState = { isStarred: false, isSaving: false }
	})

	const ask = buildNotificationResponse({
		status: 'pending',
		sourceActorId: 'actor-1',
		content: 'Ship on Friday or Monday?',
	})
	const actors = [buildActorListItem({ id: 'actor-1', name: 'Scout', type: 'agent' })]

	it('renders the ask line as the asking agent and the question only', () => {
		renderRow({ ask, actors })
		const question = screen.getByText('Ship on Friday or Monday?')
		// No visible "Ask" tag; the "<agent> asks" wording is screen-reader only.
		expect(screen.queryByText('Ask')).toBeNull()
		expect(screen.getByText('Scout asks').className).toContain('sr-only')
		// The agent's avatar sits in the line and carries its initials (SC).
		expect(question.parentElement?.textContent).toBe('SCScout asksShip on Friday or Monday?')
	})

	it('truncates ask text at ~90 chars with a trailing ellipsis', () => {
		const longAsk = buildNotificationResponse({
			status: 'pending',
			sourceActorId: 'actor-1',
			// 120 chars — comfortably over the 90-char cap.
			content: 'A'.repeat(120),
		})
		renderRow({ ask: longAsk, actors })
		const line = screen.getByText('Scout asks').parentElement
		expect(line?.textContent).toContain(`${'A'.repeat(90)}…`)
		expect(line?.textContent).not.toContain('A'.repeat(91))
	})

	it('renders a `+ N more` counter when multiple pending asks target the row', () => {
		renderRow({ ask, actors, pendingAskCount: 4 })
		// Overflow suffix renders as plain text — SPEC's explicit "not a link".
		const suffix = screen.getByText('+ 3 more', { exact: false })
		expect(suffix.tagName).toBe('SPAN')
	})

	it('hides the pill and ask line when the ask is resolved', () => {
		renderRow({ ask: { ...ask, status: 'resolved' }, actors })
		expect(screen.queryByText('Ask')).toBeNull()
		expect(screen.queryByText('Scout asks')).toBeNull()
	})
})

describe('ListRow narrow layout', () => {
	it('shows the type as a glyph named with its full type name, at every width (v3)', () => {
		// v3 mockup: no plate and no word in the row, so the title keeps the room
		// on phones. The full name stays as the glyph's accessible name and tooltip.
		renderRow({ typeLabel: 'Knowledge' })
		expect(screen.queryByText('Knowledge')).toBeNull()
		const glyph = screen.getByRole('img', { name: 'Knowledge' })
		expect(glyph.getAttribute('title')).toBe('Knowledge')
		expect(glyph.className).not.toContain('sm:hidden')
		expect(glyph.className).not.toContain('max-sm:hidden')
	})

	it('lets the title run to two lines on phones and one line from sm', () => {
		renderRow()
		const title = screen.getByText('Ship the thing')
		expect(title.className).toContain('max-sm:line-clamp-2')
		expect(title.className.split(' ')).toContain('truncate')
		expect(title.className).toContain('max-sm:whitespace-normal')
	})

	it('hides the driver avatar below sm while the driver is idle', () => {
		const driver = buildActorListItem({ id: 'agent-1', name: 'Scout', type: 'agent' })
		const { container } = renderRow({
			object: buildObjectResponse({ id: 'obj-1', type: 'bet', driver: driver.id }),
			actors: [driver],
		})
		const wrapper = container.querySelector('.sm\\:inline-flex')
		expect(wrapper?.className.split(' ')).toContain('hidden')
	})

	it('keeps the driver avatar, and its working ring, on phones while the driver is working', () => {
		const driver = buildActorListItem({ id: 'agent-1', name: 'Scout', type: 'agent' })
		const { container } = renderRow({
			object: buildObjectResponse({
				id: 'obj-1',
				type: 'bet',
				driver: driver.id,
				activeSessionId: 'sess-1',
				active_session_state: 'running',
			}),
			actors: [driver],
		})
		const wrapper = container.querySelector('.sm\\:inline-flex')
		expect(wrapper?.className.split(' ')).not.toContain('hidden')
		expect(wrapper?.querySelector('.actor-avatar-working-ring')).not.toBeNull()
	})
})
