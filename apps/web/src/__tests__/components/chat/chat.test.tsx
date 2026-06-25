import { Chat } from '@/components/chat/chat'
import type { UseChatOneShotResult } from '@/hooks/use-chat-one-shot'
import type { UseChatSessionResult } from '@/hooks/use-chat-session'
import type { ChatSelection, ChatSelectionAction } from '@/lib/chat-selection'
import type { ChatEvent } from '@/lib/chat-stream'
import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorListItem, buildObjectResponse } from '../../factories'
import { createTestQueryClient } from '../../setup'

const mockSend = vi.fn(async () => {})
const mockOneShotSend = vi.fn(async () => {})
const mockOneShotClear = vi.fn()
const mockUploadFile = vi.fn()

let mockHookResult: UseChatSessionResult = {
	sessionId: null,
	status: 'idle',
	events: [],
	error: null,
	send: mockSend,
	reset: vi.fn(),
}

let mockOneShotResult: UseChatOneShotResult = {
	sessionId: null,
	status: 'idle',
	events: [],
	error: null,
	send: mockOneShotSend,
	clear: mockOneShotClear,
}

vi.mock('@/hooks/use-chat-session', () => ({
	useChatSession: () => mockHookResult,
}))

vi.mock('@/hooks/use-chat-one-shot', () => ({
	useChatOneShot: () => mockOneShotResult,
}))

vi.mock('@/hooks/use-files', () => ({
	useUploadFile: () => mockUploadFile,
}))

vi.mock('@/lib/api', () => ({
	api: {
		actors: { list: vi.fn() },
		objects: { list: vi.fn(), search: vi.fn() },
		notifications: { list: vi.fn().mockResolvedValue([]) },
	},
}))

import { api } from '@/lib/api'

// cmdk + Radix Popover rely on these browser APIs when the picker content is
// mounted in jsdom. Existing picker tests polyfill them the same way.
global.ResizeObserver = vi.fn().mockImplementation(() => ({
	observe: vi.fn(),
	unobserve: vi.fn(),
	disconnect: vi.fn(),
}))
Element.prototype.scrollIntoView = vi.fn()

function setHookResult(overrides: Partial<UseChatSessionResult>) {
	mockHookResult = {
		sessionId: null,
		status: 'ready',
		events: [],
		error: null,
		send: mockSend,
		reset: vi.fn(),
		...overrides,
	}
}

function setOneShotResult(overrides: Partial<UseChatOneShotResult>) {
	mockOneShotResult = {
		sessionId: null,
		status: 'idle',
		events: [],
		error: null,
		send: mockOneShotSend,
		clear: mockOneShotClear,
		...overrides,
	}
}

beforeEach(() => {
	mockSend.mockClear()
	mockOneShotSend.mockClear()
	mockOneShotClear.mockClear()
	mockUploadFile.mockReset()
	vi.mocked(api.actors.list).mockResolvedValue([
		buildActorListItem({ id: 'actor-a', name: 'Reviewer', type: 'agent', email: null }),
		buildActorListItem({ id: 'actor-b', name: 'Planner', type: 'agent', email: null }),
	])
	vi.mocked(api.objects.list).mockResolvedValue([
		buildObjectResponse({ id: 'obj-1', title: 'Bet Alpha', type: 'bet' }),
	])
	vi.mocked(api.objects.search).mockResolvedValue([
		buildObjectResponse({ id: 'obj-1', title: 'Bet Alpha', type: 'bet' }),
	])
	setHookResult({ status: 'ready' })
	setOneShotResult({ status: 'idle' })
})

