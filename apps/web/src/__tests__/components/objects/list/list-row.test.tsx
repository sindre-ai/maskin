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
		expect(screen.getByRole('button', { name: 'Star this object' })).toBeInTheDocument()
		const checkbox = screen.getByRole('checkbox', { name: 'Select row' })
		expect(checkbox).toHaveAttribute('data-state', 'unchecked')
		expect(checkbox.className).toContain('opacity-0')
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
		const star = screen.getByRole('button', { name: 'Star this object' })
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

	it('renders the amber "Waiting on you" pill on the shipped ask tokens', () => {
		renderRow({ ask, actors })
		const pill = screen.getByText('Waiting on you')
		// `--ask-surface` / `--ask-border` / `--warning` invert across themes; a
		// neutral `bg-accent` here would be near-invisible in light mode.
		expect(pill.className).toContain('bg-ask-surface')
		expect(pill.className).toContain('border-ask-border')
		expect(pill.className).toContain('text-warning')
	})

	it('renders the ask line naming the asking agent', () => {
		renderRow({ ask, actors })
		expect(screen.getByText('Scout asks')).toBeInTheDocument()
		expect(screen.getByText(/Ship on Friday or Monday\?/)).toBeInTheDocument()
	})

	it('hides the pill and ask line when the ask is resolved', () => {
		renderRow({ ask: { ...ask, status: 'resolved' }, actors })
		expect(screen.queryByText('Waiting on you')).toBeNull()
		expect(screen.queryByText('Scout asks')).toBeNull()
	})
})
