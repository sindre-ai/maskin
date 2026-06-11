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
})
