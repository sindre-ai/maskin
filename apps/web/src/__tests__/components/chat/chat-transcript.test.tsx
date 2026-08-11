import { ChatTranscript } from '@/components/chat/chat-transcript'
import type { ChatEvent } from '@/lib/chat-stream'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/api', () => ({
	api: {
		objects: { get: vi.fn() },
		notifications: { respond: vi.fn() },
		files: { get: vi.fn().mockResolvedValue({ name: 'report.pdf', sizeBytes: 2048 }) },
	},
}))

// ObjectReference and AttachedFileCard render tanstack router <Link>, which
// needs a router context jsdom doesn't provide — stub it as a plain anchor.
vi.mock('@tanstack/react-router', () => ({
	Link: (props: Record<string, unknown>) => {
		const { to, children, ...rest } = props
		return (
			<a href={String(to)} {...rest}>
				{children as ReactNode}
			</a>
		)
	},
}))

import { api } from '@/lib/api'

beforeEach(() => {
	vi.clearAllMocks()
})

describe('ChatTranscript', () => {
	it('renders assistant text as markdown (bold, headings)', () => {
		const events: ChatEvent[] = [
			{ kind: 'text', text: '# Hello\n\nSome **bold** text and a [link](https://example.com).' },
		]
		render(<ChatTranscript workspaceId="ws-1" events={events} starting={false} error={null} />)

		expect(screen.getByRole('heading', { name: 'Hello' })).toBeInTheDocument()
		expect(screen.getByText('bold')).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'link' })).toHaveAttribute(
			'href',
			'https://example.com',
		)
	})

	it('renders tool_use as a collapsible block showing name, collapsed by default', () => {
		const events: ChatEvent[] = [
			{
				kind: 'tool_use',
				id: 'tool-1',
				name: 'list_objects',
				input: { type: 'bet', limit: 10 },
			},
		]
		render(<ChatTranscript workspaceId="ws-1" events={events} starting={false} error={null} />)

		const trigger = screen.getByRole('button', { name: /list_objects/i })
		expect(trigger).toHaveAttribute('aria-expanded', 'false')
		// The formatted input JSON should NOT be in the DOM while collapsed.
		expect(screen.queryByText(/"limit": 10/)).not.toBeInTheDocument()
	})

	it('expands tool_use to show formatted input when clicked', () => {
		const events: ChatEvent[] = [
			{
				kind: 'tool_use',
				id: 'tool-1',
				name: 'list_objects',
				input: { type: 'bet', limit: 10 },
			},
		]
		render(<ChatTranscript workspaceId="ws-1" events={events} starting={false} error={null} />)

		fireEvent.click(screen.getByRole('button', { name: /list_objects/i }))

		expect(screen.getByRole('button', { name: /list_objects/i })).toHaveAttribute(
			'aria-expanded',
			'true',
		)
		expect(screen.getByText(/"limit": 10/)).toBeInTheDocument()
		expect(screen.getByText(/"type": "bet"/)).toBeInTheDocument()
	})

	it('renders thinking collapsed by default and expands on click', () => {
		const events: ChatEvent[] = [
			{ kind: 'thinking', text: 'Let me inspect the workspace members…' },
		]
		render(<ChatTranscript workspaceId="ws-1" events={events} starting={false} error={null} />)

		const trigger = screen.getByRole('button', { name: /thinking/i })
		expect(trigger).toHaveAttribute('aria-expanded', 'false')
		expect(screen.queryByText(/Let me inspect the workspace members/)).not.toBeInTheDocument()

		fireEvent.click(trigger)

		expect(trigger).toHaveAttribute('aria-expanded', 'true')
		expect(screen.getByText(/Let me inspect the workspace members/)).toBeInTheDocument()
	})

	it('renders the empty state when there are no events', () => {
		render(<ChatTranscript workspaceId="ws-1" events={[]} starting={false} error={null} />)
		expect(screen.getByText(/Ask the agents about your workspace/i)).toBeInTheDocument()
	})

	it('renders a connecting indicator while the session is starting', () => {
		render(<ChatTranscript workspaceId="ws-1" events={[]} starting={true} error={null} />)
		expect(screen.getByText(/Connecting to agent/i)).toBeInTheDocument()
	})

	it('renders errors and error results without crashing', () => {
		const events: ChatEvent[] = [
			{ kind: 'error', message: 'Socket closed', data: {} },
			{ kind: 'result', subtype: 'error_max_turns', isError: true, text: 'Out of turns' },
		]
		render(<ChatTranscript workspaceId="ws-1" events={events} starting={false} error={null} />)

		expect(screen.getByText('Socket closed')).toBeInTheDocument()
		expect(screen.getByText('Out of turns')).toBeInTheDocument()
	})

	it('hides system and debug envelopes but renders a successful result as a run card', () => {
		const events: ChatEvent[] = [
			{ kind: 'system', subtype: 'init', data: {} },
			{ kind: 'debug', raw: 'junk' },
			{
				kind: 'result',
				subtype: 'success',
				isError: false,
				text: 'done',
				durationMs: 1823,
				numTurns: 2,
			},
		]
		render(<ChatTranscript workspaceId="ws-1" events={events} starting={false} error={null} />)

		expect(screen.queryByText('junk')).not.toBeInTheDocument()
		expect(screen.queryByText('init')).not.toBeInTheDocument()
		// The successful run surfaces as a result card with the real turn metrics.
		expect(screen.getByText('Run')).toBeInTheDocument()
		expect(screen.getByText('success')).toBeInTheDocument()
		expect(screen.getByText('1.8s')).toBeInTheDocument()
		expect(screen.getByText('2 turns')).toBeInTheDocument()
		const bar = screen.getByLabelText('success run: 3% of budget')
		expect(bar).toBeInTheDocument()
		expect(screen.getByText('done')).toBeInTheDocument()
	})

	it('groups user file and object attachments under a YOU ATTACHED label', () => {
		const events: ChatEvent[] = [
			{
				kind: 'user',
				text: '',
				attachments: [
					{ kind: 'file', id: 'f-1', name: 'report.pdf', sizeBytes: 2048 },
					{ kind: 'object', id: 'o-1', title: 'Bet Alpha', type: 'bet' },
				],
			},
		]
		render(
			<TestWrapper>
				<ChatTranscript workspaceId="ws-1" events={events} starting={false} error={null} />
			</TestWrapper>,
		)

		expect(screen.getByText('You attached')).toBeInTheDocument()
		expect(screen.getByText('report.pdf')).toBeInTheDocument()
		expect(screen.getByText('Bet Alpha')).toBeInTheDocument()
	})

	it('renders agent-referenced objects as REFERENCED cards with status', async () => {
		vi.mocked(api.objects.get).mockResolvedValue({
			id: 'o-1',
			title: 'Ship Chats',
			type: 'bet',
			status: 'active',
		} as never)
		const events: ChatEvent[] = [
			{
				kind: 'text',
				text: 'Here’s the bet I meant.',
				attachments: [{ kind: 'object', id: 'o-1', title: 'Ship Chats', type: 'bet' }],
			},
		]
		render(
			<TestWrapper>
				<ChatTranscript workspaceId="ws-1" events={events} starting={false} error={null} />
			</TestWrapper>,
		)

		await waitFor(() => expect(screen.getByText('Referenced')).toBeInTheDocument())
		await waitFor(() => expect(screen.getByText('active')).toBeInTheDocument())
		expect(screen.getByRole('link', { name: /Ship Chats/i })).toBeInTheDocument()
	})

	it('renders open asks as tappable option rows at the end of the transcript', () => {
		const events: ChatEvent[] = [{ kind: 'text', text: 'Checking your options.' }]
		render(
			<TestWrapper>
				<ChatTranscript
					workspaceId="ws-1"
					events={events}
					starting={false}
					error={null}
					asks={[
						{
							id: 'ask-1',
							title: null,
							content: null,
							question: 'Which direction?',
							options: [
								{ label: 'Proceed', value: 'proceed' },
								{ label: 'Hold', value: 'hold' },
							],
							suggestion: null,
							status: 'pending',
							response: null,
						},
					]}
				/>
			</TestWrapper>,
		)

		expect(screen.getByText('Ask')).toBeInTheDocument()
		expect(screen.getByText('Which direction?')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Proceed/i })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Hold/i })).toBeInTheDocument()
	})
})
