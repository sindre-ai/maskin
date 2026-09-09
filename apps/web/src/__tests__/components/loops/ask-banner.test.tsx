import { AskBanner } from '@/components/loops/ask-banner'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

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
