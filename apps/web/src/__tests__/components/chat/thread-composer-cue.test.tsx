import { ThreadComposer } from '@/components/chat/thread-composer'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

const state = vi.hoisted(() => ({
	flagOn: true,
	conversation: undefined as
		| { participants: Array<{ actorId: string; actorName: string; actorType: string }> }
		| undefined,
	// Newest first, the way the server pages them. Undefined while loading.
	messages: undefined as
		| Array<{
				id: number
				actorId: string
				actorType: 'human' | 'agent'
				kind: 'message' | 'system'
		  }>
		| undefined,
	hasNextPage: false,
	actors: [] as Array<Record<string, unknown>>,
}))
const mockMutateAsync = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})
vi.mock('@/hooks/use-feature-flag', () => ({ useFeatureFlag: () => state.flagOn }))
vi.mock('@/hooks/use-conversation', async () => {
	const actual = await vi.importActual<typeof import('@/hooks/use-conversation')>(
		'@/hooks/use-conversation',
	)
	return {
		...actual,
		useSendMessage: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
		useConversation: () => ({ data: state.conversation }),
		useConversationMessages: () => ({
			data: state.messages ? { pages: [{ messages: state.messages, has_more: false }] } : undefined,
			hasNextPage: state.hasNextPage,
		}),
	}
})
vi.mock('@/hooks/use-sessions', async () => {
	const actual =
		await vi.importActual<typeof import('@/hooks/use-sessions')>('@/hooks/use-sessions')
	return { ...actual, useActiveSessionsForConversation: () => ({ data: [] }) }
})
vi.mock('@/hooks/use-actors', async () => {
	const actual = await vi.importActual<typeof import('@/hooks/use-actors')>('@/hooks/use-actors')
	return { ...actual, useActors: () => ({ data: state.actors }) }
})
vi.mock('@/lib/auth', async () => {
	const actual = await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth')
	return { ...actual, getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }
})

const ME = { actorId: 'me', actorName: 'Me', actorType: 'human' }
const SAM = { actorId: 'sam', actorName: 'Sam', actorType: 'human' }
const FORGE = { actorId: 'forge', actorName: 'Forge', actorType: 'agent' }
const SENTINEL = { actorId: 'sentinel', actorName: 'Sentinel', actorType: 'agent' }

const said = (id: number, actorId: string, actorType: 'human' | 'agent') => ({
	id,
	actorId,
	actorType,
	kind: 'message' as const,
})

function renderComposer() {
	return render(<ThreadComposer workspaceId="ws-test" conversationId="convo-1" />, {
		wrapper: createWorkspaceWrapper(),
	})
}

const box = () => screen.getByLabelText('Message this conversation')

beforeEach(() => {
	sessionStorage.clear()
	mockMutateAsync.mockReset()
	state.flagOn = true
	state.conversation = { participants: [ME, SAM, FORGE, SENTINEL] }
	state.messages = []
	state.hasNextPage = false
	state.actors = []
})

