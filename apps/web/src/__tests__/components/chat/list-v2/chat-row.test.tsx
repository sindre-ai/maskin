import type { ConversationListItemResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))

import { ChatRow } from '@/components/chat/list-v2/chat-row'

function chat(overrides: Partial<ConversationListItemResponse> = {}): ConversationListItemResponse {
	return {
		id: 'conv-1',
		workspaceId: 'ws-1',
		title: 'Billing retries',
		createdBy: 'me',
		lastMessageAt: new Date().toISOString(),
		createdAt: new Date().toISOString(),
		updatedAt: null,
		pinned: false,
		archived: false,
		unread_count: 0,
		snippet: 'Can you approve the retry window?',
		snippet_actor_id: 'agent-1',
		snippet_actor_name: 'Forge',
		working_actor_ids: [],
		participants: [
			{ actorId: 'me', actorName: 'Me', actorType: 'human', joinedAt: null, addedBy: null },
			{ actorId: 'agent-1', actorName: 'Forge', actorType: 'agent', joinedAt: null, addedBy: null },
		],
		...overrides,
	}
}

function actions() {
	return {
		done: vi.fn(),
		later: vi.fn(),
		retry: vi.fn(),
		markRead: vi.fn(),
		markUnread: vi.fn(),
		togglePinned: vi.fn(),
	}
}

function renderRow(c: ConversationListItemResponse, a = actions()) {
	render(<ChatRow workspaceId="ws-1" conversation={c} actions={a} />, { wrapper: TestWrapper })
	return a
}

describe('ChatRow', () => {
	it('shows agent names, title and the preview with no author prefix', () => {
		renderRow(chat())
		expect(screen.getByText('Forge')).toBeInTheDocument()
		expect(screen.getByText('Billing retries')).toBeInTheDocument()
		expect(screen.getByText('Can you approve the retry window?')).toBeInTheDocument()
		expect(screen.queryByText(/Forge:/)).not.toBeInTheDocument()
	})

	it('puts the unread dot in the gutter and no marker on the preview line', () => {
		renderRow(chat({ unread_count: 2 }))
		expect(screen.getByRole('img', { name: 'Unread' })).toBeInTheDocument()
		expect(screen.queryByRole('img', { name: 'Needs you' })).not.toBeInTheDocument()
	})

	it('shows the red dot and the reason for a chat that stopped, and nothing else on the line', () => {
		renderRow(
			chat({
				needs_you: true,
				working: [{ agent_id: 'agent-1', session_id: 's1' }],
				error: { reason: 'usage_limit', last_person_message_id: 7 },
			}),
		)
		expect(screen.getByText('Stopped. Usage limit reached.')).toBeInTheDocument()
		expect(screen.getByRole('img', { name: 'Stopped, usage limit reached' })).toBeInTheDocument()
		expect(screen.queryByRole('img', { name: 'Needs you' })).not.toBeInTheDocument()
		expect(screen.queryByRole('img', { name: 'Working' })).not.toBeInTheDocument()
	})

	it.each([
		['other', 'Stopped. Something went wrong.'],
		['connection', 'Stopped. Connection dropped.'],
	] as const)('reads the %s reason verbatim', (reason, copy) => {
		renderRow(chat({ error: { reason, last_person_message_id: 1 } }))
		expect(screen.getByText(copy)).toBeInTheDocument()
	})

	it('marks needs you with the amber dot and keeps the question as the preview', () => {
		renderRow(chat({ needs_you: true }))
		expect(screen.getByRole('img', { name: 'Needs you' })).toBeInTheDocument()
		expect(screen.getByText('Can you approve the retry window?')).toBeInTheDocument()
	})

	it('names the working agents on the preview line', () => {
		renderRow(chat({ working: [{ agent_id: 'agent-1', session_id: 's1' }] }))
		expect(screen.getByRole('img', { name: 'Working' })).toBeInTheDocument()
		expect(screen.getByText('Forge is working…')).toBeInTheDocument()
	})

	it('offers Retry first on a stopped chat and runs it from the row', async () => {
		const user = userEvent.setup()
		const a = renderRow(chat({ error: { reason: 'other', last_person_message_id: 3 } }))
		const buttons = screen.getAllByRole('button').map((b) => b.textContent)
		expect(buttons.slice(0, 3)).toEqual(['Retry', 'Done', 'Later'])
		await user.click(screen.getByRole('button', { name: 'Retry' }))
		expect(a.retry).toHaveBeenCalledWith(expect.objectContaining({ id: 'conv-1' }), 'hover')
	})

	it('offers no Retry when the person never wrote in the stopped chat', () => {
		renderRow(chat({ error: { reason: 'other', last_person_message_id: null } }))
		expect(screen.getByText('Stopped. Something went wrong.')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
	})

	it('has no Retry on a chat that did not stop', () => {
		renderRow(chat())
		expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
	})

	it('runs Done and Later from the hover buttons', async () => {
		const user = userEvent.setup()
		const a = renderRow(chat())
		await user.click(screen.getByRole('button', { name: 'Done' }))
		await user.click(screen.getByRole('button', { name: 'Later' }))
		expect(a.done).toHaveBeenCalledWith(expect.objectContaining({ id: 'conv-1' }), 'hover')
		expect(a.later).toHaveBeenCalledWith(expect.objectContaining({ id: 'conv-1' }), 'hover')
	})

	it('reaches Retry, Done, Later, Pin and Read from the ··· menu', async () => {
		const user = userEvent.setup()
		const a = renderRow(
			chat({ unread_count: 1, error: { reason: 'other', last_person_message_id: 3 } }),
		)
		await user.click(screen.getByRole('button', { name: 'Actions for Billing retries' }))
		expect(screen.getByRole('menuitem', { name: 'Retry' })).toBeInTheDocument()
		expect(screen.getByRole('menuitem', { name: 'Pin' })).toBeInTheDocument()
		await user.click(screen.getByRole('menuitem', { name: 'Mark as read' }))
		expect(a.markRead).toHaveBeenCalled()
	})

	it('shows a direct message as the agent name and the preview, with no title line', () => {
		renderRow(chat({ title: 'Some old topic', directPairKey: 'a:me' }))
		expect(screen.queryByText('Direct message')).not.toBeInTheDocument()
		expect(screen.queryByText('Some old topic')).not.toBeInTheDocument()
	})
})
