import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/analytics', () => ({
	trackLoopsDetailFlowScrollDepth: vi.fn(),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/api', () => ({
	api: { relationships: { list: vi.fn().mockResolvedValue([]) } },
}))

import { LoopFlow } from '@/components/loops/loop-flow'
import { LoopFlowVerticalStory } from '@/components/loops/loop-flow-vertical-story'
import { trackLoopsDetailFlowScrollDepth } from '@/lib/analytics'
import { buildLoopStep, buildLoopSummary } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

describe('LoopFlowVerticalStory', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('renders the six-step spine eyebrow labels verbatim from SPEC on a full loop', () => {
		const loop = buildLoopSummary({ id: 'loop-full', closeCondition: 'the bet is validated' })
		const steps = [
			buildLoopStep({
				triggerId: 't-first',
				triggerType: 'cron',
				triggerConfig: { expression: '0 * * * *' },
				triggerActionPrompt: 'Scan the inbox',
				agent: { id: 'a-relay', name: 'Relay', description: null },
				handsOffToActorId: 'a-sebk',
				handsOffToActor: { id: 'a-sebk', name: 'Sebk', description: null },
				escalatesToActorId: 'a-magnus',
				escalatesToActor: { id: 'a-magnus', name: 'Magnus', description: null },
				escalateAfterMs: 12 * 60 * 60 * 1000, // 12h
				waitingOnViewer: false,
				pendingCount: 0,
			}),
			buildLoopStep({
				triggerId: 't-next',
				triggerType: 'event',
				triggerActionPrompt: 'Draft the reply',
				agent: { id: 'a-quill', name: 'Quill', description: null },
			}),
		]
		render(<LoopFlowVerticalStory loop={loop} steps={steps} />)

		// Every mono eyebrow the SPEC pins on the six step-kind rows.
		expect(screen.getByText('TRIGGER · FIRES')).toBeInTheDocument()
		expect(screen.getByText('PICKS UP')).toBeInTheDocument()
		expect(screen.getByText('HANDS OFF')).toBeInTheDocument()
		expect(screen.getByText('PUBLISHES')).toBeInTheDocument()
		expect(screen.getByText('DONE WHEN')).toBeInTheDocument()
		expect(screen.getByText('ESCALATES TO')).toBeInTheDocument()
	})

	it('renders the {n} pending badge on the HANDS OFF row when the step is waitingOnViewer', () => {
		const loop = buildLoopSummary({ id: 'loop-wait' })
		const steps = [
			buildLoopStep({
				triggerId: 't-wait',
				handsOffToActorId: 'a-you',
				handsOffToActor: { id: 'a-you', name: 'You', description: null },
				waitingOnViewer: true,
				pendingCount: 3,
			}),
		]
		render(<LoopFlowVerticalStory loop={loop} steps={steps} />)

		expect(screen.getByText('3 pending')).toBeInTheDocument()
	})

	it('renders ESCALATES TO with the SPEC-pattern `if pending > 12h → Sebk` when both fields are set', () => {
		const loop = buildLoopSummary({ id: 'loop-esc' })
		const steps = [
			buildLoopStep({
				triggerId: 't-esc',
				escalatesToActorId: 'a-sebk',
				escalatesToActor: { id: 'a-sebk', name: 'Sebk', description: null },
				escalateAfterMs: 12 * 60 * 60 * 1000,
			}),
		]
		render(<LoopFlowVerticalStory loop={loop} steps={steps} />)

		expect(screen.getByText('ESCALATES TO')).toBeInTheDocument()
		// The row's copy is composed of multiple spans (threshold + arrow +
		// bold target), so query the container text as a whole. `Sebk` is bold,
		// so the whole row lives on the row's own <span> — read that span's
		// text via the test id on the step.
		const step = screen.getByTestId('loop-step-t-esc')
		expect(step.textContent).toContain('if pending > 12h → Sebk')
	})

	it('does NOT render the ESCALATES TO row when neither escalation field is set', () => {
		const loop = buildLoopSummary({ id: 'loop-noesc' })
		const steps = [
			buildLoopStep({
				triggerId: 't-noesc',
				escalatesToActorId: null,
				escalateAfterMs: null,
			}),
		]
		render(<LoopFlowVerticalStory loop={loop} steps={steps} />)

		expect(screen.queryByText('ESCALATES TO')).not.toBeInTheDocument()
	})

	it('renders the empty-flow dashed dot spine when the loop has no steps', () => {
		const loop = buildLoopSummary({ id: 'loop-empty' })
		render(<LoopFlowVerticalStory loop={loop} steps={[]} />)

		expect(screen.getByText(/No steps yet/)).toBeInTheDocument()
	})

	it('emits loops.detail.flow_scroll_depth once per depth on scroll', () => {
		// Mock viewport + bounding rect so the container appears fully scrolled.
		Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })

		const loop = buildLoopSummary({ id: 'loop-scroll' })
		const steps = [buildLoopStep({ triggerId: 't-1' })]
		const { container } = render(<LoopFlowVerticalStory loop={loop} steps={steps} />)

		// The outer wrapper is the first div — force it to look fully scrolled
		// past the viewport top so all four depth thresholds fire on next scroll.
		const outer = container.firstChild as HTMLElement
		const rect = { top: -2000, height: 400 } as DOMRect
		outer.getBoundingClientRect = () => rect

		window.dispatchEvent(new Event('scroll'))

		const calls = vi.mocked(trackLoopsDetailFlowScrollDepth).mock.calls
		const depths = calls.map((c) => c[0].depth)
		expect(depths).toEqual(expect.arrayContaining([25, 50, 75, 100]))

		// Same scroll fires again — but each depth was already recorded, so no
		// duplicate emissions land.
		window.dispatchEvent(new Event('scroll'))
		expect(vi.mocked(trackLoopsDetailFlowScrollDepth).mock.calls.length).toBe(calls.length)
	})
})

