import { LinkedPane } from '@/components/chat/linked-pane'
import type { LinkedItem } from '@/hooks/use-conversation-linked'
import type { ProducedFileItem, ProducedObjectItem } from '@/hooks/use-conversation-produced'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const objects: Record<string, unknown> = {}
vi.mock('@/hooks/use-objects', () => ({
	useObject: (id: string) => ({ data: objects[id], isLoading: false }),
}))
vi.mock('@/components/chat/linked-object-preview', () => ({
	LinkedObjectCard: (p: { objectId: string; agentId?: string; defaultExpanded?: boolean }) => (
		<div data-testid="card" data-agent={p.agentId} data-expanded={String(!!p.defaultExpanded)}>
			{p.objectId}
		</div>
	),
}))
vi.mock('@/components/objects/produced-pane', () => ({
	ProducedObjectsGroup: ({ items }: { items: Array<{ entityId: string }> }) => (
		<div data-testid="produced-objects">{items.map((i) => i.entityId).join(',')}</div>
	),
	ProducedFilesGroup: ({ items }: { items: Array<{ fileId: string }> }) => (
		<div data-testid="produced-files">{items.map((i) => i.fileId).join(',')}</div>
	),
}))
vi.mock('@/components/shared/object-reference', () => ({
	ObjectReference: ({ objectId }: { objectId: string }) => <div data-testid="row">{objectId}</div>,
}))
vi.mock('@/components/shared/file-preview', () => ({
	FilePreview: ({ fileId }: { fileId: string }) => <div data-testid="file">{fileId}</div>,
}))

const item = (over: Partial<LinkedItem>): LinkedItem => ({
	kind: 'object',
	id: 'o1',
	messageId: 7,
	actorId: 'agent-1',
	actorName: 'Scout',
	actorType: 'agent',
	createdAt: '2026-10-21T10:00:00Z',
	...over,
})

const base = {
	workspaceId: 'ws',
	conversationId: 'c1',
	producedObjects: [] as ProducedObjectItem[],
	producedFiles: [] as ProducedFileItem[],
	producedLoading: false,
	focus: null,
	onFocusConsumed: vi.fn(),
	onJumpToMessage: vi.fn(),
}

describe('LinkedPane', () => {
	beforeEach(() => {
		for (const k of Object.keys(objects)) delete objects[k]
		base.onJumpToMessage.mockClear()
		base.onFocusConsumed.mockClear()
	})

	it('shows the empty state when nothing is linked', () => {
		render(<LinkedPane {...base} items={[]} />)
		expect(screen.getByText('Nothing here yet')).toBeInTheDocument()
	})

	it('labels each item with its type', () => {
		objects.o2 = { id: 'o2', type: 'contact', workspaceId: 'ws', preview: null }
		render(<LinkedPane {...base} items={[item({ id: 'o2' }), item({ kind: 'file', id: 'f1' })]} />)
		expect(screen.getByText('contact')).toBeInTheDocument()
		expect(screen.getByText('file')).toBeInTheDocument()
	})

	it('adds produced items that no message links to, once', () => {
		objects.o2 = { id: 'o2', workspaceId: 'ws', preview: null }
		render(
			<LinkedPane
				{...base}
				items={[item({ id: 'o2' })]}
				producedObjects={[{ entityId: 'o2' }, { entityId: 'o9' }] as ProducedObjectItem[]}
				producedFiles={[{ fileId: 'f9' }] as ProducedFileItem[]}
			/>,
		)
		expect(screen.getByTestId('produced-objects')).toHaveTextContent('o9')
		expect(screen.getByTestId('produced-objects')).not.toHaveTextContent('o2')
		expect(screen.getByTestId('produced-files')).toHaveTextContent('f9')
	})

	it('draws a draft as a card with the writing agent', () => {
		objects.o1 = { id: 'o1', workspaceId: 'ws', content: 'x', preview: { body: 'x' } }
		render(<LinkedPane {...base} items={[item({})]} />)
		expect(screen.getByTestId('card')).toHaveAttribute('data-agent', 'agent-1')
		expect(screen.getByText(/from Scout/)).toBeInTheDocument()
	})

	it('draws a contact as a compact row', () => {
		objects.o2 = { id: 'o2', workspaceId: 'ws', preview: null }
		render(<LinkedPane {...base} items={[item({ id: 'o2' })]} />)
		expect(screen.getByTestId('row')).toBeInTheDocument()
		expect(screen.queryByTestId('card')).toBeNull()
	})

	it('draws a file as a preview', () => {
		render(<LinkedPane {...base} items={[item({ kind: 'file', id: 'f1' })]} />)
		expect(screen.getByTestId('file')).toHaveTextContent('f1')
	})

	it('does not expand a card when no focus is requested', () => {
		objects.o1 = { id: 'o1', workspaceId: 'ws', content: 'x', preview: { body: 'x' } }
		render(<LinkedPane {...base} items={[item({})]} />)
		expect(screen.getByTestId('card')).toHaveAttribute('data-expanded', 'false')
		expect(base.onFocusConsumed).not.toHaveBeenCalled()
	})

	it('jumps to the linking message', async () => {
		objects.o2 = { id: 'o2', workspaceId: 'ws', preview: null }
		render(<LinkedPane {...base} items={[item({ id: 'o2', messageId: 42 })]} />)
		await userEvent.click(screen.getByRole('button', { name: 'Jump to message' }))
		expect(base.onJumpToMessage).toHaveBeenCalledWith(42)
	})

	it('highlights and expands the focused item, then clears the ring', () => {
		vi.useFakeTimers()
		objects.o1 = { id: 'o1', workspaceId: 'ws', content: 'x', preview: { body: 'x' } }
		render(
			<LinkedPane {...base} items={[item({})]} focus={{ kind: 'object', id: 'o1', nonce: 1 }} />,
		)
		const li = screen.getByTestId('card').closest('li')
		expect(li).toHaveAttribute('data-highlighted', 'true')
		expect(screen.getByTestId('card')).toHaveAttribute('data-expanded', 'true')
		act(() => {
			vi.advanceTimersByTime(2100)
		})
		expect(li).not.toHaveAttribute('data-highlighted')
		// The request is handed back once, and the card stays open after the ring is gone.
		expect(base.onFocusConsumed).toHaveBeenCalledTimes(1)
		expect(screen.getByTestId('card')).toHaveAttribute('data-expanded', 'true')
		vi.useRealTimers()
	})
})
