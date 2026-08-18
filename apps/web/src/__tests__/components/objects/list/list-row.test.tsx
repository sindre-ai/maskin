import { ListRow } from '@/components/objects/list/list-row'
import { render, screen } from '@testing-library/react'
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
	return render(<ListRow {...baseProps} object={object} isSelected={false} {...overrides} />)
}

describe('ListRow select affordance', () => {
	// Mockup 1002–1006: a type dot at rest, a checkbox once anything is selected.
	it('shows the resting type dot alongside a hidden checkbox when nothing is selected', () => {
		const { container } = renderRow({ anySelected: false, isSelected: false })
		const checkbox = screen.getByRole('checkbox', { name: 'Select row' })
		expect(checkbox).toHaveAttribute('data-state', 'unchecked')
		expect(checkbox.className).toContain('opacity-0')
		expect(container.querySelector('span[aria-hidden="true"].rounded-\\[2px\\]')).not.toBeNull()
	})

	it('reveals an empty checkbox on every row once any row is selected', () => {
		const { container } = renderRow({ anySelected: true, isSelected: false })
		const checkbox = screen.getByRole('checkbox', { name: 'Select row' })
		expect(checkbox).toHaveAttribute('data-state', 'unchecked')
		expect(checkbox.className).not.toContain('opacity-0')
		expect(container.querySelector('span[aria-hidden="true"].rounded-\\[2px\\]')).toBeNull()
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
