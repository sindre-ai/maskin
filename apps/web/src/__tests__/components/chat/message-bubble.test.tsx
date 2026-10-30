import type { MessageResponse } from '@/lib/api'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const workspaceState = vi.hoisted(() => ({ enterprise: false }))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({
		workspace: {
			enterprise: workspaceState.enterprise,
			settings: { statuses: { bet: ['active', 'done'] } },
		},
	}),
	useIsEnterpriseWorkspace: () => workspaceState.enterprise,
}))

vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))

vi.mock('@/hooks/use-linked-chat', () => ({
	useLinkedChat: (_ws: string, id: string) => ({
		id,
		title: 'Launch plan',
		pinned: false,
		archived: false,
		updatedAt: null,
		participants: [],
		lastMessage: null,
	}),
}))

vi.mock('@/hooks/use-objects', () => ({
	useObject: () => ({
		data: {
			id: 'obj-1',
			workspaceId: 'ws-1',
			type: 'bet',
			title: 'Retry window',
			status: 'active',
			content: 'The retry window text.',
			metadata: { channel: 'linkedin_dm', priority: 'P1' },
			// A draft an integration can deliver: only those get a card in chat.
			preview: {
				kind: 'linkedin_message',
				label: 'LinkedIn message',
				provider: 'linkedin-unipile',
				recipients: [],
				subject: null,
				details: [],
				body: 'The retry window text.',
				maxLength: null,
				missing: [],
				warnings: [],
				content_hash: 'hash-1',
				delivery: { state: 'draft', at: null },
			},
		},
		isLoading: false,
	}),
	useUpdateObject: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), error: null }),
	useApproveObject: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}))

const retryMutate = vi.fn()
vi.mock('@/hooks/use-conversation', () => ({
	useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
	useRetryMessage: () => ({ mutate: retryMutate, isPending: false }),
	useSendMessage: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/hooks/use-object-type-label', () => ({
	useObjectTypeLabel: () => (type: string) => type,
}))

vi.mock('@/hooks/use-actors', async () => {
	const actual = await vi.importActual<typeof import('@/hooks/use-actors')>('@/hooks/use-actors')
	return { ...actual, useActors: () => ({ data: [] }) }
})

const mockUseFiles = vi.fn((_workspaceId: string, _params?: { ids?: string[] }) => ({
	data: [] as unknown[],
}))
vi.mock('@/hooks/use-files', () => ({
	useFiles: (workspaceId: string, params?: { ids?: string[] }) => mockUseFiles(workspaceId, params),
	useFile: (_workspaceId: string, id: string | null) => ({
		data: id?.startsWith('img')
			? { id, name: 'shot.png', mimeType: 'image/png', encoding: 'base64', content: 'iVBORw0KGgo=' }
			: undefined,
		isError: false,
	}),
}))

const flagState = vi.hoisted(() => ({ lifted: false }))
vi.mock('@/hooks/use-feature-flag', () => ({
	useFeatureFlag: (id: string) => id === 'chat-attachments-lifted' && flagState.lifted,
}))

import { MessageBubble } from '@/components/chat/message-bubble'

function buildMessage(overrides: Partial<MessageResponse> = {}): MessageResponse {
	return {
		id: 1,
		conversationId: 'conv-1',
		actorId: 'agent-1',
		actorName: 'Billing Agent',
		actorType: 'agent',
		kind: 'message',
		content: 'Here is what I found.',
		metadata: null,
		editedAt: null,
		sessionId: null,
		createdAt: new Date().toISOString(),
		...overrides,
	}
}

function renderBubble(message: MessageResponse) {
	return render(<MessageBubble workspaceId="ws-1" message={message} />, {
		wrapper: TestWrapper,
	})
}

const CHART_MESSAGE = [
	'Signup completion by step:',
	'',
	'```chart',
	JSON.stringify({
		type: 'bar',
		x: 'step',
		series: ['completed'],
		data: [{ step: 'Email', completed: 820 }],
		caption: 'Drop-off concentrates on step two.',
	}),
	'```',
].join('\n')