function WithQueryClient({ children }: { children: ReactNode }) {
	const client = createTestQueryClient()
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('Chat', () => {
	it('renders transcript and composer in sheet mode', () => {
		setHookResult({ status: 'ready' })
		render(<Chat workspaceId="ws-1" agentActorId="actor-agent" surface="sheet" />)

		// Empty transcript copy
		expect(screen.getByText(/Ask the agents about your workspace/i)).toBeInTheDocument()
		// Composer textarea
		expect(screen.getByPlaceholderText('Message agents')).toBeInTheDocument()
	})

	it('hides the transcript in pulse-bar mode', () => {
		setHookResult({ status: 'ready' })
		render(<Chat workspaceId="ws-1" agentActorId="actor-agent" surface="pulse-bar" />)

		expect(screen.queryByText(/Ask the agents about your workspace/i)).not.toBeInTheDocument()
		expect(screen.getByPlaceholderText('Ask anything…')).toBeInTheDocument()
	})

	it('renders streamed assistant text events', () => {
		const events: ChatEvent[] = [{ kind: 'text', text: 'Looking at your workspace…' }]
		setHookResult({ status: 'ready', events })
		render(<Chat workspaceId="ws-1" agentActorId="actor-agent" surface="sheet" />)

		expect(screen.getByText('Looking at your workspace…')).toBeInTheDocument()
	})

	it('sends on submit and clears the textarea on success', async () => {
		mockSend.mockClear()
		setHookResult({ status: 'ready' })
		render(<Chat workspaceId="ws-1" agentActorId="actor-agent" surface="sheet" />)

		const textarea = screen.getByPlaceholderText('Message agents') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'hello sindre' } })

		const sendButton = screen.getByRole('button', { name: /send message/i })
		expect(sendButton).not.toBeDisabled()
		fireEvent.click(sendButton)

		await waitFor(() =>
			expect(mockSend).toHaveBeenCalledWith('hello sindre', undefined, 'hello sindre', undefined),
		)
		await waitFor(() => expect(textarea.value).toBe(''))
	})

	it('preserves the draft and surfaces an error when send fails', async () => {
		mockSend.mockClear()
		mockSend.mockRejectedValueOnce(new Error('network down'))
		setHookResult({ status: 'ready' })
		render(<Chat workspaceId="ws-1" agentActorId="actor-agent" surface="sheet" />)

		const textarea = screen.getByPlaceholderText('Message agents') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'important prompt' } })
		fireEvent.click(screen.getByRole('button', { name: /send message/i }))

		await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
		expect(textarea.value).toBe('important prompt')
		expect(await screen.findByRole('alert')).toHaveTextContent(/network down/)
	})

	it('disables the composer while the session is starting', () => {
		setHookResult({ status: 'starting' })
		render(<Chat workspaceId="ws-1" agentActorId="actor-agent" surface="sheet" />)

		const textarea = screen.getByPlaceholderText('Message agents') as HTMLTextAreaElement
		expect(textarea).toBeDisabled()
		expect(screen.getByText(/Connecting to agent/i)).toBeInTheDocument()
	})

	it('submits on Enter and leaves the textarea clean', async () => {
		mockSend.mockClear()
		setHookResult({ status: 'ready' })
		render(<Chat workspaceId="ws-1" agentActorId="actor-agent" surface="sheet" />)

		const textarea = screen.getByPlaceholderText('Message agents') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'hi there' } })
		fireEvent.keyDown(textarea, { key: 'Enter' })

		await waitFor(() =>
			expect(mockSend).toHaveBeenCalledWith('hi there', undefined, 'hi there', undefined),
		)
		await waitFor(() => expect(textarea.value).toBe(''))
	})

	it('does not submit on Shift+Enter', () => {
		mockSend.mockClear()
		setHookResult({ status: 'ready' })
		render(<Chat workspaceId="ws-1" agentActorId="actor-agent" surface="sheet" />)

		const textarea = screen.getByPlaceholderText('Message agents') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'first line' } })
		const event = fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

		expect(event).toBe(true) // default not prevented → newline inserted by the browser
		expect(mockSend).not.toHaveBeenCalled()
	})

	it('does not submit on Enter during IME composition', () => {
		mockSend.mockClear()
		setHookResult({ status: 'ready' })
		render(<Chat workspaceId="ws-1" agentActorId="actor-agent" surface="sheet" />)

		const textarea = screen.getByPlaceholderText('Message agents') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'こん' } })
		fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })

		expect(mockSend).not.toHaveBeenCalled()
	})

	it('does not submit when the content is empty or only whitespace', () => {
		mockSend.mockClear()
		setHookResult({ status: 'ready' })
		render(<Chat workspaceId="ws-1" agentActorId="actor-agent" surface="sheet" />)

		const textarea = screen.getByPlaceholderText('Message agents') as HTMLTextAreaElement
		const sendButton = screen.getByRole('button', { name: /send message/i })
		expect(sendButton).toBeDisabled()

		fireEvent.change(textarea, { target: { value: '   \n  ' } })
		expect(sendButton).toBeDisabled()
		fireEvent.keyDown(textarea, { key: 'Enter' })
		expect(mockSend).not.toHaveBeenCalled()
	})

	it('shows the streaming spinner until the first assistant event lands', async () => {
		mockSend.mockClear()
		setHookResult({ status: 'ready', events: [] })
		const { rerender } = render(
			<Chat workspaceId="ws-1" agentActorId="actor-agent" surface="sheet" />,
		)

		const textarea = screen.getByPlaceholderText('Message agents') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'hello' } })
		fireEvent.click(screen.getByRole('button', { name: /send message/i }))

		await waitFor(() =>
			expect(mockSend).toHaveBeenCalledWith('hello', undefined, 'hello', undefined),
		)

		// Mid-turn: spinner showing, send button disabled, Enter is ignored.
		const spinnerButton = screen.getByRole('button', { name: /send message/i })
		expect(spinnerButton).toBeDisabled()
		expect(spinnerButton.querySelector('svg.animate-spin')).not.toBeNull()

		fireEvent.change(textarea, { target: { value: 'queued follow-up' } })
		fireEvent.keyDown(textarea, { key: 'Enter' })
		expect(mockSend).toHaveBeenCalledTimes(1)

		// First assistant event arrives → spinner clears, button enables again.
		setHookResult({
			status: 'ready',
			events: [{ kind: 'text', text: 'Hi!' }],
		})
		rerender(<Chat workspaceId="ws-1" agentActorId="actor-agent" surface="sheet" />)

		await waitFor(() => {
			const btn = screen.getByRole('button', { name: /send message/i })
			expect(btn.querySelector('svg.animate-spin')).toBeNull()
			expect(btn).not.toBeDisabled()
		})
	})

	it('routes the send to one-shot when a selection.agent is set', async () => {
		render(
			<Chat
				workspaceId="ws-1"
				agentActorId="actor-agent"
				surface="sheet"
				selection={{
					agent: { id: 'actor-reviewer', name: 'Code Reviewer' },
					objects: [
						{ id: 'obj-1', title: 'PR #42', type: 'task' },
						{ id: 'obj-2', title: null, type: null },
					],
					notifications: [],
					files: [],
				}}
			/>,
		)

		const textarea = screen.getByPlaceholderText('Message Code Reviewer') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'please review' } })
		fireEvent.click(screen.getByRole('button', { name: /send message/i }))

		await waitFor(() => expect(mockOneShotSend).toHaveBeenCalledTimes(1))
		expect(mockOneShotSend).toHaveBeenCalledWith({
			workspaceId: 'ws-1',
			agent: { id: 'actor-reviewer', name: 'Code Reviewer' },
			content: 'please review',
			objects: [
				{ id: 'obj-1', title: 'PR #42', type: 'task' },
				{ id: 'obj-2', title: null, type: null },
			],
			notifications: [],
			files: [],
			displayAttachments: [
				{ kind: 'agent', id: 'actor-reviewer', name: 'Code Reviewer' },
				{ kind: 'object', id: 'obj-1', title: 'PR #42', type: 'task' },
				{ kind: 'object', id: 'obj-2', title: null, type: null },
			],
		})
		expect(mockSend).not.toHaveBeenCalled()
		await waitFor(() => expect(textarea.value).toBe(''))
	})

	it('attaches selected objects to the chat send when no agent is picked', async () => {
		render(
			<Chat
				workspaceId="ws-1"
				agentActorId="actor-agent"
				surface="sheet"
				selection={{
					agent: null,
					objects: [
						{ id: 'obj-1', title: 'Bet Alpha' },
						{ id: 'obj-2', title: 'Task Beta' },
					],
					notifications: [],
					files: [],
				}}
			/>,
		)

		const textarea = screen.getByPlaceholderText('Message agents') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'summarize these' } })
		fireEvent.click(screen.getByRole('button', { name: /send message/i }))

		await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
		expect(mockSend).toHaveBeenCalledWith(
			[
				'summarize these',
				'',
				'---',
				'Context objects:',
				'- Bet Alpha — id: obj-1',
				'- Task Beta — id: obj-2',
			].join('\n'),
			[
				{ kind: 'object', id: 'obj-1' },
				{ kind: 'object', id: 'obj-2' },
			],
			'summarize these',
			[
				{ kind: 'object', id: 'obj-1', title: 'Bet Alpha', type: null },
				{ kind: 'object', id: 'obj-2', title: 'Task Beta', type: null },
			],
		)
		expect(mockOneShotSend).not.toHaveBeenCalled()
	})

	it('injects notification context into the chat send and forwards notifications as attachments', async () => {
		render(
			<Chat
				workspaceId="ws-1"
				agentActorId="actor-agent"
				surface="sheet"
				selection={{
					agent: null,
					objects: [],
					notifications: [{ id: 'notif-1', title: 'Build failed' }],
					files: [],
				}}
			/>,
		)

		const textarea = screen.getByPlaceholderText('Message agents') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'what happened?' } })
		fireEvent.click(screen.getByRole('button', { name: /send message/i }))

		await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
		expect(mockSend).toHaveBeenCalledWith(
			['what happened?', '', '---', 'Context notifications:', '- Build failed — id: notif-1'].join(
				'\n',
			),
			[{ kind: 'notification', id: 'notif-1' }],
			'what happened?',
			[{ kind: 'notification', id: 'notif-1', title: 'Build failed' }],
		)
	})

	it('forwards notifications to the one-shot send when an agent is selected', async () => {
		render(
			<Chat
				workspaceId="ws-1"
				agentActorId="actor-agent"
				surface="sheet"
				selection={{
					agent: { id: 'actor-reviewer', name: 'Code Reviewer' },
					objects: [],
					notifications: [{ id: 'notif-1', title: 'PR merged' }],
					files: [],
				}}
			/>,
		)

		const textarea = screen.getByPlaceholderText('Message Code Reviewer') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'take a look' } })
		fireEvent.click(screen.getByRole('button', { name: /send message/i }))

		await waitFor(() => expect(mockOneShotSend).toHaveBeenCalledTimes(1))
		expect(mockOneShotSend).toHaveBeenCalledWith({
			workspaceId: 'ws-1',
			agent: { id: 'actor-reviewer', name: 'Code Reviewer' },
			content: 'take a look',
			objects: [],
			notifications: [{ id: 'notif-1', title: 'PR merged' }],
			files: [],
			displayAttachments: [
				{ kind: 'agent', id: 'actor-reviewer', name: 'Code Reviewer' },
				{ kind: 'notification', id: 'notif-1', title: 'PR merged' },
			],
		})
	})

	it('dispatches clear_all after a confirmed send so chips do not ride along', async () => {
		mockSend.mockClear()
		const dispatch = vi.fn<(action: ChatSelectionAction) => void>()
		render(
			<Chat
				workspaceId="ws-1"
				agentActorId="actor-agent"
				surface="sheet"
				selection={{
					agent: null,
					objects: [{ id: 'obj-1', title: 'Bet Alpha' }],
					notifications: [],
					files: [],
				}}
				onDispatchSelection={dispatch}
			/>,
		)

		const textarea = screen.getByPlaceholderText('Message agents') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'summarize' } })
		fireEvent.click(screen.getByRole('button', { name: /send message/i }))

		await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
		await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'clear_all' }))
	})

	it('keeps selection chips when send rejects so the user can retry', async () => {
		mockSend.mockClear()
		mockSend.mockRejectedValueOnce(new Error('boom'))
		const dispatch = vi.fn<(action: ChatSelectionAction) => void>()
		render(
			<Chat
				workspaceId="ws-1"
				agentActorId="actor-agent"
				surface="sheet"
				selection={{
					agent: null,
					objects: [{ id: 'obj-1', title: 'Bet Alpha' }],
					notifications: [],
					files: [],
				}}
				onDispatchSelection={dispatch}
			/>,
		)

		const textarea = screen.getByPlaceholderText('Message agents') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'summarize' } })
		fireEvent.click(screen.getByRole('button', { name: /send message/i }))

		await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
		expect(dispatch).not.toHaveBeenCalledWith({ type: 'clear_all' })
	})

	it('renders a chip per notification and dispatches remove_notification on click', async () => {
		const dispatch = vi.fn<(action: ChatSelectionAction) => void>()
		const user = userEvent.setup()
		render(
			<Chat
				workspaceId="ws-1"
				agentActorId="actor-agent"
				surface="sheet"
				selection={{
					agent: null,
					objects: [],
					notifications: [{ id: 'notif-1', title: 'Build failed' }],
					files: [],
				}}
				onDispatchSelection={dispatch}
			/>,
		)

		expect(screen.getByText('Build failed')).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: /Remove Build failed/ }))
		expect(dispatch).toHaveBeenCalledWith({ type: 'remove_notification', id: 'notif-1' })
	})

	it('stays enabled for a one-shot send even when the agent is not ready yet', () => {
		setHookResult({ status: 'idle' })
		render(
			<Chat
				workspaceId="ws-1"
				agentActorId={null}
				surface="sheet"
				selection={{
					agent: { id: 'actor-reviewer', name: 'Code Reviewer' },
					objects: [],
					notifications: [],
					files: [],
				}}
			/>,
		)

		const textarea = screen.getByPlaceholderText('Message Code Reviewer') as HTMLTextAreaElement
		expect(textarea).not.toBeDisabled()
	})

	it('disables the composer while a one-shot session is starting', () => {
		setOneShotResult({ status: 'starting' })
		render(
			<Chat
				workspaceId="ws-1"
				agentActorId="actor-agent"
				surface="sheet"
				selection={{
					agent: { id: 'actor-reviewer', name: 'Code Reviewer' },
					objects: [],
					notifications: [],
					files: [],
				}}
			/>,
		)

		const textarea = screen.getByPlaceholderText('Message Code Reviewer') as HTMLTextAreaElement
		expect(textarea).toBeDisabled()
	})

	it('surfaces one-shot errors in the transcript when the agent branch is active', () => {
		setOneShotResult({ status: 'error', error: new Error('boom') })
		render(
			<Chat
				workspaceId="ws-1"
				agentActorId="actor-agent"
				surface="sheet"
				selection={{
					agent: { id: 'actor-reviewer', name: 'Code Reviewer' },
					objects: [],
					notifications: [],
					files: [],
				}}
			/>,
		)

		expect(screen.getByText('boom')).toBeInTheDocument()
	})

	// ---- Task 36: composer picker entry points --------------------------------

	it('renders the Agent and Items picker buttons next to the composer', () => {
		render(<Chat workspaceId="ws-1" agentActorId="actor-agent" surface="sheet" />)
		expect(screen.getByRole('button', { name: /pick an agent/i })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /attach items/i })).toBeInTheDocument()
	})

	it('opens the picker pre-filtered to agents when the Agent button is clicked', async () => {
		const user = userEvent.setup()
		render(<Chat workspaceId="ws-1" agentActorId="actor-agent" surface="sheet" />, {
			wrapper: WithQueryClient,
		})

		await user.click(screen.getByRole('button', { name: /pick an agent/i }))

		expect(await screen.findByPlaceholderText('Search agents…')).toBeInTheDocument()
		// The top-level kind menu is skipped when a kind is preselected.
		expect(screen.queryByPlaceholderText('Choose a kind…')).not.toBeInTheDocument()
	})

	it('opens the picker pre-filtered to items when the Items button is clicked', async () => {
		const user = userEvent.setup()
		render(<Chat workspaceId="ws-1" agentActorId="actor-agent" surface="sheet" />, {
			wrapper: WithQueryClient,
		})

		await user.click(screen.getByRole('button', { name: /attach items/i }))

		expect(await screen.findByPlaceholderText('Search items…')).toBeInTheDocument()
	})

	it('opens the picker at the top-level kind menu when `/` is typed at the start', async () => {
		render(<Chat workspaceId="ws-1" agentActorId="actor-agent" surface="sheet" />, {
			wrapper: WithQueryClient,
		})

		const textarea = screen.getByPlaceholderText('Message agents') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: '/' } })

		expect(await screen.findByPlaceholderText('Choose a kind…')).toBeInTheDocument()
	})

	it('opens the picker when `/` is typed immediately after whitespace', async () => {
		render(<Chat workspaceId="ws-1" agentActorId="actor-agent" surface="sheet" />, {
			wrapper: WithQueryClient,
		})

		const textarea = screen.getByPlaceholderText('Message agents') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'hello /' } })

		expect(await screen.findByPlaceholderText('Choose a kind…')).toBeInTheDocument()
	})

	it('does not open the picker when `/` is typed in the middle of a word', () => {
		render(<Chat workspaceId="ws-1" agentActorId="actor-agent" surface="sheet" />, {
			wrapper: WithQueryClient,
		})

		const textarea = screen.getByPlaceholderText('Message agents') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'path/to' } })

		expect(screen.queryByPlaceholderText('Choose a kind…')).not.toBeInTheDocument()
		expect(screen.queryByPlaceholderText('Search agents…')).not.toBeInTheDocument()
	})

	it('dispatches add_agent and strips the triggering `/` when an agent is picked', async () => {
		const user = userEvent.setup()
		const dispatch = vi.fn<(action: ChatSelectionAction) => void>()
		const selection: ChatSelection = { agent: null, objects: [], notifications: [], files: [] }

		render(
			<Chat
				workspaceId="ws-1"
				agentActorId="actor-agent"
				surface="sheet"
				selection={selection}
				onDispatchSelection={dispatch}
			/>,
			{ wrapper: WithQueryClient },
		)

		const textarea = screen.getByPlaceholderText('Message agents') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'hi /' } })

		// Drill into the Agent kind, then pick Reviewer. Scope to cmdk's
		// options to avoid matching the composer's own `Agent` button.
		await user.click(await screen.findByRole('option', { name: /^Agent/ }))
		await user.click(await screen.findByRole('option', { name: /Reviewer/ }))

		expect(dispatch).toHaveBeenCalledWith({
			type: 'add_agent',
			agent: { id: 'actor-a', name: 'Reviewer' },
		})
		// The `/` that triggered the picker is spliced out; the rest remains.
		await waitFor(() => expect(textarea.value).toBe('hi '))
	})

	it('dispatches add_object when the Items button path picks an object', async () => {
		const user = userEvent.setup()
		const dispatch = vi.fn<(action: ChatSelectionAction) => void>()

		render(
			<Chat
				workspaceId="ws-1"
				agentActorId="actor-agent"
				surface="sheet"
				selection={{ agent: null, objects: [], notifications: [], files: [] }}
				onDispatchSelection={dispatch}
			/>,
			{ wrapper: WithQueryClient },
		)

		await user.click(screen.getByRole('button', { name: /attach items/i }))
		await user.click(await screen.findByRole('option', { name: /Bet Alpha/ }))

		expect(dispatch).toHaveBeenCalledWith({
			type: 'add_object',
			object: { id: 'obj-1', title: 'Bet Alpha', type: 'bet' },
		})
	})

	it('onSubmitOverride replaces the internal send path', async () => {
		const override = vi.fn(async () => {})
		render(
			<Chat
				workspaceId="ws-1"
				agentActorId="actor-agent"
				surface="pulse-bar"
				onSubmitOverride={override}
			/>,
		)

		const textarea = screen.getByPlaceholderText('Ask anything…') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'intercept me' } })
		fireEvent.click(screen.getByRole('button', { name: /send message/i }))

		await waitFor(() => expect(override).toHaveBeenCalledTimes(1))
		expect(override).toHaveBeenCalledWith('intercept me', {
			agent: null,
			objects: [],
			notifications: [],
			files: [],
		})
		expect(mockSend).not.toHaveBeenCalled()
		expect(mockOneShotSend).not.toHaveBeenCalled()
		await waitFor(() => expect(textarea.value).toBe(''))
	})

	it('autoSendMessage auto-fires a send exactly once and fires the consumed callback', async () => {
		const onConsumed = vi.fn()
		const { rerender } = render(
			<Chat
				workspaceId="ws-1"
				agentActorId="actor-agent"
				surface="sheet"
				autoSendMessage={null}
				onAutoSendConsumed={onConsumed}
			/>,
		)

		expect(mockSend).not.toHaveBeenCalled()

		rerender(
			<Chat
				workspaceId="ws-1"
				agentActorId="actor-agent"
				surface="sheet"
				autoSendMessage="from bar"
				onAutoSendConsumed={onConsumed}
			/>,
		)

		await waitFor(() =>
			expect(mockSend).toHaveBeenCalledWith('from bar', undefined, 'from bar', undefined),
		)
		expect(onConsumed).toHaveBeenCalledTimes(1)

		// Same message re-arrives (e.g. before consumer has cleared it) — must
		// not double-send.
		rerender(
			<Chat
				workspaceId="ws-1"
				agentActorId="actor-agent"
				surface="sheet"
				autoSendMessage="from bar"
				onAutoSendConsumed={onConsumed}
			/>,
		)
		expect(mockSend).toHaveBeenCalledTimes(1)

		// Consumer clears the prop, then the user types the same message again.
		// This second transition from null must fire the send again — the
		// previous sticky-ref bug silently dropped it.
		rerender(
			<Chat
				workspaceId="ws-1"
				agentActorId="actor-agent"
				surface="sheet"
				autoSendMessage={null}
				onAutoSendConsumed={onConsumed}
			/>,
		)
		rerender(
			<Chat
				workspaceId="ws-1"
				agentActorId="actor-agent"
				surface="sheet"
				autoSendMessage="from bar"
				onAutoSendConsumed={onConsumed}
			/>,
		)

		await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(2))
		expect(onConsumed).toHaveBeenCalledTimes(2)
	})

	it('merges one-shot events after session events in the transcript', () => {
		setHookResult({
			status: 'ready',
			events: [{ kind: 'text', text: 'Hi from Sindre' }],
		})
		setOneShotResult({
			status: 'streaming',
			events: [{ kind: 'text', text: 'Hi from Code Reviewer' }],
		})
		render(
			<Chat
				workspaceId="ws-1"
				agentActorId="actor-agent"
				surface="sheet"
				selection={{
					agent: { id: 'actor-reviewer', name: 'Code Reviewer' },
					objects: [],
					notifications: [],
					files: [],
				}}
			/>,
		)

		expect(screen.getByText('Hi from Sindre')).toBeInTheDocument()
		expect(screen.getByText('Hi from Code Reviewer')).toBeInTheDocument()
	})

	// AC-T2: a file attachment on the user turn is forwarded to session.send as
	// a `SessionInputAttachment` carrying kind:'file' + id + name + size_bytes
	// + mime_type, AND surfaced on the displayAttachments so the user bubble
	// can render an inline image card. The persistence + reload-from-/logs
	// round trip is covered by chat-stream.test.ts (`maskin_attachments`) and
	// use-chat-session.test.ts (hydrate replay).
	it('forwards selected file attachments to session.send with id + mime + size metadata', async () => {
		render(
			<Chat
				workspaceId="ws-1"
				agentActorId="actor-agent"
				surface="sheet"
				selection={{
					agent: null,
					objects: [],
					notifications: [],
					files: [
						{
							fileId: 'file-99',
							name: 'photo.png',
							sizeBytes: 1234,
							mimeType: 'image/png',
						},
					],
				}}
			/>,
		)

		const textarea = screen.getByPlaceholderText('Message agents') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'look at this' } })
		fireEvent.click(screen.getByRole('button', { name: /send message/i }))

		await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
		expect(mockSend).toHaveBeenCalledWith(
			['look at this', '', '---', 'Attached files:', '- photo.png — file_id: file-99'].join('\n'),
			[
				{
					kind: 'file',
					id: 'file-99',
					name: 'photo.png',
					size_bytes: 1234,
					mime_type: 'image/png',
				},
			],
			'look at this',
			[
				{
					kind: 'file',
					id: 'file-99',
					name: 'photo.png',
					sizeBytes: 1234,
					mimeType: 'image/png',
				},
			],
		)
	})

	// AC-T1: image pick on the chat composer routes through useUploadFile —
	// binary base64 POST to /files returning a fileId, not the old text-only
	// file.text() path. The resolved fileId is dispatched into the selection.
	it('uploads picked images via useUploadFile and dispatches add_file with the returned fileId', async () => {
		mockUploadFile.mockResolvedValueOnce({ id: 'file-99', name: 'photo.png' })
		const dispatch = vi.fn<(action: ChatSelectionAction) => void>()
		render(
			<Chat
				workspaceId="ws-1"
				agentActorId="actor-agent"
				surface="sheet"
				onDispatchSelection={dispatch}
			/>,
		)

		// readFileAsBase64 reads the file via FileReader.readAsDataURL — jsdom's
		// reader handles real Blob/File instances.
		const file = new File([new Uint8Array([0xde, 0xad, 0xbe, 0xef])], 'photo.png', {
			type: 'image/png',
		})
		const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement
		expect(fileInput.accept).toBe('image/*')
		Object.defineProperty(fileInput, 'files', { value: [file], configurable: true })
		fireEvent.change(fileInput)

		await waitFor(() => expect(mockUploadFile).toHaveBeenCalledTimes(1))
		const [payload] = mockUploadFile.mock.calls[0]
		expect(payload).toMatchObject({
			name: 'photo.png',
			mime_type: 'image/png',
			encoding: 'base64',
		})
		// Base64 of [0xDE, 0xAD, 0xBE, 0xEF] is '3q2+7w==' — assert the binary
		// payload was reached via base64 encoding (not file.text()).
		expect(payload.content).toBe('3q2+7w==')

		await waitFor(() =>
			expect(dispatch).toHaveBeenCalledWith({
				type: 'add_file',
				file: {
					fileId: 'file-99',
					name: 'photo.png',
					sizeBytes: file.size,
					mimeType: 'image/png',
				},
			}),
		)
	})
})
