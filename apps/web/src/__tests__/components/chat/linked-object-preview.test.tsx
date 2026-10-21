import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const useObject = vi.fn()
const updateMutate = vi.fn()
const sendMutate = vi.fn()
const approveMutate = vi.fn()

vi.mock('@/hooks/use-objects', () => ({
	useObject: (id: string) => useObject(id),
	useUpdateObject: () => ({ mutate: updateMutate, mutateAsync: vi.fn(), error: null }),
	useApproveObject: () => ({ mutate: approveMutate, isPending: false, error: null }),
}))
vi.mock('@/components/shared/file-preview', () => ({
	FilePreview: ({ fileId }: { fileId: string }) => <div data-testid="file-preview">{fileId}</div>,
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

	it('shows the title and text of an object the message links to', async () => {
		useObject.mockReturnValue({ data: objectRow() })
		renderCard()
		await expand()
		expect(screen.getByText('LinkedIn note to Catja')).toBeInTheDocument()
		expect(screen.getByText(/tillykke med fusionen/)).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /Open/ })).toBeInTheDocument()
	})

	it('shows nothing when the message links to no object', () => {
		const { container } = render(<LinkedObjectPreviews workspaceId={WS} content="No links" />)
		expect(container).toBeEmptyDOMElement()
		expect(useObject).not.toHaveBeenCalled()
	})

	it('shows no card for an object an earlier message already shows', () => {
		useObject.mockReturnValue({ data: objectRow() })
		const { container } = render(
			<LinkedObjectPreviews workspaceId={WS} content={CONTENT} skipIds={new Set([ID])} />,
		)
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

	describe('a draft an integration can deliver', () => {
		const preview = (overrides: Record<string, unknown> = {}) => ({
			kind: 'email',
			label: 'Email',
			provider: 'gmail',
			recipients: [{ role: 'to', name: 'Torben Hertel', address: 'th@danfoss.com' }],
			subject: 'Dokumenter efter demoen',
			details: [],
			body: 'Hej Torben, her er dokumenterne.',
			maxLength: null,
			missing: [],
			warnings: [],
			content_hash: 'hash-1',
			delivery: { state: 'draft', at: null },
			...overrides,
		})
		const draft = (
			previewOverrides: Record<string, unknown> = {},
			row: Record<string, unknown> = {},
		) =>
			objectRow({
				title: 'Follow up with Torben',
				content: 'Hej Torben, her er dokumenterne.',
				preview: preview(previewOverrides),
				...row,
			})
		const expandDraft = () => userEvent.click(screen.getByText('Follow up with Torben'))

		it('says what kind of message it is, not that it is a task', () => {
			useObject.mockReturnValue({ data: draft() })
			renderCard()
			expect(screen.getByText('Email')).toBeInTheDocument()
			expect(screen.queryByText('task')).not.toBeInTheDocument()
		})

		it('shows who it goes to and the subject above the text', async () => {
			useObject.mockReturnValue({ data: draft() })
			renderCard()
			await expandDraft()
			expect(screen.getByText('Torben Hertel <th@danfoss.com>')).toBeInTheDocument()
			expect(screen.getByText('Dokumenter efter demoen')).toBeInTheDocument()
		})

		it('approves the exact text on screen and tells the agent what was approved', async () => {
			useObject.mockReturnValue({ data: draft() })
			approveMutate.mockImplementation((_vars, options) => options.onSuccess())
			renderCard({ conversationId: CHAT, agentId: AGENT })
			await expandDraft()
			await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
			expect(approveMutate).toHaveBeenCalledWith(
				{ id: ID, contentHash: 'hash-1' },
				expect.any(Object),
			)
			expect(sendMutate).toHaveBeenCalledTimes(1)
			const message = sendMutate.mock.calls[0][0]
			expect(message.metadata).toEqual({ mentions: [AGENT] })
			expect(message.content).toContain('Approved "Follow up with Torben"')
			expect(message.content).toContain('> Hej Torben, her er dokumenterne.')
		})

		it('can be approved from a card that has no agent to tell', async () => {
			useObject.mockReturnValue({ data: draft() })
			approveMutate.mockImplementation((_vars, options) => options.onSuccess())
			renderCard()
			await expandDraft()
			await userEvent.click(screen.getByRole('button', { name: 'Approve' }))
			expect(approveMutate).toHaveBeenCalledTimes(1)
			expect(sendMutate).not.toHaveBeenCalled()
		})

		it('does not offer a next phase instead of Approve', async () => {
			useObject.mockReturnValue({ data: draft() })
			renderCard({ conversationId: CHAT, agentId: AGENT })
			await expandDraft()
			expect(screen.queryByRole('button', { name: /Move to/ })).not.toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
		})

		it('cannot be approved while something it needs is missing', async () => {
			useObject.mockReturnValue({ data: draft({ missing: ['To'], recipients: [] }) })
			renderCard({ conversationId: CHAT, agentId: AGENT })
			await expandDraft()
			expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
			expect(screen.getByText('Missing: To')).toBeInTheDocument()
		})

		it('shows that it is approved, and that it has been sent, instead of the button', async () => {
			for (const [state, label] of [
				['approved', 'Approved'],
				['sent', 'Sent'],
			] as const) {
				useObject.mockReturnValue({ data: draft({ delivery: { state, at: null } }) })
				const { unmount } = renderCard()
				await expandDraft()
				expect(screen.getByText(label)).toBeInTheDocument()
				expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
				unmount()
			}
		})

		it('shows only the post of a LinkedIn post that carries a header, and where it goes', async () => {
			useObject.mockReturnValue({
				data: draft(
					{
						kind: 'linkedin_post',
						label: 'LinkedIn post',
						recipients: [],
						subject: null,
						details: [{ label: 'Posting as', value: 'sebk_personal' }],
						body: 'Most agent demos fail on the handoff.',
					},
					{
						content:
							'Account: sebk_personal\n\n--- POST ---\nMost agent demos fail on the handoff.\n\n--- MEDIA ---\nnone',
					},
				),
			})
			renderCard({ conversationId: CHAT, agentId: AGENT })
			expect(screen.getByText('LinkedIn post')).toBeInTheDocument()
			await expandDraft()
			expect(screen.getByText('Most agent demos fail on the handoff.')).toBeInTheDocument()
			expect(screen.getByText('sebk_personal')).toBeInTheDocument()
			expect(screen.queryByText(/--- POST ---/)).not.toBeInTheDocument()
		})
	})

	describe('files the message links to', () => {
		const FILE = '5e0c0f3a-1b2c-4d5e-8f90-a1b2c3d4e5f6'

		it('shows a card for a linked file', () => {
			render(
				<LinkedObjectPreviews
					workspaceId={WS}
					content={`The page: https://x.io/${WS}/files/${FILE}`}
				/>,
			)
			expect(screen.getByTestId('file-preview')).toHaveTextContent(FILE)
		})

		it('shows cards for the object and the file when a message links both', () => {
			useObject.mockReturnValue({ data: objectRow() })
			render(
				<LinkedObjectPreviews
					workspaceId={WS}
					content={`Draft /objects/${ID} and page /files/${FILE}`}
				/>,
			)
			expect(screen.getByText('LinkedIn note to Catja')).toBeInTheDocument()
			expect(screen.getByTestId('file-preview')).toBeInTheDocument()
		})
	})
})