describe('MessageBubble', () => {
	it('shows the card of a linked object right after the paragraph that links it', () => {
		const id = 'a7167fde-3f84-42ce-800d-2ba2362944ea'
		renderBubble(
			buildMessage({
				content: `Before the link.\n\nThe draft is [here](/ws-1/objects/${id}) for you.\n\nAfter the link.`,
			}),
		)
		const before = screen.getByText('Before the link.')
		// A draft starts open, so its title (not the contracted subtitle) marks the card.
		const card = screen.getByText('Retry window')
		const after = screen.getByText('After the link.')
		expect(before.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(card.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
	})

	it('renders an own message as an ink plate with no avatar or name', () => {
		renderBubble(buildMessage({ actorId: 'me', actorName: 'Me', actorType: 'human' }))
		const body = screen.getByText('Here is what I found.')
		expect(body.parentElement?.className).toContain('bg-primary')
		expect(screen.queryByText('Me')).not.toBeInTheDocument()
	})

	describe('a link to an object in your own message', () => {
		const id = 'a7167fde-3f84-42ce-800d-2ba2362944ea'
		const address = `https://maskin.io/ws-1/objects/${id}`

		it('is a chip inside the sentence, in the same plate, opening in a new tab', () => {
			const { container } = renderBubble(
				buildMessage({
					actorId: 'me',
					actorName: 'Me',
					actorType: 'human',
					content: `is this done? ${address} thanks`,
				}),
			)
			expect(screen.queryByText(address, { exact: false })).not.toBeInTheDocument()
			const chip = screen.getByRole('link', { name: /Retry window/ })
			const plate = container.querySelector('.bg-primary')
			expect(plate).toContainElement(chip)
			expect(plate?.textContent).toContain('is this done?')
			expect(plate?.textContent).toContain('thanks')
			expect(chip).toHaveAttribute('target', '_blank')
			expect(container.querySelector('[data-linked-card]')).toBeNull()
		})

		it('is a card nested under the words in the same plate when it stands on its own line', () => {
			const { container } = renderBubble(
				buildMessage({
					actorId: 'me',
					actorName: 'Me',
					actorType: 'human',
					content: `is this done?\n${address}`,
				}),
			)
			const plate = container.querySelector('.bg-primary')
			const card = container.querySelector('[data-linked-card]')
			expect(card).not.toBeNull()
			expect(plate).toContainElement(card as HTMLElement)
			expect(plate?.textContent).toContain('is this done?')
			expect(card).toHaveTextContent('Retry window')
			expect(card?.querySelector('a')).toHaveAttribute('target', '_blank')
			expect(screen.queryByText(address, { exact: false })).not.toBeInTheDocument()
		})

		it('is the message itself, with no plate, when the message is only the link', () => {
			const { container } = renderBubble(
				buildMessage({
					actorId: 'me',
					actorName: 'Me',
					actorType: 'human',
					content: address,
				}),
			)
			expect(container.querySelector('[data-linked-card]')).not.toBeNull()
			expect(container.querySelector('.bg-primary')).toBeNull()
		})

		it('sets the width by what the message holds: a bubble with a card is min(520px, 88%), a lone card up to 460px, words fit their text', () => {
			const holder = (content: string) => {
				const { container } = renderBubble(
					buildMessage({ actorId: 'me', actorName: 'Me', actorType: 'human', content }),
				)
				return container.querySelector('[data-linked-card]')?.parentElement?.closest('.relative') ?? null
			}
			expect(holder(`is this done?\n${address}`)).toHaveClass('w-[min(520px,88%)]')
			cleanup()
			expect(holder(address)).toHaveClass('w-full', 'max-w-[460px]')
			cleanup()
			const { container } = renderBubble(
				buildMessage({ actorId: 'me', actorName: 'Me', actorType: 'human', content: 'just words' }),
			)
			const words = container.querySelector('.bg-primary')?.parentElement
			expect(words).not.toHaveClass('w-[min(520px,88%)]')
			expect(words).not.toHaveClass('max-w-[460px]')
		})
	})

	it('draws a GitHub pull request and issue in your own message as chips that open GitHub', () => {
		const pull = 'https://github.com/sindre-ai/maskin/pull/2637'
		const { container } = renderBubble(
			buildMessage({
				actorId: 'me',
				actorName: 'Me',
				actorType: 'human',
				content: `can you check ${pull} and https://github.com/sindre-ai/maskin/issues/12?`,
			}),
		)
		expect(screen.queryByText(pull, { exact: false })).not.toBeInTheDocument()
		const pullChip = screen.getByRole('link', { name: 'Pull request maskin #2637, opens GitHub' })
		expect(pullChip).toHaveAttribute('href', pull)
		expect(pullChip).toHaveAttribute('target', '_blank')
		expect(screen.getByRole('link', { name: 'Issue maskin #12, opens GitHub' })).toBeInTheDocument()
		expect(container.querySelector('.bg-primary')).toContainElement(pullChip)
	})

	it('draws a settings address in your own message as a settings chip that opens in a new tab', () => {
		const address = 'https://maskin.io/ws-1/settings/billing'
		const { container } = renderBubble(
			buildMessage({
				actorId: 'me',
				actorName: 'Me',
				actorType: 'human',
				content: `pay here ${address}`,
			}),
		)
		expect(screen.queryByText(address, { exact: false })).not.toBeInTheDocument()
		const chip = screen.getByRole('link', { name: 'Settings: Billing' })
		expect(chip).toHaveAttribute('href', '/ws-1/settings/billing')
		expect(chip).toHaveAttribute('target', '_blank')
		expect(container.querySelector('.bg-primary')).toContainElement(chip)
	})

	it('draws a Keys address in your own message as a chip only in an enterprise workspace', () => {
		const address = 'https://maskin.io/ws-1/settings/keys'
		const own = buildMessage({
			actorId: 'me',
			actorName: 'Me',
			actorType: 'human',
			content: `keys live here ${address}`,
		})
		workspaceState.enterprise = true
		try {
			const { unmount } = renderBubble(own)
			expect(screen.getByRole('link', { name: 'Settings: Keys' })).toHaveAttribute(
				'href',
				'/ws-1/settings/keys',
			)
			unmount()
			workspaceState.enterprise = false
			renderBubble(own)
			expect(screen.queryByRole('link', { name: 'Settings: Keys' })).not.toBeInTheDocument()
			expect(screen.getByText(address, { exact: false })).toBeInTheDocument()
		} finally {
			workspaceState.enterprise = false
		}
	})

	it('draws a link to a chat in your own message inline, as a chip with its title', () => {
		const id = '3ecab143-9e98-4474-9e52-779a55d95952'
		const address = `https://maskin.io/ws-1/chats/${id}`
		const { container } = renderBubble(
			buildMessage({
				actorId: 'me',
				actorName: 'Me',
				actorType: 'human',
				content: `see ${address}`,
			}),
		)
		expect(screen.queryByText(address, { exact: false })).not.toBeInTheDocument()
		const chip = screen.getByRole('link', { name: 'Launch plan' })
		expect(container.querySelector('.bg-primary')).toContainElement(chip)
	})

	it('draws a chat link alone on its line as a chat card, and one in a sentence as a chip', () => {
		const id = '3ecab143-9e98-4474-9e52-779a55d95952'
		const { container } = renderBubble(
			buildMessage({
				content: `Where we talked:\n\n[the thread](/ws-1/chats/${id})\n\nAnd [that chat](/ws-1/chats/4aee24db-5d54-476a-8399-9586516e7de1) too.`,
			}),
		)
		expect(container.querySelectorAll('[data-linked-card]')).toHaveLength(1)
		expect(screen.getByText('Chat', { selector: '.eyebrow' })).toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'Chat: Launch plan' })).toBeInTheDocument()
	})

	it('renders another actor as an avatar + name with no card wrapper', () => {
		const { container } = renderBubble(buildMessage())
		expect(screen.getByText('Billing Agent')).toBeInTheDocument()
		// v2 drops the bordered card around an agent's body — it sits on the page.
		expect(container.querySelector('.border.border-border.bg-card')).toBeNull()
	})

	it('lifts attached objects above an own message under a YOU ATTACHED label', () => {
		renderBubble(
			buildMessage({
				actorId: 'me',
				actorName: 'Me',
				actorType: 'human',
				metadata: { context_objects: [{ id: 'obj-1', title: 'Retry window', type: 'bet' }] },
			}),
		)
		// Raw source string is uppercase — the .eyebrow class only renders visual
		// case, but v4 fixes the DOM text so it's semantically an eyebrow too.
		const label = screen.getByText('YOU ATTACHED')
		expect(label.className).toContain('eyebrow')
		// The chips row is a sibling of the plate, not a child of it.
		expect(label.closest('div')?.className).not.toContain('bg-primary')
	})

	it('renders a REFERENCED rail under an agent message body', () => {
		renderBubble(
			buildMessage({
				metadata: { context_objects: [{ id: 'obj-1', title: 'Retry window', type: 'bet' }] },
			}),
		)
		expect(screen.getByText('Referenced')).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /Retry window/ })).toBeInTheDocument()
	})

	// Regression: an attachment whose metadata omits `name` (older messages,
	// MCP-posted messages) previously fell through to the hardcoded "Attachment"
	// label. It must resolve against the file record instead — same reading as
	// the right sidebar.
	it('resolves an attached file name via useFiles when metadata.name is missing', () => {
		mockUseFiles.mockReturnValueOnce({
			data: [
				{
					id: 'file-1',
					workspaceId: 'ws-1',
					name: 'design.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 12345,
					storageKey: 'k',
					createdBy: 'me',
					createdAt: '2026-01-01T00:00:00Z',
					updatedAt: '2026-01-01T00:00:00Z',
				},
			],
		})
		renderBubble(
			buildMessage({
				actorId: 'me',
				actorName: 'Me',
				actorType: 'human',
				metadata: { attachments: [{ file_id: 'file-1' }] },
			}),
		)
		expect(screen.getByText('design.pdf')).toBeInTheDocument()
		expect(screen.queryByText('Attachment')).not.toBeInTheDocument()
	})

	it('renders a system message as a hairline divider, not a pill', () => {
		const { container } = renderBubble(
			buildMessage({ kind: 'system', content: 'Billing Agent joined' }),
		)
		expect(screen.getByText('Billing Agent joined')).toBeInTheDocument()
		expect(container.querySelectorAll('.bg-border')).toHaveLength(2)
		expect(container.querySelector('.rounded-full')).toBeNull()
	})
})

