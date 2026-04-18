import { SindreChat } from '@/components/sindre/sindre-chat'
import type { UseSindreOneShotResult } from '@/hooks/use-sindre-one-shot'
import type { UseSindreSessionResult } from '@/hooks/use-sindre-session'
import type { SindreEvent } from '@/lib/sindre-stream'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSend = vi.fn(async () => {})
const mockOneShotSend = vi.fn(async () => {})
const mockOneShotClear = vi.fn()

let mockHookResult: UseSindreSessionResult = {
	sessionId: null,
	status: 'idle',
	events: [],
	error: null,
	send: mockSend,
	reset: vi.fn(),
}

let mockOneShotResult: UseSindreOneShotResult = {
	sessionId: null,
	status: 'idle',
	events: [],
	error: null,
	send: mockOneShotSend,
	clear: mockOneShotClear,
}

vi.mock('@/hooks/use-sindre-session', () => ({
	useSindreSession: () => mockHookResult,
}))

vi.mock('@/hooks/use-sindre-one-shot', () => ({
	useSindreOneShot: () => mockOneShotResult,
}))

function setHookResult(overrides: Partial<UseSindreSessionResult>) {
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

function setOneShotResult(overrides: Partial<UseSindreOneShotResult>) {
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
	setHookResult({ status: 'ready' })
	setOneShotResult({ status: 'idle' })
})

