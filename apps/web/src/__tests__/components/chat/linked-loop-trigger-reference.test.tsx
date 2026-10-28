import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const useLoop = vi.fn()
const useTrigger = vi.fn()
let actors: Array<{ id: string; name: string; type: string }> | undefined

vi.mock('@/hooks/use-loops', () => ({
	useLoop: (id: string, ws: string) => useLoop(id, ws),
}))
vi.mock('@/hooks/use-triggers', () => ({
	useTrigger: (id: string, ws: string) => useTrigger(id, ws),
}))
vi.mock('@/hooks/use-actors', () => ({ useActors: () => ({ data: actors }) }))
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
			data-linked-card={rest['data-linked-card'] as string | undefined}
		>
			{children}
		</a>
	),
}))

import {
	LoopReferenceCard,
	LoopReferenceChip,
	TriggerReferenceCard,
	TriggerReferenceChip,
} from '@/components/chat/linked-object-reference'

const WS = 'ws-1'
const LOOP_ID = 'c9389ff0-5ba6-4eae-a49c-4d4c4e84e6c0'
const TRIGGER_ID = 'd0490aa1-6cb7-4faf-b5ad-5e5d5f95f7d1'
const fallback = <a href="/original">the original link</a>

function loopRow(overrides: Record<string, unknown> = {}) {
	return {
		id: LOOP_ID,
		workspaceId: WS,
		name: 'Nightly triage',
		content: 'Sorts new insights into bets.',
		pill: 'supervised',
		agentIds: ['a-1', 'a-2'],
		inProgressCount: 3,
		closedCount: 7,
		updatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
		...overrides,
	}
}

function triggerRow(overrides: Record<string, unknown> = {}) {
	return {
		id: TRIGGER_ID,
		workspaceId: WS,
		name: 'Morning sweep',
		type: 'cron',
		config: { expression: '0 9 * * 1-5' },
		actionPrompt: 'SECRET INSTRUCTION TEXT',
		targetActorId: 'a-1',
		enabled: true,
		...overrides,
	}
}

const found = (data: unknown) => ({ data, isLoading: false })

beforeEach(() => {
	useLoop.mockReset()
	useTrigger.mockReset()
	actors = [
		{ id: 'a-1', name: 'Developer', type: 'agent' },
		{ id: 'a-2', name: 'Strategist', type: 'agent' },
	]
})

describe('LoopReferenceCard', () => {
	const renderCard = (preview = false) =>
		render(<LoopReferenceCard workspaceId={WS} loopId={LOOP_ID} preview={preview} />)

	it('shows tag, state, name, description and the footer', () => {
		useLoop.mockReturnValue(found(loopRow()))
		renderCard()
		expect(screen.getByText('Loop')).toBeInTheDocument()
		expect(screen.getByText('Supervised')).toBeInTheDocument()
		expect(screen.getByText('Nightly triage')).toBeInTheDocument()
		expect(screen.getByText('Sorts new insights into bets.')).toBeInTheDocument()
		expect(screen.getByText('3 items in progress')).toBeInTheDocument()
		expect(screen.getByText(/Updated/)).toBeInTheDocument()
		expect(document.querySelector('[data-linked-card]')).not.toBeNull()
	})

	it('falls back to completed items, and says nothing for a live loop without items', () => {
		useLoop.mockReturnValue(found(loopRow({ inProgressCount: 0 })))
		const { unmount } = renderCard()
		expect(screen.getByText('7 items completed')).toBeInTheDocument()
		unmount()
		useLoop.mockReturnValue(found(loopRow({ inProgressCount: 0, closedCount: 0 })))
		renderCard()
		expect(screen.queryByText(/items/)).not.toBeInTheDocument()
	})

	it('uses the Loops page line for paused, draft and waiting loops', () => {
		const lines: Record<string, string> = {
			paused: 'Paused — not running',
			draft: 'Draft — not live yet',
			waiting_on_you: 'Waiting on you',
		}
		for (const [pill, line] of Object.entries(lines)) {
			useLoop.mockReturnValue(found(loopRow({ pill })))
			const { unmount } = renderCard()
			expect(screen.getAllByText(line).length).toBeGreaterThan(0)
			unmount()
		}
	})

	it('leaves the description out when there is none, and the agents when there are none', () => {
		useLoop.mockReturnValue(found(loopRow({ content: null, agentIds: [] })))
		renderCard()
		expect(screen.queryByText('Sorts new insights into bets.')).not.toBeInTheDocument()
		expect(screen.queryByText('Developer')).not.toBeInTheDocument()
	})

	it('shows the skeleton while loops load', () => {
		useLoop.mockReturnValue({ data: undefined, isLoading: true })
		renderCard()
		expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
	})

	it('says Deleted loop when the loop is not in the list', () => {
		useLoop.mockReturnValue(found(undefined))
		renderCard()
		expect(screen.getByText('Deleted loop')).toHaveClass('italic')
	})

	it('is a preview that is not a tab stop and not counted as a card', () => {
		useLoop.mockReturnValue(found(loopRow()))
		renderCard(true)
		expect(document.querySelector('[data-linked-card]')).toBeNull()
		expect(screen.getByRole('link', { hidden: true })).toHaveAttribute('tabindex', '-1')
	})
})

