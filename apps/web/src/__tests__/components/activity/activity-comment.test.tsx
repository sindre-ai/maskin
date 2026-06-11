import { ActivityComment } from '@/components/activity/activity-comment'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildEventResponse } from '../../factories'

vi.mock('@/hooks/use-actors', () => ({
	useActor: () => ({
		data: { id: 'actor-1', name: 'Alice', type: 'human', email: null },
	}),
	useActors: () => ({
		data: [
			{ id: 'actor-1', name: 'Alice', type: 'human', email: null, isSystem: false },
			{ id: 'actor-2', name: 'Bob', type: 'agent', email: null, isSystem: false },
			{
				id: 'actor-3',
				name: 'Senior Developer',
				type: 'agent',
				email: null,
				isSystem: false,
			},
		],
	}),
}))

const editCommentMutate = vi.fn()
const deleteCommentMutate = vi.fn()
vi.mock('@/hooks/use-events', () => ({
	useCreateComment: () => ({ mutate: vi.fn(), isPending: false }),
	useEditComment: () => ({ mutate: editCommentMutate, isPending: false }),
	useDeleteComment: () => ({ mutate: deleteCommentMutate, isPending: false }),
}))

vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => false,
}))

vi.mock('@/hooks/use-files', () => ({
	useFiles: () => ({ data: [] }),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'actor-1', name: 'Alice', type: 'human' }),
}))

