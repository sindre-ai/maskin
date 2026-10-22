import type { MessageResponse } from '@/lib/api'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspace: { settings: { statuses: { bet: ['active', 'done'] } } } }),
}))

vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))

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
	useFile: () => ({ data: undefined }),
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
		const card = screen.getByText('LinkedIn message · P1')
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