describe('ThreadComposer — group-chat cue', () => {
	it('keeps today’s placeholder and adds nothing when the flag is off', () => {
		state.flagOn = false
		state.messages = [said(2, 'sam', 'human'), said(1, 'forge', 'agent')]
		renderComposer()

		// Today: the first participant who is not you.
		expect(box()).toHaveAttribute('placeholder', 'Reply to Sam…')
		expect(box()).not.toHaveAttribute('aria-describedby')
	})

	it('names the agent who spoke last', () => {
		state.messages = [said(2, 'forge', 'agent'), said(1, 'me', 'human')]
		renderComposer()

		expect(box()).toHaveAttribute('placeholder', 'Reply to Forge…')
	})

	it('says nobody will answer when a person spoke last, only once the box is used', async () => {
		state.messages = [said(2, 'sam', 'human'), said(1, 'forge', 'agent')]
		const user = userEvent.setup()
		renderComposer()

		expect(box()).toHaveAttribute('placeholder', 'Message this conversation')
		// Nothing is shown on arrival, even though nobody would answer.
		expect(screen.queryByText('No agent will reply. Tag one with @.')).not.toBeInTheDocument()

		await user.click(box())
		const hint = await screen.findByText('No agent will reply. Tag one with @.')
		expect(hint).toHaveAttribute('aria-live', 'polite')
		expect(box()).toHaveAttribute('aria-describedby', hint.id)
		expect(box()).toHaveAccessibleName('Message this conversation')
	})

	it('shows the hint for typed text even after the box loses focus', async () => {
		state.messages = [said(2, 'sam', 'human')]
		const user = userEvent.setup()
		renderComposer()

		await user.type(box(), 'hello')
		await user.tab()

		expect(screen.getByText('No agent will reply. Tag one with @.')).toBeInTheDocument()
	})

	it('hides the hint while a send error shows', async () => {
		state.messages = [said(2, 'sam', 'human')]
		mockMutateAsync.mockRejectedValueOnce(new Error('boom'))
		const user = userEvent.setup()
		renderComposer()

		await user.type(box(), 'hello')
		expect(screen.getByText('No agent will reply. Tag one with @.')).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Send message' }))

		await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
		expect(screen.queryByText('No agent will reply. Tag one with @.')).not.toBeInTheDocument()
	})

	it('puts a decorative info icon before the hint, and none while the hint is empty', async () => {
		state.messages = [said(2, 'sam', 'human')]
		const user = userEvent.setup()
		renderComposer()

		const region = document.getElementById(box().getAttribute('aria-describedby') ?? '')
		expect(region).toBeEmptyDOMElement()
		expect(region).not.toHaveClass('mb-2')

		await user.click(box())
		const icon = (await screen.findByText('No agent will reply. Tag one with @.')).querySelector(
			'svg',
		)
		expect(icon).toHaveAttribute('aria-hidden', 'true')
		expect(region).toHaveClass('mb-2')
	})

	describe('picking a tag from the @ picker', () => {
		beforeEach(() => {
			state.actors = [
				{
					id: 'forge',
					name: 'Forge',
					type: 'agent',
					description: null,
					email: null,
					isSystem: false,
				},
			]
			state.messages = [said(2, 'sam', 'human')]
		})

		it('leaves the box empty so the cue placeholder shows, and keeps focus there', async () => {
			const user = userEvent.setup()
			renderComposer()

			await user.type(box(), '@For')
			await user.keyboard('{Enter}')

			await waitFor(() => expect(box()).toHaveValue(''))
			expect(box()).toHaveAttribute('placeholder')
			await waitFor(() => expect(box()).toHaveFocus())
		})

		it('still keeps the text around the tag', async () => {
			const user = userEvent.setup()
			renderComposer()

			await user.type(box(), 'hello @For')
			await user.keyboard('{Enter}')

			// Same as before this change: the typed space stays and the insert adds one.
			await waitFor(() => expect(box()).toHaveValue('hello  '))
		})
	})

	it('leaves 1-1 chats as they are', () => {
		state.conversation = { participants: [ME, FORGE] }
		renderComposer()

		expect(box()).toHaveAttribute('placeholder', 'Reply to Forge…')
		expect(box()).not.toHaveAttribute('aria-describedby')
	})

	describe('while data is still loading', () => {
		it('shows the neutral placeholder and no hint, and the box still takes text and send', async () => {
			state.conversation = undefined
			state.messages = undefined
			mockMutateAsync.mockResolvedValueOnce({})
			const user = userEvent.setup()
			renderComposer()

			expect(box()).toHaveAttribute('placeholder', 'Message this conversation')
			expect(box()).toBeEnabled()
			await user.type(box(), 'hello')
			expect(box()).toHaveValue('hello')
			expect(screen.queryByText(/No agent will reply/)).not.toBeInTheDocument()
			await user.click(screen.getByRole('button', { name: 'Send message' }))
			await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1))
		})

		it('says nothing while messages load, and does not guess a name', () => {
			state.messages = undefined
			renderComposer()

			expect(box()).toHaveAttribute('placeholder', 'Message this conversation')
			expect(box()).toBeEnabled()
		})

		it('does not call the chat new while older pages exist', async () => {
			state.messages = [said(1, 'me', 'human')]
			state.hasNextPage = true
			const user = userEvent.setup()
			renderComposer()

			await user.click(box())
			expect(box()).toHaveAttribute('placeholder', 'Message this conversation')
			expect(screen.queryByText(/No agent will reply/)).not.toBeInTheDocument()
		})
	})
})
