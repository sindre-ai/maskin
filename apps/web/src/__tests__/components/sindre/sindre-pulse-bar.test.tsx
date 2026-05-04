import { SindrePulseBar } from '@/components/sindre/sindre-pulse-bar'
import type { UseSindreOneShotResult } from '@/hooks/use-sindre-one-shot'
import type { UseSindreSessionResult } from '@/hooks/use-sindre-session'
import { SindreProvider, useSindre } from '@/lib/sindre-context'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestQueryClient } from '../../setup'

const mockSend = vi.fn(async () => {})
const mockOneShotSend = vi.fn(async () => {})
const mockOneShotClear = vi.fn()

let mockHookResult: UseSindreSessionResult = {
	sessionId: null,
	status: 'ready',
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

vi.mock('@/lib/api', () => ({
	api: {
		actors: { list: vi.fn().mockResolvedValue([]) },
		objects: { list: vi.fn().mockResolvedValue([]), search: vi.fn().mockResolvedValue([]) },
	},
}))

global.ResizeObserver = vi.fn().mockImplementation(() => ({
	observe: vi.fn(),
	unobserve: vi.fn(),
	disconnect: vi.fn(),
}))
Element.prototype.scrollIntoView = vi.fn()

beforeEach(() => {
	mockSend.mockClear()
	mockOneShotSend.mockClear()
	mockOneShotClear.mockClear()
	mockHookResult = {
		sessionId: null,
		status: 'ready',
		events: [],
		error: null,
		send: mockSend,
		reset: vi.fn(),
	}
	mockOneShotResult = {
		sessionId: null,
		status: 'idle',
		events: [],
		error: null,
		send: mockOneShotSend,
		clear: mockOneShotClear,
	}
	localStorage.clear()
})

function Harness({ children }: { children: ReactNode }) {
	const client = createTestQueryClient()
	return (
		<QueryClientProvider client={client}>
			<SindreProvider workspaceId="ws-1">{children}</SindreProvider>
		</QueryClientProvider>
	)
}

type SindreState = ReturnType<typeof useSindre>
type StateRef = { current: SindreState | null }

function SindreProbe({ onState }: { onState: (state: SindreState) => void }) {
	const state = useSindre()
	onState(state)
	return null
}

function makeStateRef() {
	const ref: StateRef = { current: null }
	const onState = (s: SindreState) => {
		ref.current = s
	}
	return { ref, onState }
}

function expectCurrent(ref: StateRef): SindreState {
	if (!ref.current) throw new Error('SindreProbe never captured a context value')
	return ref.current
}

describe('SindrePulseBar', () => {
	it('renders the pulse-bar composer (input only, no transcript)', () => {
		render(
			<Harness>
				<SindrePulseBar workspaceId="ws-1" sindreActorId="actor-sindre" />
			</Harness>,
		)

		expect(screen.getByPlaceholderText('Ask Sindre anything…')).toBeInTheDocument()
		// Empty-transcript copy from <SindreTranscript> should NOT render here —
		// the bar is an input-only surface.
		expect(screen.queryByText(/Ask Sindre about your workspace/i)).not.toBeInTheDocument()
	})

	it('on submit, opens the sheet and forwards the typed message as pendingMessage', async () => {
		const { ref, onState } = makeStateRef()

		render(
			<Harness>
				<SindreProbe onState={onState} />
				<SindrePulseBar workspaceId="ws-1" sindreActorId="actor-sindre" />
			</Harness>,
		)

		expect(expectCurrent(ref).open).toBe(false)

		const textarea = screen.getByPlaceholderText('Ask Sindre anything…') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'hey sindre' } })
		fireEvent.click(screen.getByRole('button', { name: /send message/i }))

		await waitFor(() => expect(expectCurrent(ref).open).toBe(true))
		expect(expectCurrent(ref).pendingMessage).toBe('hey sindre')

		// The pulse bar does NOT send directly — the sheet (via the forwarded
		// message) owns the send path.
		expect(mockSend).not.toHaveBeenCalled()
		expect(mockOneShotSend).not.toHaveBeenCalled()

		// Textarea is cleared on success so the bar is ready for the next query.
		await waitFor(() => expect(textarea.value).toBe(''))
	})

	it('forwards no attachments when no selection is staged', async () => {
		const { ref, onState } = makeStateRef()

		render(
			<Harness>
				<SindreProbe onState={onState} />
				<SindrePulseBar workspaceId="ws-1" sindreActorId="actor-sindre" />
			</Harness>,
		)

		fireEvent.change(screen.getByPlaceholderText('Ask Sindre anything…'), {
			target: { value: 'plain question' },
		})
		fireEvent.click(screen.getByRole('button', { name: /send message/i }))

		await waitFor(() => expect(expectCurrent(ref).pendingAttachments).toEqual([]))
		expect(expectCurrent(ref).pendingMessage).toBe('plain question')
	})

	it('submits on Enter and forwards to the sheet', async () => {
		const { ref, onState } = makeStateRef()

		render(
			<Harness>
				<SindreProbe onState={onState} />
				<SindrePulseBar workspaceId="ws-1" sindreActorId="actor-sindre" />
			</Harness>,
		)

		const textarea = screen.getByPlaceholderText('Ask Sindre anything…') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'via enter' } })
		fireEvent.keyDown(textarea, { key: 'Enter' })

		await waitFor(() => expect(expectCurrent(ref).open).toBe(true))
		expect(expectCurrent(ref).pendingMessage).toBe('via enter')
	})

	it('ignores empty or whitespace-only submits', () => {
		const { ref, onState } = makeStateRef()

		render(
			<Harness>
				<SindreProbe onState={onState} />
				<SindrePulseBar workspaceId="ws-1" sindreActorId="actor-sindre" />
			</Harness>,
		)

		const textarea = screen.getByPlaceholderText('Ask Sindre anything…') as HTMLTextAreaElement
		const sendButton = screen.getByRole('button', { name: /send message/i })
		expect(sendButton).toBeDisabled()

		fireEvent.change(textarea, { target: { value: '   \n  ' } })
		expect(sendButton).toBeDisabled()
		fireEvent.keyDown(textarea, { key: 'Enter' })

		expect(expectCurrent(ref).open).toBe(false)
		expect(expectCurrent(ref).pendingMessage).toBeNull()
	})

	it('clears its local selection after forwarding to the sheet', async () => {
		const { ref, onState } = makeStateRef()

		render(
			<Harness>
				<SindreProbe onState={onState} />
				<SindrePulseBar workspaceId="ws-1" sindreActorId="actor-sindre" />
			</Harness>,
		)

		const textarea = screen.getByPlaceholderText('Ask Sindre anything…') as HTMLTextAreaElement

		// First submit.
		fireEvent.change(textarea, { target: { value: 'first' } })
		fireEvent.click(screen.getByRole('button', { name: /send message/i }))

		await waitFor(() => expect(expectCurrent(ref).pendingMessage).toBe('first'))

		// The sheet auto-consumes and clears — simulate by calling the
		// context's clearPendingMessage here.
		act(() => {
			expectCurrent(ref).clearPendingMessage()
		})
		expect(expectCurrent(ref).pendingMessage).toBeNull()

		// Second submit — the bar must still be usable (local state reset).
		fireEvent.change(textarea, { target: { value: 'second' } })
		fireEvent.click(screen.getByRole('button', { name: /send message/i }))

		await waitFor(() => expect(expectCurrent(ref).pendingMessage).toBe('second'))
	})
})