describe('MessageBubble — lifted attachments', () => {
	beforeEach(() => {
		flagState.lifted = true
		mockUseFiles.mockReturnValue({ data: [fileRow(image), fileRow(pdf)] })
	})
	afterEach(() => {
		flagState.lifted = false
		mockUseFiles.mockReturnValue({ data: [] })
	})

	const ownMessage = (overrides: Partial<MessageResponse>) =>
		buildMessage({ actorId: 'me', actorName: 'Me', actorType: 'human', ...overrides })
	const image = { file_id: 'img-1', name: 'shot.png', mime_type: 'image/png' }
	const pdf = { file_id: 'doc-1', name: 'review.pdf', mime_type: 'application/pdf' }
	const fileRow = (a: { file_id: string; name: string; mime_type: string }) => ({
		id: a.file_id,
		workspaceId: 'ws-1',
		name: a.name,
		mimeType: a.mime_type,
		sizeBytes: 1200,
	})

	it('draws an own message with one image and no text with no bubble around it', () => {
		const { container } = renderBubble(
			ownMessage({ content: '', metadata: { attachments: [image] } }),
		)
		expect(screen.getByRole('button', { name: 'Image 1, shot.png, open' })).toBeInTheDocument()
		expect(container.querySelector('.bg-primary')).toBeNull()
	})

	it('stacks the image block above a text bubble that holds only the text', () => {
		const { container } = renderBubble(
			ownMessage({ content: 'Sunset from the ridge.', metadata: { attachments: [image] } }),
		)
		const tile = screen.getByRole('button', { name: 'Image 1, shot.png, open' })
		const plate = container.querySelector('.bg-primary')
		expect(plate).not.toBeNull()
		expect(plate?.contains(tile)).toBe(false)
		expect(
			tile.compareDocumentPosition(plate as Element) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy()
		expect(plate).toHaveTextContent('Sunset from the ridge.')
	})

	it('lifts a file card out of the bubble too', () => {
		const { container } = renderBubble(
			ownMessage({
				content: 'Read page 4 first.',
				metadata: { attachments: [pdf] },
			}),
		)
		const card = screen.getByRole('link', { name: 'Open review.pdf' })
		expect(container.querySelector('.bg-primary')?.contains(card)).toBe(false)
	})

	it('draws attachments of another author under their name, left aligned', () => {
		const { container } = renderBubble(
			buildMessage({ content: 'Pipeline by week.', metadata: { attachments: [image] } }),
		)
		expect(screen.getByRole('button', { name: 'Image 1, shot.png, open' })).toBeInTheDocument()
		expect(container.querySelector('.items-start')).not.toBeNull()
		expect(container.querySelector('.bg-primary')).toBeNull()
	})

	it('shows a file that was deleted as gone, with its name struck through', () => {
		mockUseFiles.mockReturnValue({ data: [] })
		renderBubble(ownMessage({ content: '', metadata: { attachments: [pdf] } }))
		expect(screen.getByText('File no longer available')).toBeInTheDocument()
		expect(screen.queryByRole('link', { name: 'Open review.pdf' })).not.toBeInTheDocument()
	})

	it('keeps the files inside the bubble while the flag is off', () => {
		flagState.lifted = false
		const { container } = renderBubble(
			ownMessage({
				content: 'Read page 4 first.',
				metadata: { attachments: [pdf] },
			}),
		)
		expect(container.querySelector('.bg-primary')).toContainElement(screen.getByText('review.pdf'))
	})
})

describe('MessageBubble — agent hover row (v4)', () => {
	beforeEach(() => {
		retryMutate.mockReset()
	})

	it('renders Copy and Retry buttons on an agent message', () => {
		renderBubble(buildMessage())
		expect(screen.getByRole('button', { name: 'Copy message' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
	})

	it('deliberately does NOT render Rate up / Rate down on the agent hover row', () => {
		renderBubble(buildMessage())
		expect(screen.queryByRole('button', { name: /rate up/i })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /rate down/i })).not.toBeInTheDocument()
	})

	it('copies the message text to the clipboard when Copy is clicked', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined)
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText },
		})
		renderBubble(buildMessage({ content: 'Hello from the agent.' }))
		fireEvent.click(screen.getByRole('button', { name: 'Copy message' }))
		expect(writeText).toHaveBeenCalledWith('Hello from the agent.')
	})

	it('triggers the existing regenerate mutation with the message id when Retry is clicked', () => {
		renderBubble(buildMessage({ id: 42 }))
		fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
		expect(retryMutate).toHaveBeenCalledWith(
			{ messageId: 42 },
			expect.objectContaining({ onSuccess: expect.any(Function) }),
		)
	})

	it('tells the thread about the redo once the retry is accepted', () => {
		const onRetried = vi.fn()
		const message = buildMessage({ id: 42 })
		retryMutate.mockImplementation((_variables, options) => options?.onSuccess?.())
		render(<MessageBubble workspaceId="ws-1" message={message} onRetried={onRetried} />, {
			wrapper: TestWrapper,
		})
		expect(onRetried).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
		expect(onRetried).toHaveBeenCalledWith(message)
	})

	it('adds Copy to the user branch alongside Edit + Retry', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined)
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText },
		})
		renderBubble(
			buildMessage({
				actorId: 'me',
				actorName: 'Me',
				actorType: 'human',
				id: 7,
				content: 'My own words.',
			}),
		)
		expect(screen.getByRole('button', { name: 'Edit message' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Ask agents to respond again/ })).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: 'Copy message' }))
		expect(writeText).toHaveBeenCalledWith('My own words.')
	})

	it('does not render the hover row on an optimistic bubble (id ≤ 0)', () => {
		renderBubble(buildMessage({ id: -1 }))
		expect(screen.queryByRole('button', { name: 'Copy message' })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
	})
})

