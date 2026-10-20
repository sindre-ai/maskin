import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const useObject = vi.fn()
const updateMutate = vi.fn()
const sendMutate = vi.fn()

vi.mock('@/hooks/use-objects', () => ({
	useObject: (id: string) => useObject(id),
	useUpdateObject: () => ({ mutate: updateMutate, mutateAsync: vi.fn(), error: null }),
}))
vi.mock('@/hooks/use-conversation', () => ({
	useSendMessage: () => ({ mutate: sendMutate }),
}))
vi.mock('@/hooks/use-object-type-label', () => ({
	useObjectTypeLabel: () => (type: string) => type,
}))
vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({
		workspace: { settings: { statuses: { task: ['backlog', 'in_review', 'done'] } } },
	}),
}))
vi.mock('@/components/objects/property-selects', () => ({
	StatusSelect: ({
		current,
		options,
		onChange,
	}: {
		current: string
		options: string[]
		onChange: (status: string) => void
	}) => (
		<select aria-label="Status" value={current} onChange={(e) => onChange(e.target.value)}>
			{options.map((o) => (
				<option key={o} value={o}>
					{o}
				</option>
			))}
		</select>
	),
}))
vi.mock('@tanstack/react-router', () => ({
	Link: ({ children, className }: { children: React.ReactNode; className?: string }) => (
		<a href="/x" className={className}>
			{children}
		</a>
	),
}))

import { LinkedObjectPreviews } from '@/components/chat/linked-object-preview'

const ID = 'a7167fde-3f84-42ce-800d-2ba2362944ea'
const WS = 'ws-1'
const CHAT = 'chat-1'
const AGENT = 'agent-1'
const CONTENT = `Draft: /objects/${ID}`

function objectRow(overrides: Record<string, unknown> = {}) {
	return {
		id: ID,
		workspaceId: WS,
		type: 'task',
		title: 'LinkedIn note to Catja',
		status: 'in_review',
		content: 'Hej Catja, tillykke med fusionen.',
		...overrides,
	}
}

function renderCard(props: { conversationId?: string; agentId?: string } = {}) {
	return render(<LinkedObjectPreviews workspaceId={WS} content={CONTENT} {...props} />)
}

describe('LinkedObjectPreviews', () => {
	beforeEach(() => {
		useObject.mockReset()
		updateMutate.mockReset()
		sendMutate.mockReset()
	})

	it('shows the title and text of an object the message links to', () => {
		useObject.mockReturnValue({ data: objectRow() })
		renderCard()
		expect(screen.getByText('LinkedIn note to Catja')).toBeInTheDocument()
		expect(screen.getByText(/tillykke med fusionen/)).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /Open/ })).toBeInTheDocument()
	})

	it('shows nothing when the message links to no object', () => {
		const { container } = render(<LinkedObjectPreviews workspaceId={WS} content="No links" />)
		expect(container).toBeEmptyDOMElement()
		expect(useObject).not.toHaveBeenCalled()
	})

	it('shows nothing for an object from another workspace', () => {
		useObject.mockReturnValue({ data: objectRow({ workspaceId: 'other' }) })
		const { container } = renderCard()
		expect(container).toBeEmptyDOMElement()
	})

	it('shows nothing while loading, when missing, or when the object has no text', () => {
		for (const result of [{ data: undefined }, { data: objectRow({ content: '  ' }) }]) {
			useObject.mockReturnValue(result)
			const { container } = renderCard()
			expect(container).toBeEmptyDOMElement()
		}
	})

	it('folds a long text until Read all is pressed', async () => {
		useObject.mockReturnValue({ data: objectRow({ content: 'word '.repeat(120) }) })
		renderCard()
		await userEvent.click(screen.getByRole('button', { name: 'Read all' }))
		expect(screen.getByRole('button', { name: 'Show less' })).toBeInTheDocument()
	})

	it('is a preview only, with no status menu or Edit, when it has no chat to tell', () => {
		useObject.mockReturnValue({ data: objectRow() })
		renderCard()
		expect(screen.queryByLabelText('Status')).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument()
	})

	it('lists the workspace statuses for the type and moves the object to the chosen one', async () => {
		useObject.mockReturnValue({ data: objectRow() })
		renderCard({ conversationId: CHAT, agentId: AGENT })
		const menu = screen.getByLabelText('Status')
		expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
			'backlog',
			'in_review',
			'done',
		])
		await userEvent.selectOptions(menu, 'done')
		expect(updateMutate).toHaveBeenCalledWith(
			{ id: ID, data: { status: 'done' } },
			expect.any(Object),
		)
	})

	it('tells the agent, with the text as it stands, once the move has saved', async () => {
		useObject.mockReturnValue({ data: objectRow() })
		updateMutate.mockImplementation((_vars, options) => options.onSuccess())
		renderCard({ conversationId: CHAT, agentId: AGENT })
		await userEvent.selectOptions(screen.getByLabelText('Status'), 'done')
		expect(sendMutate).toHaveBeenCalledTimes(1)
		const message = sendMutate.mock.calls[0][0]
		expect(message.metadata).toEqual({ mentions: [AGENT] })
		expect(message.content).toContain('to done')
		expect(message.content).toContain('> Hej Catja, tillykke med fusionen.')
	})

	it('does not tell the agent when the switch is off', async () => {
		useObject.mockReturnValue({ data: objectRow() })
		updateMutate.mockImplementation((_vars, options) => options.onSuccess())
		renderCard({ conversationId: CHAT, agentId: AGENT })
		await userEvent.click(screen.getByRole('switch', { name: 'Tell the agent' }))
		await userEvent.selectOptions(screen.getByLabelText('Status'), 'done')
		expect(updateMutate).toHaveBeenCalled()
		expect(sendMutate).not.toHaveBeenCalled()
	})

	it('does nothing when the chosen status is the current one', async () => {
		useObject.mockReturnValue({ data: objectRow() })
		renderCard({ conversationId: CHAT, agentId: AGENT })
		await userEvent.selectOptions(screen.getByLabelText('Status'), 'in_review')
		expect(updateMutate).not.toHaveBeenCalled()
	})
})