describe('TriggerReferenceCard', () => {
	const renderCard = () => render(<TriggerReferenceCard workspaceId={WS} triggerId={TRIGGER_ID} />)

	it('shows tag, state, name, when it fires and the agent it wakes', () => {
		useTrigger.mockReturnValue(found(triggerRow()))
		renderCard()
		expect(screen.getByText('Trigger')).toBeInTheDocument()
		expect(screen.getByText('On')).toHaveClass('text-success')
		expect(screen.getByText('Morning sweep')).toBeInTheDocument()
		expect(screen.getByText(/^Runs /)).toBeInTheDocument()
		expect(screen.getByText('Developer')).toBeInTheDocument()
	})

	it('never shows the instruction text or the raw schedule', () => {
		// A weekday range is a schedule the app cannot put into words; the row would echo it raw.
		useTrigger.mockReturnValue(found(triggerRow()))
		const { container } = renderCard()
		expect(container.textContent).not.toContain('SECRET INSTRUCTION TEXT')
		expect(container.textContent).not.toContain('0 9 * * 1-5')
		expect(screen.getByText('Runs on a schedule')).toBeInTheDocument()
	})

	it('describes a schedule the app can put into words', () => {
		useTrigger.mockReturnValue(found(triggerRow({ config: { expression: '0 9 * * *' } })))
		renderCard()
		expect(screen.getByText(/^Runs every day at 9:00/i)).toBeInTheDocument()
	})

	it('reads Off muted for a trigger that is off', () => {
		useTrigger.mockReturnValue(found(triggerRow({ enabled: false })))
		renderCard()
		expect(screen.getByText('Off')).toHaveClass('text-muted-foreground')
	})

	it('says Unknown when the agent is no longer in the actor list', () => {
		useTrigger.mockReturnValue(found(triggerRow({ targetActorId: 'gone' })))
		renderCard()
		expect(screen.getByText('Unknown')).toBeInTheDocument()
	})

	it('shows the skeleton while triggers load, and Deleted trigger when it is missing', () => {
		useTrigger.mockReturnValue({ data: undefined, isLoading: true })
		const { unmount } = renderCard()
		expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
		unmount()
		useTrigger.mockReturnValue(found(undefined))
		renderCard()
		expect(screen.getByText('Deleted trigger')).toBeInTheDocument()
	})
})

describe('LoopReferenceChip', () => {
	const renderChip = () =>
		render(<LoopReferenceChip workspaceId={WS} loopId={LOOP_ID} fallback={fallback} />)

	it('keeps the original link while loops load', () => {
		useLoop.mockReturnValue({ data: undefined, isLoading: true })
		renderChip()
		expect(screen.getByText('the original link')).toBeInTheDocument()
	})

	it('reads kind, state and name as one link, with only the icon and name on the plate', () => {
		useLoop.mockReturnValue(found(loopRow({ pill: 'fully_autonomous' })))
		renderChip()
		const link = screen.getByRole('link', { name: 'Loop, fully autonomous: Nightly triage' })
		expect(link).toHaveTextContent(/^\u2060?Nightly triage$/)
		expect(link.className).toContain('bg-muted')
		expect(link.querySelector('svg')).not.toBeNull()
		expect(screen.queryByText('fully autonomous')).not.toBeInTheDocument()
		expect(screen.queryByText('the original link')).not.toBeInTheDocument()
	})

	it('says Deleted loop when the loop is not in the list', () => {
		useLoop.mockReturnValue(found(undefined))
		renderChip()
		expect(screen.getByText('Deleted loop')).toBeInTheDocument()
	})
})

