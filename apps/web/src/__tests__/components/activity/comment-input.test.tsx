import { CommentInput } from '@/components/activity/comment-input'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockMutate = vi.fn()
const mockGetStoredActor = vi.fn()
let mockIsPending = false

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => mockGetStoredActor(),
}))

vi.mock('@/hooks/use-events', () => ({
	useCreateComment: () => ({ mutate: mockMutate, isPending: mockIsPending }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [] }),
}))

describe('CommentInput', () => {
	beforeEach(() => {
		mockMutate.mockClear()
		mockIsPending = false
		mockGetStoredActor.mockReturnValue({ id: 'actor-1', name: 'Alice', type: 'human' })
	})

	it('returns null when no stored actor', () => {
		mockGetStoredActor.mockReturnValue(null)
		const { container } = render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)
		expect(container.firstChild).toBeNull()
	})

	it('renders textarea and send button', () => {
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)
		expect(screen.getByPlaceholderText('Comment or instruct an agent...')).toBeInTheDocument()
		expect(screen.getByRole('button')).toBeInTheDocument()
	})

	it('disables send when content is empty', () => {
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)
		expect(screen.getByRole('button')).toBeDisabled()
	})

	it('enables send when content has text', async () => {
		const user = userEvent.setup()
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)

		await user.type(screen.getByPlaceholderText('Comment or instruct an agent...'), 'Hello')
		expect(screen.getByRole('button')).not.toBeDisabled()
	})

	it('disables send when isPending', async () => {
		const user = userEvent.setup()
		mockIsPending = true
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)

		await user.type(screen.getByPlaceholderText('Comment or instruct an agent...'), 'Hello')
		expect(screen.getByRole('button')).toBeDisabled()
	})

	it('submits on Enter key', async () => {
		const user = userEvent.setup()
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)

		const textarea = screen.getByPlaceholderText('Comment or instruct an agent...')
		await user.type(textarea, 'Test comment{Enter}')
		expect(mockMutate).toHaveBeenCalled()
		expect(mockMutate.mock.calls[0][0]).toMatchObject({
			entity_id: 'obj-1',
			content: 'Test comment',
		})
	})
})
