import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const useObject = vi.fn()
const updateMutate = vi.fn()
const sendMutate = vi.fn()
const approveMutate = vi.fn()

vi.mock('@/hooks/use-objects', () => ({
	useObject: (id: string) => useObject(id),
	useApproveObject: () => ({ mutate: approveMutate, isPending: false, error: null }),
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
	Link: ({
		children,
		className,
		onClick,
	}: {
		children: React.ReactNode
		className?: string
		onClick?: (e: React.MouseEvent) => void
	}) => (
		<a href="/x" className={className} onClick={onClick}>
			{children}
		</a>
	),
}))

import { LinkedObjectPreviews } from '@/components/chat/linked-object-preview'

const ID = 'a7167fde-3f84-42ce-800d-2ba2362944ea'
const WS = 'ws-1'
const CHAT = 'chat-1'
const AGENT = 'agent-1'

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
	return render(<LinkedObjectPreviews workspaceId={WS} objectIds={[ID]} {...props} />)
}

// The card starts contracted; click its top to read the text.
async function expand() {
	await userEvent.click(screen.getByText('LinkedIn note to Catja'))
}

describe('LinkedObjectPreviews', () => {
	beforeEach(() => {
		useObject.mockReset()
		updateMutate.mockReset()
		sendMutate.mockReset()
		approveMutate.mockReset()
	})

	// What the server adds to an object an integration can deliver.
	function previewOf(overrides: Record<string, unknown> = {}) {
		return {
			kind: 'linkedin_message',
			label: 'LinkedIn message',
			provider: 'linkedin-unipile',
			recipients: [],
			subject: null,
			body: 'Hej Catja, tillykke med fusionen.',
			maxLength: 8000,
			missing: [],
			warnings: [],
			content_hash: 'hash-1',
			delivery: { state: 'draft', at: null },
			...overrides,
		}
	}

	it('ends a draft in Approve and send, not the next phase, and tells the agent to send the text', async () => {
		useObject.mockReturnValue({ data: objectRow({ preview: previewOf() }) })
		approveMutate.mockImplementation((_vars, options) => options.onSuccess())
		renderCard({ conversationId: CHAT, agentId: AGENT })
		await expand()
		expect(screen.queryByRole('button', { name: /Move to/ })).not.toBeInTheDocument()
		await userEvent.click(screen.getByRole('button', { name: /Approve and send/ }))
		expect(approveMutate).toHaveBeenCalledWith(
			{ id: ID, contentHash: 'hash-1' },
			expect.any(Object),
		)
		const message = sendMutate.mock.calls[0][0]
		expect(message.metadata).toEqual({ mentions: [AGENT] })
		expect(message.content).toContain(`passing object_id ${ID}`)
		expect(message.content).toContain('> Hej Catja, tillykke med fusionen.')
	})

	it('shows what the draft answers and who it goes to, above the text', async () => {
		useObject.mockReturnValue({
			data: objectRow({
				preview: previewOf({
					context: 'We already have governance and culture.',
					recipients: [{ role: 'to', name: 'Liz Benison', address: null }],
				}),
			}),
		})
		renderCard({ conversationId: CHAT, agentId: AGENT })
		await expand()
		const quoted = screen.getByText('We already have governance and culture.')
		expect(screen.getByText('In reply to')).toBeInTheDocument()
		expect(screen.getByText('Liz Benison')).toBeInTheDocument()
		const text = screen.getByText(/tillykke med fusionen/)
		expect(quoted.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
	})

	it('says so when nobody is filed as the recipient', async () => {
		useObject.mockReturnValue({
			data: objectRow({ preview: previewOf({ warnings: ['To is not filed.'] }) }),
		})
		renderCard({ conversationId: CHAT, agentId: AGENT })
		await expand()
		expect(screen.getByRole('alert')).toHaveTextContent('To is not filed.')
	})

	it('cannot approve a draft that is missing something', async () => {
		useObject.mockReturnValue({
			data: objectRow({ preview: previewOf({ missing: ['Message'] }) }),
		})
		renderCard({ conversationId: CHAT, agentId: AGENT })
		await expand()
		expect(screen.getByRole('button', { name: /Approve and send/ })).toBeDisabled()
	})

	it('shows a sent draft as sent, with nothing left to approve', async () => {
		useObject.mockReturnValue({
			data: objectRow({ preview: previewOf({ delivery: { state: 'sent', at: null } }) }),
		})
		renderCard({ conversationId: CHAT, agentId: AGENT })
		await expand()
		expect(screen.getByText('Sent')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /Approve and send/ })).not.toBeInTheDocument()
	})

	it('shows the title and text of an object the message links to', async () => {
		useObject.mockReturnValue({ data: objectRow() })
		renderCard()
		await expand()
		expect(screen.getByText('LinkedIn note to Catja')).toBeInTheDocument()
		expect(screen.getByText(/tillykke med fusionen/)).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /Open/ })).toBeInTheDocument()
	})

	it('says what the object is about, from its metadata, on the contracted card', () => {
		useObject.mockReturnValue({
			data: objectRow({
				metadata: { source: 'sales_conversation', channel: 'linkedin_dm', priority: 'P1' },
			}),
		})
		renderCard()
		expect(screen.getByText('LinkedIn message · P1')).toBeInTheDocument()
	})

	it('shows nothing when the message links to no object', () => {
		const { container } = render(<LinkedObjectPreviews workspaceId={WS} objectIds={[]} />)
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

	it('is a preview only, with no status menu or next-phase button, when it has no chat to tell', () => {
		useObject.mockReturnValue({ data: objectRow() })
		renderCard()
		expect(screen.queryByLabelText('Status')).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /Move to/ })).not.toBeInTheDocument()
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
		expect(message.content).toContain('to Done')
		expect(message.content).toContain('> Hej Catja, tillykke med fusionen.')
	})

	it('offers the next phase in the workspace order as a button that moves and tells the agent', async () => {
		useObject.mockReturnValue({ data: objectRow() })
		updateMutate.mockImplementation((_vars, options) => options.onSuccess())
		renderCard({ conversationId: CHAT, agentId: AGENT })
		await expand()
		await userEvent.click(screen.getByRole('button', { name: /Move to Done/ }))
		expect(updateMutate).toHaveBeenCalledWith(
			{ id: ID, data: { status: 'done' } },
			expect.any(Object),
		)
		expect(sendMutate).toHaveBeenCalledTimes(1)
	})

	it('has no next-phase button on the last status', async () => {
		useObject.mockReturnValue({ data: objectRow({ status: 'done' }) })
		renderCard({ conversationId: CHAT, agentId: AGENT })
		await expand()
		expect(screen.queryByRole('button', { name: /Move to/ })).not.toBeInTheDocument()
	})

	it('puts Open in the header, above the text', async () => {
		useObject.mockReturnValue({ data: objectRow() })
		renderCard({ conversationId: CHAT, agentId: AGENT })
		await expand()
		const open = screen.getByRole('link', { name: /Open/ })
		const text = screen.getByText(/tillykke med fusionen/)
		expect(open.compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
	})

	it('starts contracted with the title only, and the top toggles the text', async () => {
		useObject.mockReturnValue({ data: objectRow() })
		renderCard({ conversationId: CHAT, agentId: AGENT })
		expect(screen.getByText('LinkedIn note to Catja')).toBeInTheDocument()
		expect(screen.queryByText(/tillykke med fusionen/)).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /Move to/ })).not.toBeInTheDocument()
		await expand()
		expect(screen.getByText(/tillykke med fusionen/)).toBeInTheDocument()
		await userEvent.click(screen.getByText('LinkedIn note to Catja'))
		expect(screen.queryByText(/tillykke med fusionen/)).not.toBeInTheDocument()
	})

	it('does not toggle when the status menu or Open is used', async () => {
		useObject.mockReturnValue({ data: objectRow() })
		renderCard({ conversationId: CHAT, agentId: AGENT })
		await userEvent.selectOptions(screen.getByLabelText('Status'), 'done')
		await userEvent.click(screen.getByRole('link', { name: /Open/ }))
		expect(screen.queryByText(/tillykke med fusionen/)).not.toBeInTheDocument()
	})

	it('does nothing when the chosen status is the current one', async () => {
		useObject.mockReturnValue({ data: objectRow() })
		renderCard({ conversationId: CHAT, agentId: AGENT })
		await userEvent.selectOptions(screen.getByLabelText('Status'), 'in_review')
		expect(updateMutate).not.toHaveBeenCalled()
	})
})