describe('TriggerReferenceChip', () => {
	const renderChip = () =>
		render(<TriggerReferenceChip workspaceId={WS} triggerId={TRIGGER_ID} fallback={fallback} />)

	it('reads kind, state and name as one link', () => {
		useTrigger.mockReturnValue(found(triggerRow()))
		renderChip()
		expect(screen.getByRole('link', { name: 'Trigger, on: Morning sweep' })).toBeInTheDocument()
	})

	it('shows only the icon and name on the plate, no state word and no agent', () => {
		useTrigger.mockReturnValue(found(triggerRow()))
		renderChip()
		const link = screen.getByRole('link', { name: 'Trigger, on: Morning sweep' })
		expect(link).toHaveTextContent(/^\u2060?Morning sweep$/)
		expect(link.querySelector('svg')).not.toBeNull()
	})

	it('reads off for a trigger that is off', () => {
		useTrigger.mockReturnValue(found(triggerRow({ enabled: false })))
		renderChip()
		expect(screen.getByRole('link', { name: 'Trigger, off: Morning sweep' })).toBeInTheDocument()
	})

	it('keeps the original link while triggers load, and says Deleted trigger when gone', () => {
		useTrigger.mockReturnValue({ data: undefined, isLoading: true })
		const { unmount } = renderChip()
		expect(screen.getByText('the original link')).toBeInTheDocument()
		unmount()
		useTrigger.mockReturnValue(found(undefined))
		renderChip()
		expect(screen.getByText('Deleted trigger')).toBeInTheDocument()
	})
})

describe('loop and trigger chip preview', () => {
	const realMatchMedia = window.matchMedia
	beforeEach(() => {
		window.matchMedia = ((query: string) => ({
			matches: true,
			media: query,
			addEventListener: () => {},
			removeEventListener: () => {},
		})) as unknown as typeof window.matchMedia
		useLoop.mockReturnValue(found(loopRow()))
		useTrigger.mockReturnValue(found(triggerRow()))
	})
	afterEach(() => {
		window.matchMedia = realMatchMedia
	})
	const preview = () => document.querySelector('[data-linked-preview]')

	it('opens the loop card on hover and closes it on Escape', async () => {
		const user = userEvent.setup()
		render(<LoopReferenceChip workspaceId={WS} loopId={LOOP_ID} fallback={fallback} />)
		await user.hover(screen.getByRole('link', { name: /^Loop, supervised/ }))
		expect(preview()?.textContent).toContain('Sorts new insights into bets.')
		await user.keyboard('{Escape}')
		expect(preview()).toBeNull()
	})

	it('opens the trigger card on focus', async () => {
		const user = userEvent.setup()
		render(<TriggerReferenceChip workspaceId={WS} triggerId={TRIGGER_ID} fallback={fallback} />)
		await user.tab()
		expect(preview()?.textContent).toContain('Morning sweep')
		expect(preview()?.textContent).not.toContain('SECRET INSTRUCTION TEXT')
	})

	it('has no preview for a deleted loop', () => {
		useLoop.mockReturnValue(found(undefined))
		render(<LoopReferenceChip workspaceId={WS} loopId={LOOP_ID} fallback={fallback} />)
		act(() => {
			fireEvent.mouseEnter(screen.getByText('Deleted loop'))
		})
		expect(preview()).toBeNull()
	})
})

describe('loop and trigger card fold', () => {
	it('folds a loop card to one row and unfolds it', async () => {
		const user = userEvent.setup()
		useLoop.mockReturnValue(found(loopRow()))
		render(<LoopReferenceCard workspaceId={WS} loopId={LOOP_ID} />)
		expect(screen.getByRole('button', { name: 'Fold card' })).toHaveAttribute(
			'aria-expanded',
			'true',
		)
		expect(screen.getByRole('button', { name: 'Fold card' }).closest('a')).toBeNull()
		await user.click(screen.getByRole('button', { name: 'Fold card' }))
		const row = screen.getByRole('button', { name: 'Unfold card: Nightly triage' })
		expect(row).toHaveTextContent('Supervised')
		expect(screen.queryByRole('link')).toBeNull()
		await user.click(row)
		expect(screen.getByRole('link')).toBeInTheDocument()
	})

	it('folds a trigger card to one row and unfolds it', async () => {
		const user = userEvent.setup()
		useTrigger.mockReturnValue(found(triggerRow()))
		render(<TriggerReferenceCard workspaceId={WS} triggerId={TRIGGER_ID} />)
		await user.click(screen.getByRole('button', { name: 'Fold card' }))
		const row = screen.getByRole('button', { name: 'Unfold card: Morning sweep' })
		expect(row).toHaveTextContent('On')
		await user.click(row)
		expect(screen.getByRole('link')).toBeInTheDocument()
	})

	it('has no fold button on the hover preview', () => {
		useLoop.mockReturnValue(found(loopRow()))
		render(<LoopReferenceCard workspaceId={WS} loopId={LOOP_ID} preview />)
		expect(screen.queryByRole('button', { hidden: true })).toBeNull()
	})
})
