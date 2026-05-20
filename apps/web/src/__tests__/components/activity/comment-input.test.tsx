import { CommentInput } from '@/components/activity/comment-input'
import { COMMENT_MAX_LENGTH } from '@maskin/shared'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockMutate = vi.fn()
const mockGetStoredActor = vi.fn()
const mockUseActors = vi.fn()
let mockIsPending = false

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => mockGetStoredActor(),
}))

vi.mock('@/hooks/use-events', () => ({
	useCreateComment: () => ({ mutate: mockMutate, isPending: mockIsPending }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => mockUseActors(),
}))

describe('CommentInput', () => {
	beforeEach(() => {
		mockMutate.mockClear()
		mockIsPending = false
		mockGetStoredActor.mockReturnValue({ id: 'actor-1', name: 'Alice', type: 'human' })
		mockUseActors.mockReturnValue({ data: [] })
	})

	it('returns null when no stored actor', () => {
		mockGetStoredActor.mockReturnValue(null)
		const { container } = render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)
		expect(container.firstChild).toBeNull()
	})

	it('renders textarea and send button', () => {
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)
		expect(
			screen.getByPlaceholderText('Write a comment... Use @ to mention an agent'),
		).toBeInTheDocument()
		expect(screen.getByRole('button')).toBeInTheDocument()
	})

	it('disables send when content is empty', () => {
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)
		expect(screen.getByRole('button')).toBeDisabled()
	})

	it('enables send when content has text', async () => {
		const user = userEvent.setup()
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)

		await user.type(
			screen.getByPlaceholderText('Write a comment... Use @ to mention an agent'),
			'Hello',
		)
		expect(screen.getByRole('button')).not.toBeDisabled()
	})

	it('disables send when isPending', async () => {
		const user = userEvent.setup()
		mockIsPending = true
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)

		await user.type(
			screen.getByPlaceholderText('Write a comment... Use @ to mention an agent'),
			'Hello',
		)
		expect(screen.getByRole('button')).toBeDisabled()
	})

	it('submits on Enter key', async () => {
		const user = userEvent.setup()
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)

		const textarea = screen.getByPlaceholderText('Write a comment... Use @ to mention an agent')
		await user.type(textarea, 'Test comment{Enter}')
		expect(mockMutate).toHaveBeenCalled()
		expect(mockMutate.mock.calls[0][0]).toMatchObject({
			entity_id: 'obj-1',
			content: 'Test comment',
		})
	})

	it('hides system actors from the @mention dropdown', async () => {
		const user = userEvent.setup()
		mockUseActors.mockReturnValue({
			data: [
				{ id: 'actor-2', name: 'Bob', type: 'agent', email: null, isSystem: false },
				{ id: 'actor-3', name: 'Sindre', type: 'agent', email: null, isSystem: true },
			],
		})
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)

		const textarea = screen.getByPlaceholderText('Write a comment... Use @ to mention an agent')
		await user.type(textarea, '@')

		expect(screen.getByText('Bob')).toBeInTheDocument()
		expect(screen.queryByText('Sindre')).not.toBeInTheDocument()
	})

	it('renders an inline highlight chip for typed @mentions', async () => {
		const user = userEvent.setup()
		mockUseActors.mockReturnValue({
			data: [
				{
					id: 'actor-2',
					name: 'Senior Developer',
					type: 'agent',
					email: null,
					isSystem: false,
				},
			],
		})
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)

		const textarea = screen.getByPlaceholderText('Write a comment... Use @ to mention an agent')
		await user.type(textarea, 'hi @Senior Developer ')

		const chip = screen.getByText('@Senior Developer')
		expect(chip).toBeInTheDocument()
		expect(chip.tagName).toBe('SPAN')
	})

	describe('character limit', () => {
		const COUNTER_THRESHOLD = Math.ceil(COMMENT_MAX_LENGTH * 0.9)

		// fireEvent.change is much faster than userEvent.type for thousands of
		// characters and wraps the update in act() automatically.
		function setValue(text: string) {
			const ta = screen.getByPlaceholderText(
				'Write a comment... Use @ to mention an agent',
			) as HTMLTextAreaElement
			fireEvent.change(ta, { target: { value: text } })
			return ta
		}

		it('hides the counter for short comments', async () => {
			const user = userEvent.setup()
			render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)
			await user.type(
				screen.getByPlaceholderText('Write a comment... Use @ to mention an agent'),
				'hi',
			)
			expect(screen.queryByText(new RegExp(`/\\s*${COMMENT_MAX_LENGTH}$`))).not.toBeInTheDocument()
		})

		it('shows the counter once content reaches 90% of the limit', () => {
			render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)
			setValue('x'.repeat(COUNTER_THRESHOLD))

			expect(
				screen.getByText(new RegExp(`^${COUNTER_THRESHOLD}\\s*/\\s*${COMMENT_MAX_LENGTH}$`)),
			).toBeInTheDocument()
			expect(screen.getByRole('button')).not.toBeDisabled()
		})

		it('disables submit, sets aria-invalid, and tints the counter when over the limit', () => {
			render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)
			const ta = setValue('x'.repeat(COMMENT_MAX_LENGTH + 5))

			const counter = screen.getByText(
				new RegExp(`^${COMMENT_MAX_LENGTH + 5}\\s*/\\s*${COMMENT_MAX_LENGTH}$`),
			)
			expect(counter).toBeInTheDocument()
			expect(counter.className).toContain('text-error')
			expect(ta).toHaveAttribute('aria-invalid', 'true')
			expect(screen.getByRole('button')).toBeDisabled()
		})

		it('does not submit when Enter is pressed over the limit', async () => {
			const user = userEvent.setup()
			render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)
			const ta = setValue('x'.repeat(COMMENT_MAX_LENGTH + 1))
			ta.focus()
			await user.keyboard('{Enter}')
			expect(mockMutate).not.toHaveBeenCalled()
		})

		// Regression: raw length and trimmed length must agree on whether to block
		// submit, otherwise trailing whitespace at the boundary lets Enter sneak
		// through while the UI shows the input as over the limit.
		it('does not submit when raw length is over the limit but trimmed length is not', async () => {
			const user = userEvent.setup()
			render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)
			const ta = setValue(`${'x'.repeat(COMMENT_MAX_LENGTH)}  `)
			ta.focus()
			await user.keyboard('{Enter}')
			expect(mockMutate).not.toHaveBeenCalled()
		})
	})
})
