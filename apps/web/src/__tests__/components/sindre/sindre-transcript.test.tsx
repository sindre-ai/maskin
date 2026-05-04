import { SindreTranscript } from '@/components/sindre/sindre-transcript'
import type { SindreEvent } from '@/lib/sindre-stream'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

describe('SindreTranscript', () => {
	it('renders assistant text as markdown (bold, headings)', () => {
		const events: SindreEvent[] = [
			{ kind: 'text', text: '# Hello\n\nSome **bold** text and a [link](https://example.com).' },
		]
		render(<SindreTranscript events={events} starting={false} error={null} />)

		expect(screen.getByRole('heading', { name: 'Hello' })).toBeInTheDocument()
		expect(screen.getByText('bold')).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'link' })).toHaveAttribute(
			'href',
			'https://example.com',
		)
	})

	it('renders tool_use as a collapsible block showing name, collapsed by default', () => {
		const events: SindreEvent[] = [
			{
				kind: 'tool_use',
				id: 'tool-1',
				name: 'list_objects',
				input: { type: 'bet', limit: 10 },
			},
		]
		render(<SindreTranscript events={events} starting={false} error={null} />)

		const trigger = screen.getByRole('button', { name: /list_objects/i })
		expect(trigger).toHaveAttribute('aria-expanded', 'false')
		// The formatted input JSON should NOT be in the DOM while collapsed.
		expect(screen.queryByText(/"limit": 10/)).not.toBeInTheDocument()
	})

	it('expands tool_use to show formatted input when clicked', () => {
		const events: SindreEvent[] = [
			{
				kind: 'tool_use',
				id: 'tool-1',
				name: 'list_objects',
				input: { type: 'bet', limit: 10 },
			},
		]
		render(<SindreTranscript events={events} starting={false} error={null} />)

		fireEvent.click(screen.getByRole('button', { name: /list_objects/i }))

		expect(screen.getByRole('button', { name: /list_objects/i })).toHaveAttribute(
			'aria-expanded',
			'true',
		)
		expect(screen.getByText(/"limit": 10/)).toBeInTheDocument()
		expect(screen.getByText(/"type": "bet"/)).toBeInTheDocument()
	})

	it('renders thinking collapsed by default and expands on click', () => {
		const events: SindreEvent[] = [
			{ kind: 'thinking', text: 'Let me inspect the workspace members…' },
		]
		render(<SindreTranscript events={events} starting={false} error={null} />)

		const trigger = screen.getByRole('button', { name: /thinking/i })
		expect(trigger).toHaveAttribute('aria-expanded', 'false')
		expect(screen.queryByText(/Let me inspect the workspace members/)).not.toBeInTheDocument()

		fireEvent.click(trigger)

		expect(trigger).toHaveAttribute('aria-expanded', 'true')
		expect(screen.getByText(/Let me inspect the workspace members/)).toBeInTheDocument()
	})

	it('renders the empty state when there are no events', () => {
		render(<SindreTranscript events={[]} starting={false} error={null} />)
		expect(screen.getByText(/Ask Sindre about your workspace/i)).toBeInTheDocument()
	})

	it('renders a connecting indicator while the session is starting', () => {
		render(<SindreTranscript events={[]} starting={true} error={null} />)
		expect(screen.getByText(/Connecting to Sindre/i)).toBeInTheDocument()
	})

	it('renders errors and error results without crashing', () => {
		const events: SindreEvent[] = [
			{ kind: 'error', message: 'Socket closed', data: {} },
			{ kind: 'result', subtype: 'error_max_turns', isError: true, text: 'Out of turns' },
		]
		render(<SindreTranscript events={events} starting={false} error={null} />)

		expect(screen.getByText('Socket closed')).toBeInTheDocument()
		expect(screen.getByText('Out of turns')).toBeInTheDocument()
	})

	it('ignores system, debug, and non-error result envelopes', () => {
		const events: SindreEvent[] = [
			{ kind: 'system', subtype: 'init', data: {} },
			{ kind: 'debug', raw: 'junk' },
			{ kind: 'result', subtype: 'success', isError: false, text: 'done' },
		]
		const { container } = render(<SindreTranscript events={events} starting={false} error={null} />)
		// None of these should produce visible text.
		expect(screen.queryByText('junk')).not.toBeInTheDocument()
		expect(screen.queryByText('done')).not.toBeInTheDocument()
		expect(screen.queryByText('init')).not.toBeInTheDocument()
		// The container still renders an inner flex list but all rows are null.
		expect(container.querySelector('.flex.flex-col.gap-3')).toBeInTheDocument()
	})
})
