import { ThreadComposer } from '@/components/chat/thread-composer'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceWrapper } from '../../setup'

const mockMutateAsync = vi.fn()

vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))

const actors = vi.hoisted(() => [
	{ id: 'me', name: 'Me', type: 'human', isSystem: false, description: null, email: null },
	{ id: 'agent-1', name: 'Forge', type: 'agent', isSystem: false, description: null, email: null },
	{
		id: 'agent-2',
		name: 'Developer',
		type: 'agent',
		isSystem: false,
		description: null,
		email: null,
	},
])
vi.mock('@/hooks/use-actors', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/hooks/use-actors')>()),
	useActors: () => ({ data: actors }),
}))

vi.mock('@/hooks/use-conversation', () => ({
	useSendMessage: () => ({ mutateAsync: mockMutateAsync, isPending: false }),
	useConversation: () => ({ data: undefined }),
	useConversationMessages: () => ({ data: undefined, hasNextPage: false }),
	flattenMessagesOldestFirst: () => [],
}))

const FORGE = { id: 'agent-1', name: 'Forge' }

// The reply box writes in the tag input: a tag is a chip inside the sentence.
const replyBox = () => screen.findByLabelText('Reply in thread')
const chips = (box: HTMLElement) => Array.from(box.querySelectorAll('[data-tag-id]'))

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
		await replyBox()
		expect(await screen.findByText('Reply to Forge…')).toBeInTheDocument()
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
		expect((await replyBox()).textContent).toBe('')
	})

	it('keeps a picked tag in the sentence and sends its id with the recipient', async () => {
		const user = userEvent.setup()
		renderReply()
		const box = await replyBox()

		await user.type(box, 'thanks @Dev')
		await user.keyboard('{Enter}')
		await waitFor(() => expect(chips(box)).toHaveLength(1))
		expect(chips(box)[0]).toHaveAttribute('data-tag-id', 'agent-2')
		await user.type(box, 'go ahead')
		await user.click(screen.getByRole('button', { name: 'Send message' }))

		await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1))
		expect(mockMutateAsync).toHaveBeenCalledWith(
			expect.objectContaining({
				content: 'thanks @Developer go ahead',
				thread_root_id: 7,
				metadata: { mentions: ['agent-1', 'agent-2'] },
			}),
		)
	})

	it('keeps the recipient for the next reply when the reply tagged that same agent', async () => {
		const user = userEvent.setup()
		renderReply()
		const box = await replyBox()

		await user.type(box, 'thanks @For')
		await user.keyboard('{Enter}')
		await waitFor(() => expect(chips(box)).toHaveLength(1))
		expect(chips(box)[0]).toHaveAttribute('data-tag-id', 'agent-1')
		await user.click(screen.getByRole('button', { name: 'Send message' }))

		await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1))
		await waitFor(() => expect(chips(box)).toHaveLength(0))
		expect(await screen.findByLabelText('Selected context')).toHaveTextContent('Forge')
		expect(screen.getByText('Reply to Forge…')).toBeInTheDocument()
	})

	it('sends no id for an @name that never went through the picker', async () => {
		const user = userEvent.setup()
		renderReply({ recipient: null })
		const box = await replyBox()

		await user.type(box, 'thanks @Developer')
		await user.keyboard('{Escape}')
		await user.type(box, ' go ahead')
		await user.click(screen.getByRole('button', { name: 'Send message' }))

		await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1))
		const sent = mockMutateAsync.mock.calls[0]?.[0]
		expect(sent.content).toBe('thanks @Developer go ahead')
		expect(sent.metadata).toBeUndefined()
	})

	it('shows the recipient as a removable pill, and a tag as a chip with no pill', async () => {
		const user = userEvent.setup()
		renderReply()
		const box = await replyBox()

		const row = await screen.findByLabelText('Selected context')
		expect(row).toHaveTextContent('Forge')

		await user.type(box, '@Dev')
		await user.keyboard('{Enter}')
		await waitFor(() => expect(chips(box)).toHaveLength(1))
		expect(screen.getByLabelText('Selected context')).not.toHaveTextContent('Developer')
	})
})
