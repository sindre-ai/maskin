import { ThreadComposer } from '@/components/chat/thread-composer'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

const mockMutateAsync = vi.fn()

vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))

vi.mock('@/hooks/use-conversation', () => ({
	useSendMessage: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
	useConversation: () => ({ data: undefined }),
	useConversationMessages: () => ({ data: undefined, hasNextPage: false }),
	flattenMessagesOldestFirst: () => [],
}))

const FORGE = { id: 'agent-1', name: 'Forge' }

function renderReply(
	reply: Partial<NonNullable<React.ComponentProps<typeof ThreadComposer>['reply']>> = {},
) {
	const onSent = vi.fn()
	const props = {
		rootId: 7,
		recipient: FORGE,
		alsoInChannel: false,
		onSent,
		...reply,
	}
	const view = render(<ThreadComposer workspaceId="ws-1" conversationId="conv-1" reply={props} />, {
		wrapper: createWorkspaceWrapper(),
	})
	return { onSent, ...view, props }
}

describe('ThreadComposer — reply mode', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		sessionStorage.clear()
		mockMutateAsync.mockResolvedValue({})
	})

	it('labels the box for a reply and names the recipient in the placeholder', async () => {
		renderReply()
		const box = await screen.findByLabelText('Reply in thread')
		await waitFor(() => expect(box).toHaveAttribute('placeholder', 'Reply to Forge…'))
	})

	it('sends under the root with the also-in-channel choice, then reports it sent', async () => {
		const user = userEvent.setup()
		const { onSent } = renderReply({ alsoInChannel: true })

		await user.type(await screen.findByLabelText('Reply in thread'), 'on it')
		await user.click(screen.getByRole('button', { name: 'Send message' }))

		expect(mockMutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				content: 'on it',
				thread_root_id: 7,
				also_in_channel: true,
				metadata: { mentions: ['agent-1'] },
			}),
		)
		await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1))
	})

	it('addresses the next reply to the same recipient after a send', async () => {
		const user = userEvent.setup()
		renderReply()
		const box = await screen.findByLabelText('Reply in thread')

		await user.type(box, 'first')
		await user.click(screen.getByRole('button', { name: 'Send message' }))
		await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1))

		await user.type(box, 'second')
		await user.click(screen.getByRole('button', { name: 'Send message' }))
		await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(2))
		expect(mockMutateAsync).toHaveBeenLastCalledWith(
			expect.objectContaining({ content: 'second', metadata: { mentions: ['agent-1'] } }),
		)
	})

	it('mentions nobody when there is no agent recipient', async () => {
		const user = userEvent.setup()
		renderReply({ recipient: null })

		await user.type(await screen.findByLabelText('Reply in thread'), 'hello')
		await user.click(screen.getByRole('button', { name: 'Send message' }))

		const sent = mockMutateAsync.mock.calls[0]?.[0]
		expect(sent).toMatchObject({ thread_root_id: 7, also_in_channel: false })
		expect(sent.metadata).toBeUndefined()
	})

	it('keeps a separate draft per thread', async () => {
		const user = userEvent.setup()
		const first = renderReply({ rootId: 7 })
		await user.type(await screen.findByLabelText('Reply in thread'), 'half a thought')
		first.unmount()

		renderReply({ rootId: 8 })
		expect(await screen.findByLabelText('Reply in thread')).toHaveValue('')
	})
})