describe('SindreChat', () => {
	it('renders transcript and composer in sheet mode', () => {
		setHookResult({ status: 'ready' })
		render(<SindreChat workspaceId="ws-1" sindreActorId="actor-sindre" surface="sheet" />)

		// Empty transcript copy
		expect(screen.getByText(/Ask Sindre about your workspace/i)).toBeInTheDocument()
		// Composer textarea
		expect(screen.getByPlaceholderText('Message Sindre')).toBeInTheDocument()
	})

	it('hides the transcript in pulse-bar mode', () => {
		setHookResult({ status: 'ready' })
		render(<SindreChat workspaceId="ws-1" sindreActorId="actor-sindre" surface="pulse-bar" />)

		expect(screen.queryByText(/Ask Sindre about your workspace/i)).not.toBeInTheDocument()
		expect(screen.getByPlaceholderText('Ask Sindre anything…')).toBeInTheDocument()
	})

	it('renders streamed assistant text events', () => {
		const events: SindreEvent[] = [{ kind: 'text', text: 'Looking at your workspace…' }]
		setHookResult({ status: 'ready', events })
		render(<SindreChat workspaceId="ws-1" sindreActorId="actor-sindre" surface="sheet" />)

		expect(screen.getByText('Looking at your workspace…')).toBeInTheDocument()
	})

	it('sends on submit and clears the textarea on success', async () => {
		mockSend.mockClear()
		setHookResult({ status: 'ready' })
		render(<SindreChat workspaceId="ws-1" sindreActorId="actor-sindre" surface="sheet" />)

		const textarea = screen.getByPlaceholderText('Message Sindre') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'hello sindre' } })

		const sendButton = screen.getByRole('button', { name: /send message/i })
		expect(sendButton).not.toBeDisabled()
		fireEvent.click(sendButton)

		await waitFor(() => expect(mockSend).toHaveBeenCalledWith('hello sindre'))
		await waitFor(() => expect(textarea.value).toBe(''))
	})

	it('disables the composer while the session is starting', () => {
		setHookResult({ status: 'starting' })
		render(<SindreChat workspaceId="ws-1" sindreActorId="actor-sindre" surface="sheet" />)

		const textarea = screen.getByPlaceholderText('Message Sindre') as HTMLTextAreaElement
		expect(textarea).toBeDisabled()
		expect(screen.getByText(/Connecting to Sindre/i)).toBeInTheDocument()
	})

	it('submits on Enter and leaves the textarea clean', async () => {
		mockSend.mockClear()
		setHookResult({ status: 'ready' })
		render(<SindreChat workspaceId="ws-1" sindreActorId="actor-sindre" surface="sheet" />)

		const textarea = screen.getByPlaceholderText('Message Sindre') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'hi there' } })
		fireEvent.keyDown(textarea, { key: 'Enter' })

		await waitFor(() => expect(mockSend).toHaveBeenCalledWith('hi there'))
		await waitFor(() => expect(textarea.value).toBe(''))
	})

	it('does not submit on Shift+Enter', () => {
		mockSend.mockClear()
		setHookResult({ status: 'ready' })
		render(<SindreChat workspaceId="ws-1" sindreActorId="actor-sindre" surface="sheet" />)

		const textarea = screen.getByPlaceholderText('Message Sindre') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'first line' } })
		const event = fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })

		expect(event).toBe(true) // default not prevented → newline inserted by the browser
		expect(mockSend).not.toHaveBeenCalled()
	})

	it('does not submit on Enter during IME composition', () => {
		mockSend.mockClear()
		setHookResult({ status: 'ready' })
		render(<SindreChat workspaceId="ws-1" sindreActorId="actor-sindre" surface="sheet" />)

		const textarea = screen.getByPlaceholderText('Message Sindre') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'こん' } })
		fireEvent.keyDown(textarea, { key: 'Enter', isComposing: true })

		expect(mockSend).not.toHaveBeenCalled()
	})

	it('does not submit when the content is empty or only whitespace', () => {
		mockSend.mockClear()
		setHookResult({ status: 'ready' })
		render(<SindreChat workspaceId="ws-1" sindreActorId="actor-sindre" surface="sheet" />)

		const textarea = screen.getByPlaceholderText('Message Sindre') as HTMLTextAreaElement
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
			<SindreChat workspaceId="ws-1" sindreActorId="actor-sindre" surface="sheet" />,
		)

		const textarea = screen.getByPlaceholderText('Message Sindre') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'hello' } })
		fireEvent.click(screen.getByRole('button', { name: /send message/i }))

		await waitFor(() => expect(mockSend).toHaveBeenCalledWith('hello'))

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
		rerender(<SindreChat workspaceId="ws-1" sindreActorId="actor-sindre" surface="sheet" />)

		await waitFor(() => {
			const btn = screen.getByRole('button', { name: /send message/i })
			expect(btn.querySelector('svg.animate-spin')).toBeNull()
			expect(btn).not.toBeDisabled()
		})
	})

	it('routes the send to one-shot when a selection.agent is set', async () => {
		render(
			<SindreChat
				workspaceId="ws-1"
				sindreActorId="actor-sindre"
				surface="sheet"
				selection={{
					agent: { id: 'actor-reviewer', name: 'Code Reviewer' },
					objects: [
						{ id: 'obj-1', title: 'PR #42', type: 'task' },
						{ id: 'obj-2', title: null, type: null },
					],
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
		})
		expect(mockSend).not.toHaveBeenCalled()
		await waitFor(() => expect(textarea.value).toBe(''))
	})

	it('attaches selected objects to the Sindre send when no agent is picked', async () => {
		render(
			<SindreChat
				workspaceId="ws-1"
				sindreActorId="actor-sindre"
				surface="sheet"
				selection={{
					agent: null,
					objects: [
						{ id: 'obj-1', title: 'Bet Alpha' },
						{ id: 'obj-2', title: 'Task Beta' },
					],
				}}
			/>,
		)

		const textarea = screen.getByPlaceholderText('Message Sindre') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'summarize these' } })
		fireEvent.click(screen.getByRole('button', { name: /send message/i }))

		await waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1))
		expect(mockSend).toHaveBeenCalledWith('summarize these', [
			{ kind: 'object', id: 'obj-1' },
			{ kind: 'object', id: 'obj-2' },
		])
		expect(mockOneShotSend).not.toHaveBeenCalled()
	})

	it('stays enabled for a one-shot send even when Sindre is not ready yet', () => {
		setHookResult({ status: 'idle' })
		render(
			<SindreChat
				workspaceId="ws-1"
				sindreActorId={null}
				surface="sheet"
				selection={{
					agent: { id: 'actor-reviewer', name: 'Code Reviewer' },
					objects: [],
				}}
			/>,
		)

		const textarea = screen.getByPlaceholderText('Message Code Reviewer') as HTMLTextAreaElement
		expect(textarea).not.toBeDisabled()
	})

	it('disables the composer while a one-shot session is starting', () => {
		setOneShotResult({ status: 'starting' })
		render(
			<SindreChat
				workspaceId="ws-1"
				sindreActorId="actor-sindre"
				surface="sheet"
				selection={{
					agent: { id: 'actor-reviewer', name: 'Code Reviewer' },
					objects: [],
				}}
			/>,
		)

		const textarea = screen.getByPlaceholderText('Message Code Reviewer') as HTMLTextAreaElement
		expect(textarea).toBeDisabled()
	})

	it('surfaces one-shot errors in the transcript when the agent branch is active', () => {
		setOneShotResult({ status: 'error', error: new Error('boom') })
		render(
			<SindreChat
				workspaceId="ws-1"
				sindreActorId="actor-sindre"
				surface="sheet"
				selection={{
					agent: { id: 'actor-reviewer', name: 'Code Reviewer' },
					objects: [],
				}}
			/>,
		)

		expect(screen.getByText('boom')).toBeInTheDocument()
	})

	it('merges one-shot events after Sindre events in the transcript', () => {
		setHookResult({
			status: 'ready',
			events: [{ kind: 'text', text: 'Hi from Sindre' }],
		})
		setOneShotResult({
			status: 'streaming',
			events: [{ kind: 'text', text: 'Hi from Code Reviewer' }],
		})
		render(
			<SindreChat
				workspaceId="ws-1"
				sindreActorId="actor-sindre"
				surface="sheet"
				selection={{
					agent: { id: 'actor-reviewer', name: 'Code Reviewer' },
					objects: [],
				}}
			/>,
		)

		expect(screen.getByText('Hi from Sindre')).toBeInTheDocument()
		expect(screen.getByText('Hi from Code Reviewer')).toBeInTheDocument()
	})
})