describe('MessageBubble — agent data-viz', () => {
	it('renders a fenced chart block from an incoming agent message as a visual', () => {
		renderBubble(buildMessage({ content: CHART_MESSAGE }))

		// The caption belongs to the rendered figure, not to a code block.
		expect(screen.getByText('Drop-off concentrates on step two.')).toBeInTheDocument()
		expect(screen.queryByText(/"type": "bar"/)).not.toBeInTheDocument()
	})
})

describe('MessageBubble — Reply in thread', () => {
	function renderWithReply(message: MessageResponse, onReplyInThread = vi.fn()) {
		render(
			<MessageBubble workspaceId="ws-1" message={message} onReplyInThread={onReplyInThread} />,
			{
				wrapper: TestWrapper,
			},
		)
		return onReplyInThread
	}

	it('has no Reply action without an onReplyInThread handler', () => {
		renderBubble(buildMessage())
		expect(screen.queryByRole('button', { name: 'Reply in thread' })).not.toBeInTheDocument()
	})

	it('calls the handler when Reply is clicked on an agent message', () => {
		const onReply = renderWithReply(buildMessage())
		fireEvent.click(screen.getByRole('button', { name: 'Reply in thread' }))
		expect(onReply).toHaveBeenCalledTimes(1)
	})

	it('offers Reply on your own message too', () => {
		const onReply = renderWithReply(
			buildMessage({ actorId: 'me', actorName: 'Me', actorType: 'human' }),
		)
		fireEvent.click(screen.getByRole('button', { name: 'Reply in thread' }))
		expect(onReply).toHaveBeenCalledTimes(1)
	})

	it('has no Reply on an optimistic (unsent) message', () => {
		renderWithReply(buildMessage({ id: -1, actorId: 'me', actorName: 'Me', actorType: 'human' }))
		expect(screen.queryByRole('button', { name: 'Reply in thread' })).not.toBeInTheDocument()
	})

	it('has no Reply on a system row', () => {
		renderWithReply(buildMessage({ kind: 'system' }))
		expect(screen.queryByRole('button', { name: 'Reply in thread' })).not.toBeInTheDocument()
	})

	it('hides Reply on your own message while it is being edited', () => {
		renderWithReply(buildMessage({ actorId: 'me', actorName: 'Me', actorType: 'human' }))
		fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
		expect(screen.queryByRole('button', { name: 'Reply in thread' })).not.toBeInTheDocument()
	})
})

