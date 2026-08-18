import { AssignedInChatRow } from '@/components/loops/assigned-in-chat-row'
import type { ConversationListItemResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', () => ({
	Link: ({
		to,
		params,
		children,
		...rest
	}: {
		to: string
		params?: Record<string, string>
		children: React.ReactNode
		[key: string]: unknown
	}) => {
		let href = to
		for (const [k, v] of Object.entries(params ?? {})) href = href.replace(`$${k}`, v)
		return (
			<a href={href} {...rest}>
				{children}
			</a>
		)
	},
}))

function buildConversation(
	overrides: Partial<ConversationListItemResponse> = {},
): ConversationListItemResponse {
	return {
		id: 'conv-1',
		workspaceId: 'ws-1',
		title: 'Look into the recent churn spike',
		createdBy: 'human-1',
		lastMessageAt: '2026-08-04T00:00:00.000Z',
		createdAt: '2026-08-04T00:00:00.000Z',
		updatedAt: '2026-08-04T00:00:00.000Z',
		pinned: false,
		archived: false,
		unread_count: 0,
		snippet: 'Drafting a summary',
		participants: [],
		...overrides,
	}
}

describe('AssignedInChatRow', () => {
	it('renders the ask, the agent and the last message snippet', () => {
		render(
			<AssignedInChatRow
				conversation={buildConversation()}
				workspaceId="ws-1"
				agentId="actor-1"
				agentName="Compass"
			/>,
		)

		expect(screen.getByText('Look into the recent churn spike')).toBeInTheDocument()
		expect(screen.getByText('Compass')).toBeInTheDocument()
		expect(screen.getByText('Drafting a summary')).toBeInTheDocument()
	})

	it('links back into the conversation it came from', () => {
		render(
			<AssignedInChatRow
				conversation={buildConversation()}
				workspaceId="ws-1"
				agentName="Compass"
			/>,
		)
		expect(screen.getByRole('link')).toHaveAttribute('href', '/ws-1/chats/conv-1')
	})

	it('shows "Working" only while that agent has a live session', () => {
		const { rerender } = render(
			<AssignedInChatRow
				conversation={buildConversation()}
				workspaceId="ws-1"
				agentName="Compass"
			/>,
		)
		expect(screen.getByText('Idle')).toBeInTheDocument()

		rerender(
			<AssignedInChatRow
				conversation={buildConversation()}
				workspaceId="ws-1"
				agentName="Compass"
				isWorking
			/>,
		)
		expect(screen.getByText('Working')).toBeInTheDocument()
	})
})
