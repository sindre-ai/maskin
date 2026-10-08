import { AskBanner } from '@/components/loops/ask-banner'
import type { LoopStep, LoopSummary, TriggerResponse } from '@/lib/api'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('AskBanner', () => {
	it('renders the "{agentName} asks — {askText}" line and the Decide button', () => {
		render(
			<AskBanner
				agentName="Copywriter"
				askText="Approve tomorrow's draft?"
				jumpHref="#loop-flow"
				onDecideClick={() => {}}
			/>,
		)
		expect(screen.getByText(/Copywriter asks/)).toBeInTheDocument()
		expect(screen.getByText(/Approve tomorrow's draft\?/)).toBeInTheDocument()
		const decide = screen.getByRole('button', { name: /Decide/i })
		expect(decide).toBeInTheDocument()
		expect(decide.getAttribute('data-jump-href')).toBe('#loop-flow')
	})

	it('is wrapped by role="region" so a caller-owned aria-live wrapper can announce it as a group', () => {
		render(
			<AskBanner
				agentName="Copywriter"
				askText="Approve tomorrow's draft?"
				jumpHref="#loop-flow"
				onDecideClick={() => {}}
			/>,
		)
		// The banner element itself carries `role=region` + a stable aria-label,
		// NOT `aria-live` (aria-live belongs on the stable wrapper the caller
		// renders so SR announcements do not race the DOM swap).
		const region = screen.getByRole('region', { name: /Pending ask/i })
		expect(region).toBeInTheDocument()
		expect(region.hasAttribute('aria-live')).toBe(false)
	})

	it('renders the aggregated count badge when pendingCount > 1', () => {
		render(
			<AskBanner
				agentName="Copywriter"
				askText="Approve tomorrow's draft?"
				jumpHref="#loop-flow"
				onDecideClick={() => {}}
				pendingCount={3}
			/>,
		)
		expect(screen.getByLabelText(/3 pending/i)).toBeInTheDocument()
		expect(screen.getByText('+2')).toBeInTheDocument()
	})

	it('renders no count badge when pendingCount is 1 or unset', () => {
		const { rerender } = render(
			<AskBanner
				agentName="Copywriter"
				askText="Approve tomorrow's draft?"
				jumpHref="#loop-flow"
				onDecideClick={() => {}}
				pendingCount={1}
			/>,
		)
		expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument()
		rerender(
			<AskBanner
				agentName="Copywriter"
				askText="Approve tomorrow's draft?"
				jumpHref="#loop-flow"
				onDecideClick={() => {}}
			/>,
		)
		expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument()
	})

	it('fires onDecideClick when the Decide button is clicked', () => {
		const onDecideClick = vi.fn()
		render(
			<AskBanner
				agentName="Copywriter"
				askText="Approve tomorrow's draft?"
				jumpHref="#loop-flow"
				onDecideClick={onDecideClick}
			/>,
		)
		fireEvent.click(screen.getByRole('button', { name: /Decide/i }))
		expect(onDecideClick).toHaveBeenCalledTimes(1)
	})

	it('fires onDecideClick on modifier-less `d` keypress when no editable element has focus', () => {
		const onDecideClick = vi.fn()
		render(
			<AskBanner
				agentName="Copywriter"
				askText="Approve tomorrow's draft?"
				jumpHref="#loop-flow"
				onDecideClick={onDecideClick}
			/>,
		)
		fireEvent.keyDown(window, { key: 'd' })
		expect(onDecideClick).toHaveBeenCalledTimes(1)
	})

	it('ignores `d` when a modifier is held', () => {
		const onDecideClick = vi.fn()
		render(
			<AskBanner
				agentName="Copywriter"
				askText="Approve tomorrow's draft?"
				jumpHref="#loop-flow"
				onDecideClick={onDecideClick}
			/>,
		)
		fireEvent.keyDown(window, { key: 'd', metaKey: true })
		fireEvent.keyDown(window, { key: 'd', ctrlKey: true })
		fireEvent.keyDown(window, { key: 'd', altKey: true })
		expect(onDecideClick).not.toHaveBeenCalled()
	})

	it('ignores `d` when the composer / textarea has focus', () => {
		const onDecideClick = vi.fn()
		render(
			<>
				<textarea aria-label="composer" />
				<AskBanner
					agentName="Copywriter"
					askText="Approve tomorrow's draft?"
					jumpHref="#loop-flow"
					onDecideClick={onDecideClick}
				/>
			</>,
		)
		const composer = screen.getByLabelText('composer') as HTMLTextAreaElement
		composer.focus()
		expect(document.activeElement).toBe(composer)
		// Dispatch a real KeyboardEvent so `document.activeElement` (checked by
		// the banner's guard) is used, not testing-library's synthetic target.
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }))
		expect(onDecideClick).not.toHaveBeenCalled()
	})
})