describe('LoopFlow variant dispatch', () => {
	it('renders LoopFlowVerticalStory content when variant="vertical-story"', () => {
		const loop = buildLoopSummary({ id: 'loop-vs' })
		const steps = [buildLoopStep({ triggerId: 't-vs' })]

		render(
			<LoopFlow
				workspaceId="ws-1"
				triggers={[]}
				actors={[]}
				childObjects={[]}
				loop={loop}
				variant="vertical-story"
				steps={steps}
			/>,
		)
		expect(screen.getByText('The loop, right now')).toBeInTheDocument()
		expect(screen.getByText('PICKS UP')).toBeInTheDocument()
	})

	it('carries the #loop-flow anchor the ask banner scrolls to, with and without steps', () => {
		// The AskBanner's Decide CTA (and its `d` shortcut) resolve
		// `document.getElementById('loop-flow')`. That id lived only on the
		// status-columns variant, so with the step-flow sub-flag on — the exact
		// state the banner renders in — the button silently did nothing.
		const loop = buildLoopSummary({ id: 'loop-anchor' })
		const { container, rerender } = render(
			<LoopFlowVerticalStory loop={loop} steps={[buildLoopStep({ triggerId: 'trig-1' })]} />,
		)
		expect(container.querySelector('#loop-flow')).not.toBeNull()

		rerender(<LoopFlowVerticalStory loop={loop} steps={[]} />)
		expect(container.querySelector('#loop-flow')).not.toBeNull()
	})

	it('renders the shipped status-columns variant by default', () => {
		const loop = buildLoopSummary({ id: 'loop-sc' })
		render(
			<LoopFlow workspaceId="ws-1" triggers={[]} actors={[]} childObjects={[]} loop={loop} />,
			{
				wrapper: createWorkspaceWrapper({ id: 'ws-1' }),
			},
		)
		// The default variant renders nothing when there are no triggers and no
		// stages (`if (!hasTriggers && !hasStages) return null`), so the
		// vertical-story-only PICKS UP eyebrow must be absent.
		expect(screen.queryByText('PICKS UP')).not.toBeInTheDocument()
	})
})
