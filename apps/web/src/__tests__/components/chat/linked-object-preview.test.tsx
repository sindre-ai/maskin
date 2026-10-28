import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const useObject = vi.fn()
const updateMutate = vi.fn()
const approveMutate = vi.fn()

vi.mock('@/hooks/use-objects', () => ({
	useObject: (id: string) => useObject(id),
	useApproveObject: () => ({ mutate: approveMutate, isPending: false, error: null }),
	useUpdateObject: () => ({ mutate: updateMutate, mutateAsync: vi.fn(), error: null }),
}))
vi.mock('@/components/shared/file-preview', () => ({
	FilePreview: ({ fileId }: { fileId: string }) => <div data-testid="file-preview">{fileId}</div>,
	isPreviewableFile: (mime: string) =>
		/^(text\/|image\/(png|jpeg|gif|webp))/.test(mime) || mime === 'application/xhtml+xml',
}))
const useFiles = vi.fn()
vi.mock('@/hooks/use-files', () => ({
	useFiles: (...args: unknown[]) => useFiles(...args),
}))
vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [{ id: 'actor-1', name: 'Developer', type: 'agent' }] }),
}))
vi.mock('@/hooks/use-object-type-label', () => ({
	useObjectTypeLabel: () => (type: string) => type,
}))
vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({
		workspace: {
			settings: {
				statuses: { task: ['backlog', 'in_review', 'done'] },
				field_definitions: { task: [{ name: 'priority', type: 'enum' }] },
			},
		},
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

import { LinkedCardOrLink, LinkedObjectCard } from '@/components/chat/linked-object-preview'
import { LinkedPanelContext } from '@/components/chat/linked-panel-context'

const ID = 'a7167fde-3f84-42ce-800d-2ba2362944ea'
const WS = 'ws-1'
const CHAT = 'chat-1'
const AGENT = 'agent-1'
// What the card sends along so the server tells the agent; nothing is posted in the chat.
const CARD = { conversation_id: CHAT, agent_id: AGENT }

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
	return render(<LinkedObjectCard workspaceId={WS} objectId={ID} {...props} />)
}

const DRAFT_PREVIEW = {
	kind: 'email',
	label: 'Email',
	provider: 'gmail',
	recipients: [],
	subject: 'Hello',
	details: [],
	body: 'Hej Catja, tillykke med fusionen.',
	maxLength: null,
	missing: [],
	warnings: [],
	content_hash: 'hash-0',
	delivery: { state: 'draft', at: null },
}

// The card starts contracted; click its top to read the text.
async function expand() {
	await userEvent.click(screen.getByText('LinkedIn note to Catja'))
}

describe('LinkedObjectCard', () => {
	beforeEach(() => {
		useObject.mockReset()
		updateMutate.mockReset()
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

	it('ends a draft in Approve draft, not the next phase, and names the chat so the server tells the agent', async () => {
		useObject.mockReturnValue({ data: objectRow({ preview: previewOf() }) })
		renderCard({ conversationId: CHAT, agentId: AGENT })
		await expand()
		expect(screen.queryByRole('button', { name: /Move to/ })).not.toBeInTheDocument()
		await userEvent.click(screen.getByRole('button', { name: /Approve draft/ }))
		expect(approveMutate).toHaveBeenCalledWith({ id: ID, contentHash: 'hash-1', chat: CARD })
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
		expect(screen.getByRole('button', { name: /Approve draft/ })).toBeDisabled()
	})

	it('shows a sent draft as sent, with nothing left to approve', async () => {
		useObject.mockReturnValue({
			data: objectRow({ preview: previewOf({ delivery: { state: 'sent', at: null } }) }),
		})
		renderCard({ conversationId: CHAT, agentId: AGENT })
		await expand()
		expect(screen.getByText('Sent')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /Approve draft/ })).not.toBeInTheDocument()
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
		// The chat rides along with the move: the server tells the agent, no message is posted.
		expect(updateMutate).toHaveBeenCalledWith({ id: ID, data: { status: 'done', chat: CARD } })
	})

	it('offers the next phase in the workspace order as a button that moves and tells the agent', async () => {
		useObject.mockReturnValue({ data: objectRow() })
		renderCard({ conversationId: CHAT, agentId: AGENT })
		await expand()
		await userEvent.click(screen.getByRole('button', { name: /Move to Done/ }))
		expect(updateMutate).toHaveBeenCalledWith({ id: ID, data: { status: 'done', chat: CARD } })
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

		it('approves the exact text on screen and names the chat whose agent sends it', async () => {
			useObject.mockReturnValue({ data: draft() })
			renderCard({ conversationId: CHAT, agentId: AGENT })
			await expandDraft()
			await userEvent.click(screen.getByRole('button', { name: 'Approve draft' }))
			expect(approveMutate).toHaveBeenCalledWith({ id: ID, contentHash: 'hash-1', chat: CARD })
		})

		it('cannot be approved from a card that has no agent to tell', async () => {
			useObject.mockReturnValue({ data: draft() })
			renderCard()
			await expandDraft()
			expect(screen.getByRole('button', { name: 'Approve draft' })).toBeDisabled()
			expect(approveMutate).not.toHaveBeenCalled()
		})

		it('does not offer a next phase instead of Approve draft', async () => {
			useObject.mockReturnValue({ data: draft() })
			renderCard({ conversationId: CHAT, agentId: AGENT })
			await expandDraft()
			expect(screen.queryByRole('button', { name: /Move to/ })).not.toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Approve draft' })).toBeInTheDocument()
		})

		it('cannot be approved while something it needs is missing', async () => {
			useObject.mockReturnValue({ data: draft({ missing: ['To'], recipients: [] }) })
			renderCard({ conversationId: CHAT, agentId: AGENT })
			await expandDraft()
			expect(screen.getByRole('button', { name: 'Approve draft' })).toBeDisabled()
			expect(screen.getByText('Missing: To')).toBeInTheDocument()
		})

		it('shows that it is approved, and that it has been sent, instead of the button', async () => {
			for (const [state, label] of [
				['approved', 'Approved, waiting for send'],
				['sent', 'Sent'],
			] as const) {
				useObject.mockReturnValue({ data: draft({ delivery: { state, at: null } }) })
				const { unmount } = renderCard()
				await expandDraft()
				expect(screen.getByText(label)).toBeInTheDocument()
				expect(screen.queryByRole('button', { name: 'Approve draft' })).not.toBeInTheDocument()
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

	describe('a draft longer than the clamp', () => {
		const CLAMP = 304
		let heights: { scroll: number }
		const longDraft = (hash = 'hash-1') =>
			objectRow({
				title: 'Follow up with Torben',
				content: 'Hej Torben, her er dokumenterne.',
				preview: {
					...DRAFT_PREVIEW,
					body: 'Hej Torben, her er dokumenterne.',
					content_hash: hash,
				},
			})
		const expandDraft = () => userEvent.click(screen.getByText('Follow up with Torben'))
		const approveButton = () => screen.getByRole('button', { name: 'Approve draft' })

		// jsdom has no layout: say how tall the text is against the clamp.
		beforeEach(() => {
			heights = { scroll: CLAMP + 200 }
			vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(
				() => heights.scroll,
			)
			vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(CLAMP)
		})
		afterEach(() => vi.restoreAllMocks())

		it('disables Approve draft with a hint until Show all is used, then approves', async () => {
			useObject.mockReturnValue({ data: longDraft() })
			renderCard({ conversationId: CHAT, agentId: AGENT })
			await expandDraft()
			expect(approveButton()).toBeDisabled()
			expect(screen.getByText('Read the full draft first')).toBeInTheDocument()
			await userEvent.click(approveButton())
			expect(approveMutate).not.toHaveBeenCalled()

			await userEvent.click(screen.getByRole('button', { name: 'Show all' }))
			expect(approveButton()).toBeEnabled()
			expect(screen.queryByText('Read the full draft first')).not.toBeInTheDocument()
			await userEvent.click(approveButton())
			expect(approveMutate).toHaveBeenCalledWith({ id: ID, contentHash: 'hash-1', chat: CARD })
		})

		it('gates again after Show less', async () => {
			useObject.mockReturnValue({ data: longDraft() })
			renderCard({ conversationId: CHAT, agentId: AGENT })
			await expandDraft()
			await userEvent.click(screen.getByRole('button', { name: 'Show all' }))
			await userEvent.click(screen.getByRole('button', { name: 'Show less' }))
			expect(approveButton()).toBeDisabled()
		})

		it('gates again when the text changes after it was opened in full', async () => {
			useObject.mockReturnValue({ data: longDraft('hash-1') })
			const { rerender } = renderCard({ conversationId: CHAT, agentId: AGENT })
			await expandDraft()
			await userEvent.click(screen.getByRole('button', { name: 'Show all' }))
			expect(approveButton()).toBeEnabled()
			useObject.mockReturnValue({ data: longDraft('hash-2') })
			rerender(
				<LinkedObjectCard workspaceId={WS} objectId={ID} conversationId={CHAT} agentId={AGENT} />,
			)
			expect(approveButton()).toBeDisabled()
		})

		it('has no gate and no Show all when the draft fits', async () => {
			heights.scroll = CLAMP
			useObject.mockReturnValue({ data: longDraft() })
			renderCard({ conversationId: CHAT, agentId: AGENT })
			await expandDraft()
			expect(approveButton()).toBeEnabled()
			expect(screen.queryByRole('button', { name: 'Show all' })).not.toBeInTheDocument()
			expect(screen.queryByText('Read the full draft first')).not.toBeInTheDocument()
		})

		it('keeps no scroll box around the text', async () => {
			useObject.mockReturnValue({ data: longDraft() })
			const { container } = renderCard({ conversationId: CHAT, agentId: AGENT })
			await expandDraft()
			expect(container.querySelector('.overflow-y-auto')).toBeNull()
		})
	})

	describe('Show in panel', () => {
		it('is not offered without a panel to show it in', () => {
			useObject.mockReturnValue({ data: objectRow() })
			renderCard()
			expect(screen.queryByRole('button', { name: 'Show in panel' })).not.toBeInTheDocument()
		})

		it('asks the panel to show the object, without toggling the card', async () => {
			useObject.mockReturnValue({ data: objectRow() })
			const openLinked = vi.fn()
			render(
				<LinkedPanelContext.Provider value={{ openLinked }}>
					<LinkedObjectCard workspaceId={WS} objectId={ID} />
				</LinkedPanelContext.Provider>,
			)
			await userEvent.click(screen.getByRole('button', { name: 'Show in panel' }))
			expect(openLinked).toHaveBeenCalledWith({ kind: 'object', id: ID })
			expect(screen.queryByText(/tillykke med fusionen/)).not.toBeInTheDocument()
		})
	})
})

describe('LinkedCardOrLink', () => {
	const FILE = '5e0c0f3a-1b2c-4d5e-8f90-a1b2c3d4e5f6'
	const link = <a href="/x">the original link</a>
	const renderObject = () =>
		render(
			<LinkedCardOrLink workspaceId={WS} target={{ kind: 'object', id: ID }} fallback={link} />,
		)

	beforeEach(() => {
		useObject.mockReset()
		useFiles.mockReset()
		useFiles.mockReturnValue({ data: undefined })
	})

	it('shows a skeleton while the object loads, and says the object was deleted when it is missing or elsewhere', () => {
		useObject.mockReturnValue({ data: undefined, isLoading: true })
		const loading = renderObject()
		expect(loading.container.querySelector('[aria-busy="true"]')).not.toBeNull()
		loading.unmount()
		for (const result of [
			{ data: undefined, isLoading: false },
			{ data: objectRow({ workspaceId: 'other' }), isLoading: false },
		]) {
			useObject.mockReturnValue(result)
			const { unmount } = renderObject()
			expect(screen.getByText('This object was deleted')).toBeInTheDocument()
			expect(screen.queryByText('the original link')).not.toBeInTheDocument()
			unmount()
		}
	})

	it('draws any other object as a reference card: type, status, priority, title, text and owner', () => {
		useObject.mockReturnValue({
			data: objectRow({
				title: 'Ship the card',
				status: 'in_review',
				content: '## Plan\n\nDo **the thing** with [a link](https://x.test).',
				metadata: { priority: 'P2' },
				driver: 'actor-1',
				updatedAt: new Date().toISOString(),
				active_session_state: 'running',
			}),
			isLoading: false,
		})
		renderObject()
		const card = screen.getByRole('link')
		expect(card).toHaveTextContent('Ship the card')
		expect(card).toHaveTextContent('Plan Do the thing with a link.')
		expect(card).toHaveTextContent('P2')
		expect(card).toHaveTextContent('Developer')
		expect(card).toHaveTextContent('Working now')
		expect(screen.queryByText('the original link')).not.toBeInTheDocument()
	})

	it('says Unassigned, and leaves out the text row and Working now, when there is nothing to show', () => {
		useObject.mockReturnValue({
			data: objectRow({ content: null, driver: null, active_session_state: null }),
			isLoading: false,
		})
		renderObject()
		const card = screen.getByRole('link')
		expect(card).toHaveTextContent('Unassigned')
		expect(card).not.toHaveTextContent('Working now')
	})

	it('keeps the link of a list item unless the object is a draft', () => {
		useObject.mockReturnValue({ data: objectRow(), isLoading: false })
		render(
			<LinkedCardOrLink
				workspaceId={WS}
				target={{ kind: 'object', id: ID }}
				fallback={link}
				inList
			/>,
		)
		expect(screen.getByText('the original link')).toBeInTheDocument()
	})

	it('replaces the link by the approval card for a draft, in a paragraph or a list', () => {
		useObject.mockReturnValue({ data: objectRow({ preview: DRAFT_PREVIEW }) })
		renderObject()
		expect(screen.queryByText('the original link')).not.toBeInTheDocument()
		expect(screen.getByText('LinkedIn note to Catja')).toBeInTheDocument()
	})

	it('keeps the link for a file that is loading or not previewable, and replaces it for a page', () => {
		const file = (
			<LinkedCardOrLink workspaceId={WS} target={{ kind: 'file', id: FILE }} fallback={link} />
		)
		for (const data of [
			undefined,
			[{ id: FILE, name: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 1 }],
		]) {
			useFiles.mockReturnValue({ data })
			const { unmount } = render(file)
			expect(screen.getByText('the original link')).toBeInTheDocument()
			unmount()
		}
		useFiles.mockReturnValue({
			data: [{ id: FILE, name: 'page.html', mimeType: 'text/html', sizeBytes: 1 }],
		})
		render(file)
		expect(screen.queryByText('the original link')).not.toBeInTheDocument()
		expect(screen.getByTestId('file-preview')).toBeInTheDocument()
	})
})