describe('MessageBubble — own bubble fits its text', () => {
	const NATURAL_WIDTH = 560
	const WIDEST_LINE = 200
	const originalRects = Range.prototype.getClientRects
	const originalBox = HTMLElement.prototype.getBoundingClientRect

	beforeEach(() => {
		// jsdom has no layout: the column is 560px wide until it is given a width, and the
		// widest line of text ends at 200px.
		Range.prototype.getClientRects = () =>
			[{ left: 0, right: WIDEST_LINE, width: WIDEST_LINE }] as unknown as DOMRectList
		HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
			const width = Number.parseFloat(this.style.width) || NATURAL_WIDTH
			return { left: 0, right: width, width, top: 0, bottom: 0, height: 0 } as DOMRect
		}
	})
	afterEach(() => {
		Range.prototype.getClientRects = originalRects
		HTMLElement.prototype.getBoundingClientRect = originalBox
		flagState.lifted = false
	})

	const own = (overrides: Partial<MessageResponse> = {}) =>
		buildMessage({ actorId: 'me', actorName: 'Me', actorType: 'human', ...overrides })
	const columnOf = (container: HTMLElement) =>
		container.querySelector<HTMLElement>('.bg-primary')?.closest<HTMLElement>('[style]')

	it('gives the column the width of the widest line of text', () => {
		const { container } = renderBubble(own({ content: 'a long line\nand a shorter one' }))
		// jsdom applies no stylesheet, so the plate has no padding to add here.
		expect(columnOf(container)?.style.width).toBe(`${WIDEST_LINE}px`)
	})

	it('keeps lifted attachments as wide as the bubble, and not narrower than the minimum', () => {
		flagState.lifted = true
		Range.prototype.getClientRects = () =>
			[{ left: 0, right: 40, width: 40 }] as unknown as DOMRectList
		const { container } = renderBubble(
			own({
				content: 'ok',
				metadata: { attachments: [{ file_id: 'img-1', name: 'shot.png', mime_type: 'image/png' }] },
			}),
		)
		const column = columnOf(container)
		expect(column?.style.width).toBe('160px')
		expect(column).toContainElement(screen.getByLabelText('Attached files'))
	})

	it('leaves the full width while the message is being edited', () => {
		const { container } = renderBubble(own({ content: 'a long line' }))
		expect(columnOf(container)?.style.width).toBe(`${WIDEST_LINE}px`)
		fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
		// Leaving the fit clears the width but keeps an empty style attribute behind.
		expect(columnOf(container)?.style.width ?? '').toBe('')
	})

	it('does not fit a message from someone else', () => {
		const { container } = renderBubble(buildMessage({ content: 'a long line' }))
		expect(container.querySelector('[style*="width"]')).toBeNull()
	})
})