describe('ActivityComment', () => {
	it('renders actor name', () => {
		const event = buildEventResponse({
			action: 'commented',
			data: { content: 'Hello' },
		})
		render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)
		expect(screen.getByText('Alice')).toBeInTheDocument()
	})

	it('renders comment content', () => {
		const event = buildEventResponse({
			action: 'commented',
			data: { content: 'This looks good' },
		})
		render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)
		expect(screen.getByText('This looks good')).toBeInTheDocument()
	})

	it('renders @mentions as styled chips', () => {
		const event = buildEventResponse({
			action: 'commented',
			data: { content: 'Hey @Bob what do you think?' },
		})
		render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)
		expect(screen.getByText('@Bob')).toBeInTheDocument()
	})

	it('highlights multi-word @mentions in full', () => {
		const event = buildEventResponse({
			action: 'commented',
			data: { content: 'Hey @Senior Developer can you review?' },
		})
		render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)
		const chip = screen.getByText('@Senior Developer')
		expect(chip).toBeInTheDocument()
		expect(chip.tagName).toBe('BUTTON')
		expect(screen.queryByText('@Senior')).not.toBeInTheDocument()
	})

	it('does not chip an actor name embedded inside a longer word', () => {
		const event = buildEventResponse({
			action: 'commented',
			data: { content: 'Talked to @Bobby yesterday' },
		})
		render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)
		expect(screen.queryByText('@Bob')).not.toBeInTheDocument()
	})

	it('renders replies inline without a toggle', () => {
		const event = buildEventResponse({
			id: 1,
			action: 'commented',
			data: { content: 'Thread starter' },
		})
		const replies = [
			buildEventResponse({
				id: 2,
				action: 'commented',
				data: { content: 'Reply one', parentEventId: 1 },
			}),
		]

		render(<ActivityComment event={event} replies={replies} workspaceId="ws-1" objectId="obj-1" />)

		expect(screen.getByText('Reply one')).toBeInTheDocument()
	})

	it('renders multiple replies inline', () => {
		const event = buildEventResponse({
			id: 1,
			action: 'commented',
			data: { content: 'Thread' },
		})
		const replies = [
			buildEventResponse({ id: 2, action: 'commented', data: { content: 'R1' } }),
			buildEventResponse({ id: 3, action: 'commented', data: { content: 'R2' } }),
		]

		render(<ActivityComment event={event} replies={replies} workspaceId="ws-1" objectId="obj-1" />)

		expect(screen.getByText('R1')).toBeInTheDocument()
		expect(screen.getByText('R2')).toBeInTheDocument()
	})

	it('shows a Reply action button on the top-level comment when there are no replies', () => {
		const event = buildEventResponse({
			action: 'commented',
			data: { content: 'Test' },
		})
		render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)
		expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument()
	})

	it('keeps the Reply action visible by default on touch (hover-revealed only on hover-capable devices)', () => {
		// The Reply icon used to be `opacity-0 group-hover:opacity-100` — invisible
		// on touch. A later attempt used `sm:opacity-0 sm:group-hover:opacity-100`
		// which left iPad portrait (≥640px, touch, no hover) permanently invisible.
		// The contract is: visible by default; fades behind hover only on devices
		// that actually have hover (the `can-hover` variant maps to
		// `@media (hover: hover)`). Encoded here so a future refactor can't
		// silently re-hide it on touch again. T2 moved the opacity gate from the
		// Reply button itself onto the action-group wrapper that holds Edit /
		// Edit & restart agent / Reply / Delete — so this assertion checks the
		// parent slot instead.
		const event = buildEventResponse({
			action: 'commented',
			data: { content: 'Test' },
		})
		render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)
		const reply = screen.getByRole('button', { name: 'Reply' })
		const slot = reply.parentElement
		expect(slot).not.toBeNull()
		const slotClass = slot?.className ?? ''
		expect(slotClass).toMatch(/(^|\s)opacity-100($|\s)/)
		expect(slotClass).toMatch(/can-hover:opacity-0/)
		expect(slotClass).toMatch(/can-hover:group-hover:opacity-100/)
		// Guard against re-introducing a viewport-only gate that breaks touch tablets.
		expect(slotClass).not.toMatch(/\bsm:opacity-0\b/)
	})

	it('shows the Reply action button only on the last reply when replies exist', () => {
		const event = buildEventResponse({
			id: 1,
			action: 'commented',
			data: { content: 'Thread' },
		})
		const replies = [
			buildEventResponse({ id: 2, action: 'commented', data: { content: 'R1' } }),
			buildEventResponse({ id: 3, action: 'commented', data: { content: 'R2' } }),
		]

		render(<ActivityComment event={event} replies={replies} workspaceId="ws-1" objectId="obj-1" />)

		expect(screen.getAllByRole('button', { name: 'Reply' })).toHaveLength(1)
	})

	it('shows reply input on Reply click', async () => {
		const user = userEvent.setup()
		const event = buildEventResponse({
			action: 'commented',
			data: { content: 'Test' },
		})
		render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)

		await user.click(screen.getByRole('button', { name: 'Reply' }))
		expect(
			screen.getAllByPlaceholderText('Write a comment... Use @ to mention an agent').length,
		).toBeGreaterThanOrEqual(1)
	})

	it('renders markdown formatting in comment bodies', () => {
		const event = buildEventResponse({
			action: 'commented',
			data: { content: '**bold** *italic* ~~strike~~ `code`' },
		})
		const { container } = render(
			<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />,
		)
		expect(container.querySelector('strong')?.textContent).toBe('bold')
		expect(container.querySelector('em')?.textContent).toBe('italic')
		expect(container.querySelector('del')?.textContent).toBe('strike')
		expect(container.querySelector('code')?.textContent).toBe('code')
	})

	it('renders ordered and unordered lists', () => {
		const event = buildEventResponse({
			action: 'commented',
			data: { content: '- one\n- two\n\n1. first\n2. second' },
		})
		const { container } = render(
			<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />,
		)
		expect(container.querySelector('ul')).not.toBeNull()
		expect(container.querySelector('ol')).not.toBeNull()
	})

	it('renders blockquotes and links', () => {
		const event = buildEventResponse({
			action: 'commented',
			data: { content: '> quoted text\n\n[link](https://example.com)' },
		})
		const { container } = render(
			<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />,
		)
		expect(container.querySelector('blockquote')).not.toBeNull()
		const anchor = container.querySelector('a')
		expect(anchor?.getAttribute('href')).toBe('https://example.com')
	})

	it('does not render markdown headings as <h1>', () => {
		const event = buildEventResponse({
			action: 'commented',
			data: { content: '# Important heading' },
		})
		const { container } = render(
			<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />,
		)
		expect(container.querySelector('h1')).toBeNull()
		expect(container.querySelector('h2')).toBeNull()
		expect(screen.getByText('Important heading')).toBeInTheDocument()
	})

	it('renders mention chip together with markdown formatting', () => {
		const event = buildEventResponse({
			action: 'commented',
			data: { content: 'Hey @Bob this is **important**' },
		})
		const { container } = render(
			<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />,
		)
		const chip = screen.getByText('@Bob')
		expect(chip.tagName).toBe('BUTTON')
		expect(container.querySelector('strong')?.textContent).toBe('important')
	})

	it('clicking Reply on the last reply opens the input on the parent thread', async () => {
		const user = userEvent.setup()
		const event = buildEventResponse({
			id: 1,
			action: 'commented',
			data: { content: 'Thread' },
		})
		const replies = [
			buildEventResponse({
				id: 2,
				action: 'commented',
				data: { content: 'R1', parentEventId: 1 },
			}),
		]

		render(<ActivityComment event={event} replies={replies} workspaceId="ws-1" objectId="obj-1" />)

		await user.click(screen.getByRole('button', { name: 'Reply' }))

		expect(
			screen.getAllByPlaceholderText('Write a comment... Use @ to mention an agent').length,
		).toBeGreaterThanOrEqual(1)
	})

	describe('edit-in-place', () => {
		beforeEach(() => {
			editCommentMutate.mockReset()
		})

		it('shows Edit and Delete in the action group on own messages', () => {
			const event = buildEventResponse({
				actorId: 'actor-1', // matches getStoredActor mock
				action: 'commented',
				data: { content: 'My own comment' },
			})
			render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)
			expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Edit & restart agent' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
		})

		it('hides Edit and Delete on someone else’s message', () => {
			const event = buildEventResponse({
				actorId: 'actor-2', // not the stored actor
				action: 'commented',
				data: { content: 'Their comment' },
			})
			render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)
			expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
			expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
		})

		it('renders (edited) marker on previously edited comments', () => {
			const event = buildEventResponse({
				actorId: 'actor-1',
				action: 'commented',
				data: { content: 'Now corrected', editedAt: '2026-06-11T12:00:00Z' },
			})
			render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)
			expect(screen.getByText('(edited)')).toBeInTheDocument()
		})

		it('clicking Edit opens the inline composer prefilled with the existing content', async () => {
			const user = userEvent.setup()
			const event = buildEventResponse({
				actorId: 'actor-1',
				action: 'commented',
				data: { content: 'Original text' },
			})
			render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)

			await user.click(screen.getByRole('button', { name: 'Edit' }))

			const textarea = screen.getByRole('textbox', { name: 'Edit comment' })
			expect(textarea).toHaveValue('Original text')
			expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
			// Save & restart agent is stubbed in this task (T3 wires it).
			expect(screen.getByRole('button', { name: /Save & restart agent/ })).toBeDisabled()
		})

		it('Escape cancels edit mode without firing the mutation', async () => {
			const user = userEvent.setup()
			const event = buildEventResponse({
				actorId: 'actor-1',
				action: 'commented',
				data: { content: 'Original text' },
			})
			render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)

			await user.click(screen.getByRole('button', { name: 'Edit' }))
			const textarea = screen.getByRole('textbox', { name: 'Edit comment' })
			await user.clear(textarea)
			await user.type(textarea, 'half-typed')
			await user.keyboard('{Escape}')

			expect(screen.queryByRole('textbox', { name: 'Edit comment' })).not.toBeInTheDocument()
			expect(editCommentMutate).not.toHaveBeenCalled()
		})

		it('Save calls the edit mutation with the trimmed new content and event id', async () => {
			const user = userEvent.setup()
			const event = buildEventResponse({
				id: 7777,
				actorId: 'actor-1',
				action: 'commented',
				data: { content: 'Original text' },
			})
			render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)

			await user.click(screen.getByRole('button', { name: 'Edit' }))
			const textarea = screen.getByRole('textbox', { name: 'Edit comment' })
			await user.clear(textarea)
			await user.type(textarea, '   Corrected text   ')

			await user.click(screen.getByRole('button', { name: 'Save' }))

			expect(editCommentMutate).toHaveBeenCalledTimes(1)
			const [args] = editCommentMutate.mock.calls[0]
			expect(args).toEqual({ eventId: 7777, data: { content: 'Corrected text' } })
		})
	})

	describe('soft-delete', () => {
		beforeEach(() => {
			deleteCommentMutate.mockReset()
		})

		it('clicking Delete opens the undo countdown pill in place of the action group', async () => {
			const user = userEvent.setup()
			const event = buildEventResponse({
				actorId: 'actor-1',
				action: 'commented',
				data: { content: 'Removing this' },
			})
			render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)

			await user.click(screen.getByRole('button', { name: 'Delete' }))

			expect(screen.getByRole('button', { name: /Undo delete/ })).toBeInTheDocument()
			// While the undo window is open the Delete button itself is gone
			// (it lives in the action group, which is swapped for the pill).
			expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
			// The mutation does NOT fire yet — it only fires when the window
			// elapses; clicking Undo cancels it locally.
			expect(deleteCommentMutate).not.toHaveBeenCalled()
		})

		it('tapping Undo inside the pill cancels the timer and restores the row', async () => {
			const user = userEvent.setup()
			const event = buildEventResponse({
				actorId: 'actor-1',
				action: 'commented',
				data: { content: 'On second thought, keep it' },
			})
			render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)

			await user.click(screen.getByRole('button', { name: 'Delete' }))
			await user.click(screen.getByRole('button', { name: /Undo delete/ }))

			expect(screen.queryByRole('button', { name: /Undo delete/ })).not.toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument()
			// Tapping Undo restores synchronously — the mutation never fires
			// because the window-elapse timer was cleared.
			expect(deleteCommentMutate).not.toHaveBeenCalled()
		})

		it('after the undo window elapses, the mutation fires with the event id', async () => {
			// Real-timer integration test. The undo window is 7s; we wait
			// slightly longer than that for the timer to fire. The mutation
			// hook is mocked so the test exercises only the local timer path.
			vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
			vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
			try {
				const user = userEvent.setup()
				const event = buildEventResponse({
					id: 9090,
					actorId: 'actor-1',
					action: 'commented',
					data: { content: 'Goodbye comment' },
				})
				render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)

				await user.click(screen.getByRole('button', { name: 'Delete' }))
				await new Promise((resolve) => setTimeout(resolve, 7100))

				expect(deleteCommentMutate).toHaveBeenCalledTimes(1)
				const [eventIdArg] = deleteCommentMutate.mock.calls[0]
				expect(eventIdArg).toBe(9090)
			} finally {
				vi.restoreAllMocks()
			}
		}, 10000)

		it('Delete is hidden on someone else’s message', () => {
			const event = buildEventResponse({
				actorId: 'actor-2',
				action: 'commented',
				data: { content: 'Not mine' },
			})
			render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)
			expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
		})
	})
})