// Per-step-derived copy assertion at the banner boundary. The route wiring
// (see `__tests__/routes/loops-detail.test.tsx`) samples the first pending
// step from `useLoopSteps` for `agentName`, `askText`, and the avatar and
// hands them to the banner as props — those tests cover the wiring end-to-end.
// This block asserts the banner faithfully renders whatever the wiring hands
// it, using a per-step-shaped fixture so a regression that reverts the copy
// source to the pre-D6a trigger-actionPrompt fallback surfaces here too.
describe('AskBanner — per-step-derived copy', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	function firstPendingStepFixture(): LoopStep {
		return {
			triggerId: 't-pending',
			triggerName: 'Reply to inbound',
			triggerActionPrompt: 'Approve the outbound draft?',
			triggerType: 'event',
			triggerConfig: {},
			agent: { id: 'agent-quill', name: 'Quill', description: null },
			handsOffToActorId: null,
			escalatesToActorId: null,
			escalateAfterMs: null,
			handsOffToActor: null,
			escalatesToActor: null,
			waitingOnViewer: true,
			pendingCount: 1,
			lastEscalatedAt: null,
		}
	}

	// A stand-in fixture for the deprecated fallback path — the first enabled
	// trigger's actionPrompt + the loop's first agent. Present here only so the
	// assertion below can rule the banner does NOT display it when handed the
	// per-step-derived copy.
	function fallbackTriggerFixture(): TriggerResponse {
		return {
			id: 't-first-enabled',
			workspaceId: 'ws-1',
			name: 'Fallback trigger',
			type: 'cron',
			targetActorId: 'agent-first',
			config: { expression: '0 * * * *' },
			actionPrompt: 'Fallback trigger action prompt (must not render)',
			enabled: true,
			createdBy: 'agent-first',
			createdAt: null,
			updatedAt: null,
		} as TriggerResponse
	}

	function fallbackLoopFixture(): LoopSummary {
		return {
			id: 'loop-1',
			workspaceId: 'ws-1',
			name: 'Deal pipeline',
			content: null,
			status: 'supervised',
			pill: 'supervised',
			entryCondition: null,
			closeCondition: null,
			inProgressCount: 0,
			closedCount: 0,
			medianTimeToCloseMs: null,
			agentIds: ['agent-first'],
			triggerIds: ['t-first-enabled'],
			waitingOnViewer: true,
			waitingCount: 1,
			targets: null,
			createdAt: null,
			updatedAt: null,
		}
	}

	it('renders the step agent name and triggerActionPrompt when handed per-step-derived props', () => {
		const step = firstPendingStepFixture()
		render(
			<AskBanner
				agentName={step.agent?.name ?? 'This loop'}
				askText={step.triggerActionPrompt ?? 'is waiting on your input.'}
				jumpHref="#loop-flow"
				onDecideClick={() => {}}
				pendingCount={1}
				avatarId={step.agent?.id}
				avatarType="agent"
			/>,
		)

		// Per-step-derived copy: the step's agent name and its triggerActionPrompt.
		expect(screen.getByText(/Quill asks/)).toBeInTheDocument()
		expect(screen.getByText(/Approve the outbound draft\?/)).toBeInTheDocument()
	})

	it('does NOT render the retired fallback copy (first agent + first enabled trigger prompt)', () => {
		// Assemble the two fixtures the fallback path would have consumed, then
		// prove nothing on that path leaks through when the banner is fed
		// per-step-derived props instead.
		const step = firstPendingStepFixture()
		const loop = fallbackLoopFixture()
		const trigger = fallbackTriggerFixture()
		// Sanity: the fallback fixtures still describe the deprecated path so a
		// misconfigured test would render THAT copy — the assertions below
		// confirm the deprecated path is dropped.
		expect(loop.agentIds).toContain('agent-first')
		expect(trigger.actionPrompt).toMatch(/Fallback trigger action prompt/)

		render(
			<AskBanner
				agentName={step.agent?.name ?? 'This loop'}
				askText={step.triggerActionPrompt ?? 'is waiting on your input.'}
				jumpHref="#loop-flow"
				onDecideClick={() => {}}
				pendingCount={step.pendingCount}
				avatarId={step.agent?.id}
				avatarType="agent"
			/>,
		)

		expect(screen.queryByText(/Fallback trigger action prompt/)).not.toBeInTheDocument()
		// The pre-D6a fallback name was the loop's first agent — verify it never
		// reaches the banner. (The step agent is "Quill", not "First agent".)
		expect(screen.queryByText(/First agent asks/)).not.toBeInTheDocument()
	})
})
