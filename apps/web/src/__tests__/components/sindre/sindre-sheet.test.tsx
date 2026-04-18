import { SindreSheet } from '@/components/sindre/sindre-sheet'
import type { UseSindreOneShotResult } from '@/hooks/use-sindre-one-shot'
import type { UseSindreSessionResult } from '@/hooks/use-sindre-session'
import { SindreProvider, useSindre } from '@/lib/sindre-context'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
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

type OpenerAttachments = Parameters<ReturnType<typeof useSindre>['openWithContext']>[0]

function Opener({ attachments }: { attachments?: OpenerAttachments }) {
	const { setOpen, openWithContext } = useSindre()
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				open-sheet
			</button>
			<button type="button" onClick={() => openWithContext(attachments ?? [])}>
				open-with-context
			</button>
		</>
	)
}

function OpenerWithMessage({
	attachments,
	message,
}: {
	attachments?: OpenerAttachments
	message: string
}) {
	const { openWithContext } = useSindre()
	return (
		<button type="button" onClick={() => openWithContext(attachments ?? [], message)}>
			open-with-message
		</button>
	)
}

describe('SindreSheet', () => {
	it('renders nothing visible while closed', () => {
		render(
			<Harness>
				<SindreSheet workspaceId="ws-1" sindreActorId="actor-sindre" />
			</Harness>,
		)
		expect(screen.queryByPlaceholderText('Message Sindre')).not.toBeInTheDocument()
	})

	it('mounts SindreChat inside the sheet when opened', async () => {
		render(
			<Harness>
				<Opener />
				<SindreSheet workspaceId="ws-1" sindreActorId="actor-sindre" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-sheet').click()
		})

		expect(await screen.findByPlaceholderText('Message Sindre')).toBeInTheDocument()
	})

	it('auto-sends a pendingMessage forwarded via openWithContext and clears it', async () => {
		render(
			<Harness>
				<Opener attachments={[]} />
				<OpenerWithMessage message="hey sindre" attachments={[]} />
				<SindreSheet workspaceId="ws-1" sindreActorId="actor-sindre" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-with-message').click()
		})

		// Sheet opens and SindreChat consumes the pending message via its
		// internal send path (to the persistent Sindre session in this case).
		await screen.findByPlaceholderText('Message Sindre')
		await waitFor(() => expect(mockSend).toHaveBeenCalledWith('hey sindre'))
	})

	it('seeds selection from pendingAttachments and clears them on open', async () => {
		render(
			<Harness>
				<Opener
					attachments={[
						{ kind: 'agent', id: 'actor-reviewer', name: 'Code Reviewer' },
						{ kind: 'object', id: 'obj-1', title: 'Bet Alpha', type: 'bet' },
					]}
				/>
				<SindreSheet workspaceId="ws-1" sindreActorId="actor-sindre" />
			</Harness>,
		)

		act(() => {
			screen.getByText('open-with-context').click()
		})

		// Composer placeholder swaps to the selected agent's name and chips
		// render for both seeded attachments.
		expect(await screen.findByPlaceholderText('Message Code Reviewer')).toBeInTheDocument()
		expect(screen.getByText('Code Reviewer')).toBeInTheDocument()
		expect(screen.getByText('Bet Alpha')).toBeInTheDocument()
	})
})
