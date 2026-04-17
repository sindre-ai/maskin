import { SindreChat } from '@/components/sindre/sindre-chat'
import type { UseSindreSessionResult } from '@/hooks/use-sindre-session'
import type { SindreEvent } from '@/lib/sindre-stream'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

const mockSend = vi.fn(async () => {})

let mockHookResult: UseSindreSessionResult = {
	sessionId: null,
	status: 'idle',
	events: [],
	error: null,
	send: mockSend,
	reset: vi.fn(),
}

vi.mock('@/hooks/use-sindre-session', () => ({
	useSindreSession: () => mockHookResult,
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
})
