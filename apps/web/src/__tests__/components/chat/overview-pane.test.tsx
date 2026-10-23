import { OverviewPane } from '@/components/chat/overview-pane'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/chat/threads-pane', () => ({ ThreadsPane: () => <div>threads body</div> }))
vi.mock('@/components/chat/computers-pane', () => ({
	ComputersPane: () => <div>computers body</div>,
}))
vi.mock('@/components/chat/linked-pane', () => ({ LinkedPane: () => <div>linked body</div> }))

const props = {
	workspaceId: 'ws',
	conversationId: 'c1',
	onTabChange: vi.fn(),
	threadsCount: 1,
	computersCount: 2,
	openSessionId: null,
	onOpenSession: vi.fn(),
	producedObjects: [],
	producedFiles: [],
	producedLoading: false,
	linkedItems: [
		{
			kind: 'object',
			id: 'a',
			messageId: 1,
			actorId: 'x',
			actorName: 'X',
			actorType: 'agent',
			createdAt: null,
		},
		{
			kind: 'file',
			id: 'b',
			messageId: 1,
			actorId: 'x',
			actorName: 'X',
			actorType: 'agent',
			createdAt: null,
		},
		{
			kind: 'file',
			id: 'c',
			messageId: 1,
			actorId: 'x',
			actorName: 'X',
			actorType: 'agent',
			createdAt: null,
		},
	] as const,
	linkedFocus: null,
	onFocusConsumed: vi.fn(),
	onJumpToMessage: vi.fn(),
	onClose: vi.fn(),
}

describe('OverviewPane tabs', () => {
	it('offers Items with its count and renders linked and produced items in one body', () => {
		render(<OverviewPane {...props} linkedItems={[...props.linkedItems]} tab="produced" />)
		expect(screen.getByRole('tab', { name: /Items/ })).toHaveTextContent('3')
		expect(screen.getByText('linked body')).toBeInTheDocument()
	})

	it('offers Threads, Items and Computers', () => {
		render(<OverviewPane {...props} linkedItems={[...props.linkedItems]} tab="threads" />)
		expect(screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual([
			'Threads',
			'Items',
			'Computers',
		])
	})

	it('offers a Computers tab with one entry per agent and shows its pane', () => {
		render(<OverviewPane {...props} linkedItems={[...props.linkedItems]} tab="computers" />)
		expect(screen.getByRole('tab', { name: /Computers/ })).toHaveTextContent('2')
		expect(screen.getByText('computers body')).toBeInTheDocument()
	})
})
