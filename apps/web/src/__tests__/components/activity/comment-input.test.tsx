import { CommentInput } from '@/components/activity/comment-input'
import { COMMENT_MAX_LENGTH } from '@maskin/shared'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { TestWrapper } from '../../setup'

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

vi.mock('@/hooks/use-conversations', () => ({
	useConversationsInfinite: () => ({ data: undefined }),
}))

// The reference picker is stubbed down to the one thing the composer cares
// about: a button that hands back a picked object.
vi.mock('@/components/chat/slash-picker', () => ({
	SlashPicker: ({
		open,
		onSelect,
	}: {
		open: boolean
		onSelect: (result: {
			kind: string
			ref: { id: string; title?: string; name?: string; type?: string }
		}) => void
	}) =>
		open ? (
			<>
				<button
					type="button"
					onClick={() =>
						onSelect({ kind: 'object', ref: { id: 'obj-9', title: 'Retry window', type: 'bet' } })
					}
				>
					pick-object
				</button>
				<button
					type="button"
					onClick={() => onSelect({ kind: 'agent', ref: { id: 'actor-2', name: 'Bob' } })}
				>
					pick-agent
				</button>
			</>
		) : null,
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

const BOB = { id: 'actor-2', name: 'Bob', type: 'agent', email: null, isSystem: false }
const CAROL = { id: 'actor-3', name: 'Carol', type: 'agent', email: null, isSystem: false }

function renderInput(props: Partial<ComponentProps<typeof CommentInput>> = {}) {
	return render(<CommentInput workspaceId="ws-1" objectId="obj-1" {...props} />, {
		wrapper: TestWrapper,
	})
}

const box = () => screen.getByRole('textbox', { name: 'Comment' })
const chips = () => Array.from(box().querySelectorAll('[data-tag-id]'))

/** Puts the caret at `offset` in `node`. */
function caretIn(node: Node, offset: number) {
	const range = document.createRange()
	range.setStart(node, offset)
	range.collapse(true)
	const sel = document.getSelection()
	sel?.removeAllRanges()
	sel?.addRange(range)
}

/** Types `text` at the end of the box the way a keystroke would: edit the DOM, then input. */
function typeText(text: string) {
	const root = box()
	const last = root.lastChild
	let node: Text
	if (last && last.nodeType === 3) {
		node = last as Text
		node.data += text
	} else {
		node = document.createTextNode(text)
		root.appendChild(node)
	}
	caretIn(node, node.data.length)
	fireEvent.input(root)
}

/** Types "@query", waits for the picker and picks the first row with Enter. */
async function pickTag(query: string, name: RegExp) {
	typeText(`@${query}`)
	await screen.findByRole('option', { name })
	fireEvent.keyDown(box(), { key: 'Enter' })
}

describe('CommentInput', () => {
	beforeEach(() => {
		document.getSelection()?.removeAllRanges()
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
		renderInput()

		expect(screen.getByText('Enter to send · @ to mention · + to attach')).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Add a file, object, or mention' }))
		expect(await screen.findByText('Attach a file')).toBeInTheDocument()
		expect(screen.getByText('Reference an object')).toBeInTheDocument()
		expect(screen.getByText('Mention an agent')).toBeInTheDocument()
		// Options for the reader to pick from are a `decision`, which only an
		// agent authors. The composer used to offer a second, weaker way here.
		expect(screen.queryByText('Attach a decision')).not.toBeInTheDocument()
	})

	it('posts picked objects as metadata.refs alongside the comment body', async () => {
		const user = userEvent.setup()
		renderInput()

		await user.click(screen.getByRole('button', { name: 'Add a file, object, or mention' }))
		await user.click(await screen.findByText('Reference an object'))
		await user.click(await screen.findByRole('button', { name: 'pick-object' }))

		typeText('See this one')
		await user.click(screen.getByRole('button', { name: /send/i }))

		expect(mockMutate).toHaveBeenCalledWith(
			expect.objectContaining({
				content: 'See this one',
				metadata: { refs: ['obj-9'] },
			}),
			expect.any(Object),
		)
	})

	// `createCommentSchema.content` is `.min(1)`, so a references-only comment
	// would be a guaranteed 400 — the composer must not offer to send one.
	it('keeps send disabled, and posts nothing, when only a reference is attached', async () => {
		const user = userEvent.setup()
		renderInput()

		await user.click(screen.getByRole('button', { name: 'Add a file, object, or mention' }))
		await user.click(await screen.findByText('Reference an object'))
		await user.click(await screen.findByRole('button', { name: 'pick-object' }))

		const send = screen.getByRole('button', { name: /send/i })
		expect(send).toBeDisabled()

		fireEvent.click(send)
		expect(mockMutate).not.toHaveBeenCalled()
	})

	it('carries an attachment and the comment body on the same submit', async () => {
		mockDraftFiles = [
			{ tempId: 'f-1', name: 'metrics.png', sizeBytes: 1024, status: 'uploaded', progress: 100 },
		]
		const user = userEvent.setup()
		renderInput()

		typeText('Chart attached — which way?')
		await user.click(screen.getByRole('button', { name: /send/i }))

		// The queued path carries the same shape as the direct one, and the
		// direct mutation is not used when files are in play.
		expect(mockDraftSubmit).toHaveBeenCalledWith({
			content: 'Chart attached — which way?',
			mentions: [],
			metadata: undefined,
		})
		expect(mockMutate).not.toHaveBeenCalled()
	})

	// A tag has to survive the trip through the attachment queue, which builds
	// its own request later. Both paths read the same id list.
	it('delivers a picked tag through the attachment queue', async () => {
		mockUseActors.mockReturnValue({ data: [BOB] })
		mockDraftFiles = [
			{ tempId: 'f-1', name: 'metrics.png', sizeBytes: 1024, status: 'uploaded', progress: 100 },
		]
		const user = userEvent.setup()
		renderInput()

		typeText('cc ')
		await pickTag('bo', /Bob/)
		typeText('on the chart')
		await user.click(screen.getByRole('button', { name: /send/i }))

		expect(mockDraftSubmit).toHaveBeenCalledWith({
			content: 'cc @Bob on the chart',
			mentions: ['actor-2'],
			metadata: undefined,
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
		renderInput()

		typeText('Still worth saying')
		await user.click(screen.getByRole('button', { name: /send/i }))

		expect(mockDraftSubmit).toHaveBeenCalled()
		expect(mockMutate).toHaveBeenCalledWith(
			expect.objectContaining({ entity_id: 'obj-1', content: 'Still worth saying' }),
			expect.anything(),
		)
	})

	it('sends no metadata when no decision is attached', async () => {
		const user = userEvent.setup()
		renderInput()

		typeText('Just a comment')
		await user.click(screen.getByRole('button', { name: /send/i }))

		expect(mockMutate).toHaveBeenCalledWith(
			expect.not.objectContaining({ metadata: expect.anything() }),
			expect.any(Object),
		)
	})

	it('renders no mic when the browser cannot record audio', () => {
		renderInput()
		expect(screen.queryByRole('button', { name: /dictate/i })).not.toBeInTheDocument()
	})

	it('returns null when no stored actor', () => {
		mockGetStoredActor.mockReturnValue(null)
		const { container } = renderInput()
		expect(container).toBeEmptyDOMElement()
	})

	it('renders the comment box and send button', () => {
		renderInput()
		expect(box()).toBeInTheDocument()
		expect(screen.getByText('Write a comment... Use @ to mention an agent')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /send/i })).toBeInTheDocument()
	})

	it('disables send when content is empty', () => {
		renderInput()
		expect(screen.getByRole('button', { name: /send/i })).toBeDisabled()
	})

	it('enables send when content has text', () => {
		renderInput()
		typeText('Hello')
		expect(screen.getByRole('button', { name: /send/i })).not.toBeDisabled()
	})

	it('disables send when isPending', () => {
		mockIsPending = true
		renderInput()
		typeText('Hello')
		expect(screen.getByRole('button', { name: /send/i })).toBeDisabled()
	})

	// The Send button has always been disabled while a POST is in flight; Enter
	// went straight through. Since the composer keeps its text until the POST
	// succeeds, a slow round trip looks like a keypress that did nothing, and
	// the impatient second Enter posted the same comment twice.
	it('does NOT submit on Enter while a post is in flight', () => {
		mockIsPending = true
		renderInput()
		typeText('Impatient user')
		fireEvent.keyDown(box(), { key: 'Enter' })
		expect(mockMutate).not.toHaveBeenCalled()
	})

	it('submits on Enter key', () => {
		renderInput()
		typeText('Test comment')
		fireEvent.keyDown(box(), { key: 'Enter' })
		expect(mockMutate).toHaveBeenCalled()
		expect(mockMutate.mock.calls[0][0]).toMatchObject({
			entity_id: 'obj-1',
			content: 'Test comment',
		})
	})

	it('does NOT submit on Shift+Enter', () => {
		renderInput()
		typeText('Test comment')
		fireEvent.keyDown(box(), { key: 'Enter', shiftKey: true })
		expect(mockMutate).not.toHaveBeenCalled()
	})

	it('does NOT submit on Enter when the primary pointer is coarse (iOS/mobile)', () => {
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
			renderInput()
			typeText('Line one')
			// The key is left alone, so the browser makes its new line.
			const notPrevented = fireEvent.keyDown(box(), { key: 'Enter' })

			expect(notPrevented).toBe(true)
			expect(mockMutate).not.toHaveBeenCalled()
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
			renderInput()
			expect(screen.getByText('Write a comment...')).toBeInTheDocument()
			expect(
				screen.queryByText('Write a comment... Use @ to mention an agent'),
			).not.toBeInTheDocument()
		} finally {
			window.matchMedia = originalMatchMedia
			Object.defineProperty(window, 'innerWidth', { writable: true, value: originalInnerWidth })
		}
	})

	it('hides system actors from the @mention picker', async () => {
		mockUseActors.mockReturnValue({
			data: [BOB, { ...CAROL, name: 'Workspace Coach', isSystem: true }],
		})
		renderInput()

		typeText('@')

		expect(await screen.findByRole('option', { name: /Bob/ })).toBeInTheDocument()
		expect(screen.queryByRole('option', { name: /Workspace Coach/ })).not.toBeInTheDocument()
	})

	describe('tags', () => {
		beforeEach(() => {
			mockUseActors.mockReturnValue({ data: [BOB, CAROL] })
		})

		it('sends the picked tag inside the sentence together with its id', async () => {
			const user = userEvent.setup()
			renderInput()

			typeText('cc ')
			await pickTag('bo', /Bob/)
			expect(chips()).toHaveLength(1)
			expect(chips()[0]).toHaveAttribute('data-tag-id', 'actor-2')
			typeText('on the storage call')
			await user.click(screen.getByRole('button', { name: /send/i }))

			expect(mockMutate).toHaveBeenCalledWith(
				expect.objectContaining({
					content: 'cc @Bob on the storage call',
					mentions: ['actor-2'],
				}),
				expect.any(Object),
			)
		})

		it('sends no id for an @name that was typed and never picked', async () => {
			const user = userEvent.setup()
			renderInput()

			typeText('hello @Bob ')
			await user.click(screen.getByRole('button', { name: /send/i }))

			expect(mockMutate).toHaveBeenCalledWith(
				expect.objectContaining({ content: 'hello @Bob' }),
				expect.any(Object),
			)
			expect(mockMutate.mock.calls[0][0].mentions).toBeUndefined()
		})

		it('drops the id when Backspace removes the chip', async () => {
			const user = userEvent.setup()
			renderInput()

			await pickTag('bo', /Bob/)
			// The caret sits after the single space that follows the chip; step back over it.
			caretIn(chips()[0]?.nextSibling as Text, 0)
			fireEvent.keyDown(box(), { key: 'Backspace' })
			expect(chips()).toHaveLength(0)

			typeText('anyway')
			await user.click(screen.getByRole('button', { name: /send/i }))

			expect(mockMutate.mock.calls[0][0].mentions).toBeUndefined()
		})

		it('opens the picker from the Mention an agent menu entry', async () => {
			const user = userEvent.setup()
			renderInput()

			await user.click(screen.getByRole('button', { name: 'Add a file, object, or mention' }))
			await user.click(await screen.findByText('Mention an agent'))

			expect(await screen.findByRole('option', { name: /Bob/ })).toBeInTheDocument()
			expect(box()).toHaveTextContent('@')
		})

		it('turns an agent picked from the + menu into a chip', async () => {
			const user = userEvent.setup()
			renderInput()

			await user.click(screen.getByRole('button', { name: 'Add a file, object, or mention' }))
			await user.click(await screen.findByText('Reference an object'))
			await user.click(await screen.findByRole('button', { name: 'pick-agent' }))
			typeText('please look')
			await user.click(screen.getByRole('button', { name: /send/i }))

			expect(mockMutate).toHaveBeenCalledWith(
				expect.objectContaining({ content: '@Bob please look', mentions: ['actor-2'] }),
				expect.any(Object),
			)
		})

		it('leaves the box empty after a send', async () => {
			const user = userEvent.setup()
			mockMutate.mockImplementationOnce((_input, options) => options.onSuccess())
			renderInput()

			await pickTag('bo', /Bob/)
			typeText('hi')
			await user.click(screen.getByRole('button', { name: /send/i }))

			expect(box().textContent).toBe('')
			expect(chips()).toHaveLength(0)
			expect(screen.getByRole('button', { name: /send/i })).toBeDisabled()
		})

		it('focuses from the ref a caller passes in', () => {
			const ref = { current: null as { focus: () => void } | null }
			renderInput({ focusRef: ref as never })

			ref.current?.focus()

			expect(box()).toHaveFocus()
		})
	})

	describe('character limit', () => {
		const COUNTER_THRESHOLD = Math.ceil(COMMENT_MAX_LENGTH * 0.9)

		function setBoxText(text: string) {
			const root = box()
			root.textContent = text
			fireEvent.input(root)
			return root
		}

		it('hides the counter for short comments', () => {
			renderInput()
			typeText('hi')
			expect(screen.queryByText(new RegExp(`/\\s*${COMMENT_MAX_LENGTH}$`))).not.toBeInTheDocument()
		})

		it('shows the counter once content reaches 90% of the limit', () => {
			renderInput()
			setBoxText('x'.repeat(COUNTER_THRESHOLD))

			expect(
				screen.getByText(new RegExp(`^${COUNTER_THRESHOLD}\\s*/\\s*${COMMENT_MAX_LENGTH}$`)),
			).toBeInTheDocument()
			expect(screen.getByRole('button', { name: /send/i })).not.toBeDisabled()
		})

		it('disables submit, sets aria-invalid, and tints the counter when over the limit', () => {
			renderInput()
			const root = setBoxText('x'.repeat(COMMENT_MAX_LENGTH + 5))

			const counter = screen.getByText(
				new RegExp(`^${COMMENT_MAX_LENGTH + 5}\\s*/\\s*${COMMENT_MAX_LENGTH}$`),
			)
			expect(counter).toBeInTheDocument()
			expect(counter.className).toContain('text-error')
			expect(root).toHaveAttribute('aria-invalid', 'true')
			expect(screen.getByRole('button', { name: /send/i })).toBeDisabled()
		})

		it('does not submit when Enter is pressed over the limit', () => {
			renderInput()
			setBoxText('x'.repeat(COMMENT_MAX_LENGTH + 1))
			fireEvent.keyDown(box(), { key: 'Enter' })
			expect(mockMutate).not.toHaveBeenCalled()
		})

		// Regression: raw length and trimmed length must agree on whether to block
		// submit, otherwise trailing whitespace at the boundary lets Enter sneak
		// through while the UI shows the input as over the limit.
		it('does not submit when raw length is over the limit but trimmed length is not', () => {
			renderInput()
			setBoxText(`${'x'.repeat(COMMENT_MAX_LENGTH)}  `)
			fireEvent.keyDown(box(), { key: 'Enter' })
			expect(mockMutate).not.toHaveBeenCalled()
		})
	})
})
