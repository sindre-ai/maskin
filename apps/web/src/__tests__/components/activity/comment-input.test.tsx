import { CommentInput as CommentInputPublic } from '@/components/activity/comment-input'
import { NewDesignProvider } from '@/lib/new-design-context'
import { COMMENT_MAX_LENGTH } from '@maskin/shared'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// v2-composer assertions, so they render on the `new-design` side of the
// boundary. `NewDesignProvider` defaults to false, which is the legacy branch.
function CommentInput(props: React.ComponentProps<typeof CommentInputPublic>) {
	return (
		<NewDesignProvider value={true}>
			<CommentInputPublic {...props} />
		</NewDesignProvider>
	)
}

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

// The attachment queue is exercised for its contract only: what the composer
// hands to `submitDraft` when files are in play.
const mockDraftSubmit = vi.fn()
let mockDraftFiles: {
	tempId: string
	name: string
	sizeBytes: number
	status: string
	progress: number
}[] = []
vi.mock('@/lib/pending-comments-context', () => ({
	useDraft: () => ({
		files: mockDraftFiles,
		attach: vi.fn(),
		remove: vi.fn(),
		submit: mockDraftSubmit,
		discard: vi.fn(),
	}),
}))

describe('CommentInput', () => {
	beforeEach(() => {
		mockMutate.mockClear()
		mockIsPending = false
		mockGetStoredActor.mockReturnValue({ id: 'actor-1', name: 'Alice', type: 'human' })
		mockUseActors.mockReturnValue({ data: [] })
		mockDraftSubmit.mockClear()
		mockDraftSubmit.mockReturnValue('queued')
		mockDraftFiles = []
	})

	it("offers the + menu's three real affordances and the composer hint", async () => {
		const user = userEvent.setup()
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)

		expect(screen.getByText('Enter to send · @ to mention · + to attach')).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Add a file, object, or mention' }))
		expect(await screen.findByText('Attach a file')).toBeInTheDocument()
		expect(screen.getByText('Reference an object')).toBeInTheDocument()
		expect(screen.getByText('Mention an agent')).toBeInTheDocument()
		expect(screen.getByText('Attach a decision')).toBeInTheDocument()
	})

	it('attaches decision options and posts them as metadata.chips', async () => {
		const user = userEvent.setup()
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)

		await user.click(screen.getByRole('button', { name: 'Add a file, object, or mention' }))
		await user.click(await screen.findByText('Attach a decision'))

		const option = screen.getByRole('textbox', { name: 'Decision option' })
		await user.type(option, 'Ship it{Enter}')
		await user.type(option, 'Hold{Enter}')
		expect(screen.getByTestId('decision-attachment')).toHaveTextContent('Ship it')

		// An option can be taken back off before sending.
		await user.click(screen.getByRole('button', { name: 'Remove option Hold' }))
		expect(screen.queryByText('Hold')).not.toBeInTheDocument()

		await user.type(
			screen.getByPlaceholderText('Write a comment... Use @ to mention an agent'),
			'Which way do we go?',
		)
		await user.click(screen.getByRole('button', { name: /send/i }))

		expect(mockMutate).toHaveBeenCalledWith(
			expect.objectContaining({
				entity_id: 'obj-1',
				content: 'Which way do we go?',
				metadata: { chips: ['Ship it'] },
			}),
			expect.any(Object),
		)
	})

	it('carries an attachment and decision options on the same comment', async () => {
		mockDraftFiles = [
			{ tempId: 'f-1', name: 'metrics.png', sizeBytes: 1024, status: 'uploaded', progress: 100 },
		]
		const user = userEvent.setup()
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)

		await user.click(screen.getByRole('button', { name: 'Add a file, object, or mention' }))
		// Attaching a file no longer locks the decision affordance out.
		expect(await screen.findByText('Attach a decision')).not.toHaveAttribute('data-disabled', '')
		await user.click(screen.getByText('Attach a decision'))

		await user.type(screen.getByRole('textbox', { name: 'Decision option' }), 'Ship it{Enter}')
		await user.type(
			screen.getByPlaceholderText('Write a comment... Use @ to mention an agent'),
			'Chart attached — which way?',
		)
		await user.click(screen.getByRole('button', { name: /send/i }))

		// The queued path carries the same metadata shape as the direct one, and
		// the direct mutation is not used when files are in play.
		expect(mockDraftSubmit).toHaveBeenCalledWith({
			content: 'Chart attached — which way?',
			mentions: [],
			metadata: { chips: ['Ship it'] },
		})
		expect(mockMutate).not.toHaveBeenCalled()
	})

	// `submitDraft` returns 'no-attachments' when the queue has nothing to send:
	// the entry was never created, or every attachment was removed between the
	// composer reading `hasAttachments` and the click. In the second case it also
	// deletes the entry, so there is no queued row left to render a failure on.
	// Dropping the comment there loses the user's text silently.
	it('falls back to a direct post when the queue reports no attachments', async () => {
		mockDraftFiles = [
			{ tempId: 'f-1', name: 'metrics.png', sizeBytes: 1024, status: 'uploaded', progress: 100 },
		]
		mockDraftSubmit.mockReturnValue('no-attachments')
		const user = userEvent.setup()
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)

		await user.type(
			screen.getByPlaceholderText('Write a comment... Use @ to mention an agent'),
			'Still worth saying',
		)
		await user.click(screen.getByRole('button', { name: /send/i }))

		expect(mockDraftSubmit).toHaveBeenCalled()
		expect(mockMutate).toHaveBeenCalledWith(
			expect.objectContaining({ entity_id: 'obj-1', content: 'Still worth saying' }),
			expect.anything(),
		)
	})

	it('sends no metadata when no decision is attached', async () => {
		const user = userEvent.setup()
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)

		await user.type(
			screen.getByPlaceholderText('Write a comment... Use @ to mention an agent'),
			'Just a comment',
		)
		await user.click(screen.getByRole('button', { name: /send/i }))

		expect(mockMutate).toHaveBeenCalledWith(
			expect.not.objectContaining({ metadata: expect.anything() }),
			expect.any(Object),
		)
	})

	it('renders no mic when the browser has no SpeechRecognition', () => {
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)
		expect(screen.queryByRole('button', { name: /dictate/i })).not.toBeInTheDocument()
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
		expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument()
	})

	it('disables send when content is empty', () => {
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)
		expect(screen.getByRole('button', { name: /send/i })).toBeDisabled()
	})

	it('enables send when content has text', async () => {
		const user = userEvent.setup()
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)

		await user.type(
			screen.getByPlaceholderText('Write a comment... Use @ to mention an agent'),
			'Hello',
		)
		expect(screen.getByRole('button', { name: /send/i })).not.toBeDisabled()
	})

	it('disables send when isPending', async () => {
		const user = userEvent.setup()
		mockIsPending = true
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)

		await user.type(
			screen.getByPlaceholderText('Write a comment... Use @ to mention an agent'),
			'Hello',
		)
		expect(screen.getByRole('button', { name: /send/i })).toBeDisabled()
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

	it('does NOT submit on Enter when the primary pointer is coarse (iOS/mobile)', async () => {
		const originalMatchMedia = window.matchMedia
		window.matchMedia = ((query: string) =>
			({
				matches: query === '(pointer: coarse)',
				media: query,
				onchange: null,
				addEventListener: () => {},
				removeEventListener: () => {},
				addListener: () => {},
				removeListener: () => {},
				dispatchEvent: () => false,
			}) as unknown as MediaQueryList) as typeof window.matchMedia

		try {
			const user = userEvent.setup()
			render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)

			const textarea = screen.getByPlaceholderText(
				'Write a comment... Use @ to mention an agent',
			) as HTMLTextAreaElement
			await user.type(textarea, 'Line one{Enter}Line two')

			expect(mockMutate).not.toHaveBeenCalled()
			expect(textarea.value).toBe('Line one\nLine two')
		} finally {
			window.matchMedia = originalMatchMedia
		}
	})

	it('shortens the placeholder to a single line on mobile viewports', () => {
		const originalMatchMedia = window.matchMedia
		const originalInnerWidth = window.innerWidth
		window.matchMedia = ((query: string) =>
			({
				matches: query === '(max-width: 767px)',
				media: query,
				onchange: null,
				addEventListener: () => {},
				removeEventListener: () => {},
				addListener: () => {},
				removeListener: () => {},
				dispatchEvent: () => false,
			}) as unknown as MediaQueryList) as typeof window.matchMedia
		Object.defineProperty(window, 'innerWidth', { writable: true, value: 500 })

		try {
			render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)
			expect(screen.getByPlaceholderText('Write a comment...')).toBeInTheDocument()
			expect(
				screen.queryByPlaceholderText('Write a comment... Use @ to mention an agent'),
			).not.toBeInTheDocument()
		} finally {
			window.matchMedia = originalMatchMedia
			Object.defineProperty(window, 'innerWidth', { writable: true, value: originalInnerWidth })
		}
	})

	it('hides system actors from the @mention dropdown', async () => {
		const user = userEvent.setup()
		mockUseActors.mockReturnValue({
			data: [
				{ id: 'actor-2', name: 'Bob', type: 'agent', email: null, isSystem: false },
				{ id: 'actor-3', name: 'Workspace Coach', type: 'agent', email: null, isSystem: true },
			],
		})
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)

		const textarea = screen.getByPlaceholderText('Write a comment... Use @ to mention an agent')
		await user.type(textarea, '@')

		expect(screen.getByText('Bob')).toBeInTheDocument()
		expect(screen.queryByText('Workspace Coach')).not.toBeInTheDocument()
	})

	it('opens the @mention dropdown below the input by default', async () => {
		const user = userEvent.setup()
		mockUseActors.mockReturnValue({
			data: [{ id: 'actor-2', name: 'Bob', type: 'agent', email: null, isSystem: false }],
		})
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" />)

		await user.type(
			screen.getByPlaceholderText('Write a comment... Use @ to mention an agent'),
			'@',
		)

		const dropdown = screen.getByText('Bob').closest('div[class*="absolute"]')
		expect(dropdown).toHaveClass('mt-1')
		expect(dropdown).not.toHaveClass('bottom-full')
	})

	it('opens the @mention dropdown above the input when mentionDropdownPlacement="above"', async () => {
		const user = userEvent.setup()
		mockUseActors.mockReturnValue({
			data: [{ id: 'actor-2', name: 'Bob', type: 'agent', email: null, isSystem: false }],
		})
		render(<CommentInput workspaceId="ws-1" objectId="obj-1" mentionDropdownPlacement="above" />)

		await user.type(
			screen.getByPlaceholderText('Write a comment... Use @ to mention an agent'),
			'@',
		)

		const dropdown = screen.getByText('Bob').closest('div[class*="absolute"]')
		expect(dropdown).toHaveClass('bottom-full', 'mb-1')
		expect(dropdown).not.toHaveClass('mt-1')
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
			expect(screen.getByRole('button', { name: /send/i })).not.toBeDisabled()
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
			expect(screen.getByRole('button', { name: /send/i })).toBeDisabled()
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
