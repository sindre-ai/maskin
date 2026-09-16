import { ListRow } from '@/components/objects/list/list-row'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
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
	// Mockup 756–758: a star at rest, a checkbox once anything is selected.
	it('shows the resting star alongside a hover-revealed checkbox when nothing is selected', () => {
		renderRow({ anySelected: false, isSelected: false })
		expect(screen.getByRole('button', { name: 'Star' })).toBeInTheDocument()
		const checkbox = screen.getByRole('checkbox', { name: 'Select row' })
		expect(checkbox).toHaveAttribute('data-state', 'unchecked')
		expect(checkbox.className).toContain('opacity-0')
	})

	it('draws a filled star and offers to unstar once the row is starred', () => {
		const onToggleStar = vi.fn()
		const { object } = renderRow({
			anySelected: false,
			isSelected: false,
			isStarred: true,
			onToggleStar,
		})
		const star = screen.getByRole('button', { name: 'Unstar' })
		expect(star).toHaveTextContent('★')
		fireEvent.click(star)
		expect(onToggleStar).toHaveBeenCalledWith(object.id)
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
})

describe('ListRow pending ask', () => {
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

	it('renders the D3 ask-line copy verbatim (name bold, text in quotes)', () => {
		renderRow({ ask, actors })
		// Asker name is a bold span, the ` asks — ` glue is the parent line's
		// text, and the text lives inside a quotes-wrapped span. Query by
		// element so the assertion pins the exact structure the SPEC calls for.
		const name = screen.getByText('Scout')
		expect(name.className).toContain('font-bold')
		expect(name.className).toContain('text-warning')
		expect(name.parentElement?.textContent).toBe('Scout asks — “Ship on Friday or Monday?”')
	})

	it('truncates ask text at ~90 chars with a trailing ellipsis', () => {
		const longAsk = buildNotificationResponse({
			status: 'pending',
			sourceActorId: 'actor-1',
			// 120 chars — comfortably over the 90-char cap.
			content: 'A'.repeat(120),
		})
		renderRow({ ask: longAsk, actors })
		const line = screen.getByText('Scout').parentElement
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
		expect(screen.queryByText('Waiting on you')).toBeNull()
		expect(screen.queryByText('Scout')).toBeNull()
	})
})

describe('ListRow D1 · loop chip', () => {
	it('renders a "↺ Loop · {name}" chip after the title when the row is in a loop', () => {
		renderRow({ loop: { id: 'loop-1', name: 'signal-triage' } })
		expect(screen.getByText(/↺ Loop · signal-triage/)).toBeInTheDocument()
	})

	it('renders no chip (and reserves no space) when the row is in no loop', () => {
		renderRow({ loop: undefined })
		expect(screen.queryByText(/↺ Loop/)).toBeNull()
	})
})

describe('ListRow D2 · driver working ring', () => {
	const driver = buildActorListItem({ id: 'agent-1', name: 'Scout', type: 'agent' })

	it('wraps the driver avatar in a working ring when active_session_state is running', () => {
		const { container } = render(
			<ListRow
				{...baseProps}
				object={buildObjectResponse({
					id: 'obj-1',
					driver: driver.id,
					activeSessionId: 'sess-1',
					active_session_state: 'running',
				})}
				isSelected={false}
				actors={[driver]}
			/>,
		)
		expect(container.querySelector('.actor-avatar-working-ring')).not.toBeNull()
	})

	it('renders no ring when a session is tied but not running (paused, pending, etc.)', () => {
		const { container } = render(
			<ListRow
				{...baseProps}
				object={buildObjectResponse({
					id: 'obj-1',
					driver: driver.id,
					activeSessionId: 'sess-1',
					active_session_state: 'paused',
				})}
				isSelected={false}
				actors={[driver]}
			/>,
		)
		expect(container.querySelector('.actor-avatar-working-ring')).toBeNull()
	})

	it("renders no <AgentWorkingBadge> alongside the ring — the ring is the row's only working indicator", () => {
		render(
			<ListRow
				{...baseProps}
				object={buildObjectResponse({
					id: 'obj-1',
					activeSessionId: 'sess-1',
					active_session_state: 'running',
				})}
				isSelected={false}
			/>,
		)
		// The old right-side badge rendered a "Scout working" / spinner pill.
		// Under D2 that badge is gone entirely — the ring is the row's only
		// working indicator.
		expect(screen.queryByText(/working/i)).toBeNull()
	})
})
