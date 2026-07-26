import { ActivityComment } from '@/components/activity/activity-comment'
import { __resetFirstRenderTrackerForTesting } from '@/hooks/use-track-first-render'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildEventResponse } from '../../factories'

const trackCommentRenderedMock = vi.fn()
vi.mock('@/lib/analytics', async () => {
	const actual = await vi.importActual<typeof import('@/lib/analytics')>('@/lib/analytics')
	return {
		...actual,
		trackCommentRendered: (p: Parameters<typeof actual.trackCommentRendered>[0]) =>
			trackCommentRenderedMock(p),
	}
})

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

vi.mock('@/hooks/use-events', () => ({
	useCreateComment: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/hooks/use-files', () => ({
	useFiles: () => ({ data: [] }),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'actor-1', name: 'Alice', type: 'human' }),
}))

describe('ActivityComment', () => {
	beforeEach(() => {
		trackCommentRenderedMock.mockClear()
		__resetFirstRenderTrackerForTesting()
	})

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
		// silently re-hide it on touch again.
		const event = buildEventResponse({
			action: 'commented',
			data: { content: 'Test' },
		})
		render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)
		const reply = screen.getByRole('button', { name: 'Reply' })
		expect(reply.className).toMatch(/(^|\s)opacity-100($|\s)/)
		expect(reply.className).toMatch(/can-hover:opacity-0/)
		expect(reply.className).toMatch(/can-hover:group-hover:opacity-100/)
		// Guard against re-introducing a viewport-only gate that breaks touch tablets.
		expect(reply.className).not.toMatch(/\bsm:opacity-0\b/)
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

	it('renders the comment timestamp in a fixed-width tabular-nums mono column (AC-U3)', () => {
		const event = buildEventResponse({
			action: 'commented',
			createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
			data: { content: 'Hello' },
		})
		render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)
		const timeEl = screen.getByText(/ago|now/) as HTMLElement
		expect(timeEl.tagName).toBe('TIME')
		expect(timeEl).toHaveClass('font-mono')
		expect(timeEl).toHaveClass('tabular-nums')
		expect(timeEl).toHaveClass('w-14')
		expect(timeEl).toHaveClass('text-right')
		expect(timeEl).toHaveClass('shrink-0')
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

	// Runtime-path payload assertion. The typed helper `trackCommentRendered`
	// defines the DoD property contract for the Per-agent avatars bet, but the
	// component wires the render event via `useTrackFirstRender`. A prop rename
	// on the runtime path — e.g. `actor_id` → `actorId` inside the fire closure —
	// would leave the helper-shape unit test green while shipping the wrong
	// payload. This test renders the real component and asserts the helper is
	// invoked with the exact DoD-named props.
	it('emits comment_rendered with the DoD payload from the runtime path', () => {
		const event = buildEventResponse({
			id: 4242,
			actorId: 'actor-1',
			action: 'commented',
			data: { content: 'payload probe' },
		})
		render(<ActivityComment event={event} workspaceId="ws-1" objectId="obj-1" />)

		expect(trackCommentRenderedMock).toHaveBeenCalledTimes(1)
		expect(trackCommentRenderedMock).toHaveBeenCalledWith({
			comment_id: '4242',
			actor_id: 'actor-1',
			actor_type: 'human',
			workspace_id: 'ws-1',
		})
	})
})
