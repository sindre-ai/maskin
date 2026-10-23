import { OverviewPane } from '@/components/chat/overview-pane'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/chat/threads-pane', () => ({ ThreadsPane: () => <div>threads body</div> }))
vi.mock('@/components/objects/produced-pane', () => ({
	ProducedPane: () => <div>produced body</div>,
}))
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
	producedCount: 2,
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
	linkedCount: 3,
	linkedFocus: null,
	onFocusConsumed: vi.fn(),
	onJumpToMessage: vi.fn(),
	onClose: vi.fn(),
}

describe('OverviewPane tabs', () => {
	it('offers Linked with its count and renders its body', () => {
		render(<OverviewPane {...props} linkedItems={[...props.linkedItems]} tab="linked" />)
		expect(screen.getByRole('tab', { name: /Linked/ })).toHaveTextContent('3')
		expect(screen.getByText('linked body')).toBeInTheDocument()
	})

	it('offers Threads, Produced, Computers and Linked', () => {
		render(<OverviewPane {...props} linkedItems={[...props.linkedItems]} tab="threads" />)
		expect(screen.getAllByRole('tab').map((t) => t.textContent?.replace(/\d+$/, ''))).toEqual([
			'Threads',
			'Produced',
			'Computers',
			'Linked',
		])
	})

	it('offers a Computers tab with one entry per agent and shows its pane', () => {
		render(<OverviewPane {...props} linkedItems={[...props.linkedItems]} tab="computers" />)
		expect(screen.getByRole('tab', { name: /Computers/ })).toHaveTextContent('2')
		expect(screen.getByText('computers body')).toBeInTheDocument()
	})
})
