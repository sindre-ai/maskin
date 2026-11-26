import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import posthog from 'posthog-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockNavigate = vi.fn()
vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return { ...mockTanStackRouter(), useNavigate: () => mockNavigate }
})

const mockCreateConversation = vi.fn()
vi.mock('@/hooks/use-conversations', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/hooks/use-conversations')>()),
	useCreateConversation: () => ({ mutateAsync: mockCreateConversation, isPending: false }),
}))

vi.mock('@/lib/workspace-context', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/workspace-context')>()),
	useWorkspace: () => ({ workspace: { role: 'member' }, workspaceId: 'ws-1' }),
}))

const mockDefaultAgent = vi.fn(() => ({ id: 'default-1', name: 'Workspace Coach' }))
vi.mock('@/hooks/use-actors', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/hooks/use-actors')>()),
	useDefaultChatAgent: () => mockDefaultAgent(),
	useActors: () => ({ data: [] }),
}))

const mockUseBriefings = vi.fn()
vi.mock('@/hooks/use-briefings', () => ({
	useBriefings: (...args: unknown[]) => mockUseBriefings(...args),
}))

import { BriefingRow } from '@/components/foryou/briefing-row'
import { VIEWER_GOTO_PAGE_MESSAGE, VIEWER_PAGE_MESSAGE, VIEWER_STEP_MESSAGE } from '@/lib/mini-app'
import { __setInitializedForTesting } from '@/lib/posthog'
import { TestWrapper } from '../../setup'

// A three-slide deck, then a page with no slides: the viewer walks 3 slides, then 1 page.
const deck = `<h1>Two bets stalled; one needs your call</h1>${'<section class="slide"></section>'.repeat(3)}`

const cards = [
	{
		id: 'a',
		name: 'Briefing 2026-10-21.html',
		headline: 'Two bets stalled; one needs your call',
		author: { id: 'cos-1', name: 'Chief of Staff', type: 'agent' },
		updatedAt: '2026-10-21T05:00:00Z',
		html: deck,
	},
	{
		id: 'b',
		name: 'Pipeline.html',
		headline: 'Pipeline grew by four leads',
		author: { id: null, name: 'Sales Rep', type: 'agent' },
		updatedAt: '2026-10-20T05:00:00Z',
		html: '<h1>Pipeline grew by four leads</h1>',
	},
]

function frameOf(title: string) {
	return screen.getByTitle(title) as HTMLIFrameElement
}

function fromFrame(frame: HTMLIFrameElement, data: unknown) {
	act(() => {
		window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data }))
	})
}

function fillOf(position: number) {
	return screen.getAllByTestId('briefing-segment-fill')[position].style.width
}

function renderRow() {
	return render(<BriefingRow workspaceId="ws-1" />, { wrapper: TestWrapper })
}

describe('BriefingRow', () => {
	beforeEach(() => {
		localStorage.clear()
		mockNavigate.mockClear()
		mockCreateConversation.mockReset()
		mockCreateConversation.mockResolvedValue({ id: 'conv-1' })
		mockUseBriefings.mockReturnValue({ cards, isLoading: false, isError: false })
	})

	it('draws nothing when there are no briefings', () => {
		mockUseBriefings.mockReturnValue({ cards: [], isLoading: false, isError: false })
		renderRow()
		expect(screen.queryByTestId('briefing-row')).toBeNull()
	})

	it('draws no "Briefings" heading above the tiles', () => {
		renderRow()
		expect(screen.queryByRole('heading', { name: /briefings/i })).toBeNull()
	})

	it('marks an unseen tile as new without a pill and draws no kind label', () => {
		renderRow()
		const tiles = screen.getAllByTestId('briefing-card')
		expect(tiles[0]).toHaveAccessibleName(/, new$/)
		expect(within(tiles[0]).queryByText('New')).not.toBeInTheDocument()
		expect(within(tiles[0]).queryByText('Briefing')).toBeNull()
	})

	it('leads with the big number and label when a deck asks for a tile', () => {
		mockUseBriefings.mockReturnValue({
			cards: [{ ...cards[0], tile: { value: '0 of 10', label: 'paying customers' } }, cards[1]],
			isLoading: false,
			isError: false,
		})
		renderRow()
		const [withTile, withoutTile] = screen.getAllByTestId('briefing-card')
		expect(within(withTile).getByTestId('briefing-tile-value')).toHaveTextContent('0 of 10')
		expect(within(withTile).getByTestId('briefing-tile-label')).toHaveTextContent(
			'paying customers',
		)
		expect(within(withTile).queryByText(cards[0].headline)).toBeNull()
		expect(withTile).toHaveAccessibleName(
			`Chief of Staff: 0 of 10, paying customers, ${cards[0].headline}, new`,
		)
		// A deck without the tags keeps today's tile.
		expect(within(withoutTile).getByText(cards[1].headline)).toBeInTheDocument()
		expect(within(withoutTile).queryByTestId('briefing-tile-value')).toBeNull()
	})

	it('shows one card per briefing, titled by its page, marked new', () => {
		renderRow()
		expect(
			screen.getByRole('button', {
				name: /Chief of Staff: Two bets stalled; one needs your call, new/,
			}),
		).toBeInTheDocument()
		expect(screen.getAllByTestId('briefing-card')).toHaveLength(2)
	})

	it('opens the page in a sandboxed frame and marks the card seen', async () => {
		const user = userEvent.setup()
		renderRow()

		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))

		const frame = screen.getByTitle('Two bets stalled; one needs your call')
		expect(frame.tagName).toBe('IFRAME')
		// No allow-same-origin: agent-written HTML must stay off our origin.
		expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
		expect(screen.getByText('1 / 3')).toBeInTheDocument()
	})

	it('sends briefing_viewed with the page id for each briefing opened', async () => {
		__setInitializedForTesting(true)
		const capture = vi.spyOn(posthog, 'capture').mockImplementation((() => {}) as never)
		const user = userEvent.setup()
		renderRow()

		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))
		// Three slides, then the next briefing.
		for (let press = 0; press < 3; press++) {
			await user.click(screen.getByRole('button', { name: 'Next' }))
		}

		const viewed = capture.mock.calls.filter(([name]) => name === 'briefing_viewed')
		expect(viewed.map(([, props]) => (props as { entity_id: string }).entity_id)).toEqual([
			'a',
			'b',
		])
		expect(viewed[0]?.[1]).toMatchObject({ kind: 'story', entity_type: 'file' })
		__setInitializedForTesting(false)
		vi.restoreAllMocks()
	})

	it('has one pager: Next walks the slides, then on to the next briefing', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))
		expect(screen.getAllByRole('button', { name: /^(next|previous)/i })).toHaveLength(2)

		await user.click(screen.getByRole('button', { name: 'Next' }))
		expect(screen.getByText('2 / 3')).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Next' }))
		expect(screen.getByText('3 / 3')).toBeInTheDocument()
		expect(frameOf('Two bets stalled; one needs your call')).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Next' }))
		expect(frameOf('Pipeline grew by four leads')).toBeInTheDocument()
		// A page that is not a deck is one page, with no counter.
		expect(screen.queryByText(/\d+ \/ \d+/)).toBeNull()
		expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled()
	})

	it('asks the frame to move when the slide changes inside a briefing', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))
		const frame = frameOf('Two bets stalled; one needs your call')
		const post = vi.spyOn(frame.contentWindow as Window, 'postMessage')

		await user.click(screen.getByRole('button', { name: 'Next' }))

		expect(post).toHaveBeenLastCalledWith({ type: VIEWER_GOTO_PAGE_MESSAGE, page: 1 }, '*')
		// The same frame stays: the slide moved, the page did not reload.
		expect(frameOf('Two bets stalled; one needs your call')).toBe(frame)
	})

	it('steps back through the slides, and from slide 1 to the last slide of the briefing before', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))
		expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()

		for (let press = 0; press < 3; press++) {
			await user.click(screen.getByRole('button', { name: 'Next' }))
		}
		expect(frameOf('Pipeline grew by four leads')).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Previous' }))
		// The deck opens on its last slide straight away, so slide one never flashes.
		expect(frameOf('Two bets stalled; one needs your call').getAttribute('srcdoc')).toContain(
			'var current=2;',
		)
		expect(screen.getByText('3 / 3')).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Previous' }))
		expect(screen.getByText('2 / 3')).toBeInTheDocument()
	})

	it('fills the top segments as the slides advance and jumps on a click', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))
		expect(fillOf(0)).toBe('33%')
		expect(fillOf(1)).toBe('0%')

		await user.click(screen.getByRole('button', { name: 'Next' }))
		await user.click(screen.getByRole('button', { name: 'Next' }))
		expect(fillOf(0)).toBe('100%')

		await user.click(screen.getByRole('button', { name: /Briefing 2: Pipeline grew/ }))
		expect(frameOf('Pipeline grew by four leads')).toBeInTheDocument()
		expect(fillOf(0)).toBe('100%')
		expect(fillOf(1)).toBe('100%')

		// Back to the first briefing, on its first slide.
		await user.click(screen.getByRole('button', { name: /Briefing 1: Two bets stalled/ }))
		expect(screen.getByText('1 / 3')).toBeInTheDocument()
		expect(fillOf(1)).toBe('0%')
	})

	it('takes over the deck own navigation, and leaves a plain page alone', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))

		expect(frameOf('Two bets stalled; one needs your call').getAttribute('srcdoc')).toContain(
			VIEWER_STEP_MESSAGE,
		)
		await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}')
		expect(frameOf('Pipeline grew by four leads').getAttribute('srcdoc')).not.toContain(
			VIEWER_STEP_MESSAGE,
		)
	})

	it('moves one slide when the frame reports a key or a swipe, from its own window only', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))
		const frame = frameOf('Two bets stalled; one needs your call')

		fromFrame(frame, { type: VIEWER_STEP_MESSAGE, delta: 1 })
		expect(screen.getByText('2 / 3')).toBeInTheDocument()
		fromFrame(frame, { type: VIEWER_STEP_MESSAGE, delta: -1 })
		expect(screen.getByText('1 / 3')).toBeInTheDocument()

		// Another window cannot drive the viewer.
		act(() => {
			window.dispatchEvent(
				new MessageEvent('message', {
					source: window,
					data: { type: VIEWER_STEP_MESSAGE, delta: 1 },
				}),
			)
		})
		expect(screen.getByText('1 / 3')).toBeInTheDocument()
		// Neither can a step of any size but one.
		fromFrame(frame, { type: VIEWER_STEP_MESSAGE, delta: 5 })
		expect(screen.getByText('1 / 3')).toBeInTheDocument()
	})

	it('puts the frame back on the slide the viewer shows when the frame disagrees', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))
		const frame = frameOf('Two bets stalled; one needs your call')
		await user.click(screen.getByRole('button', { name: 'Next' }))
		const post = vi.spyOn(frame.contentWindow as Window, 'postMessage')

		// The frame had not loaded when the move was sent, so it still reports slide one.
		fromFrame(frame, { type: VIEWER_PAGE_MESSAGE, index: 0, total: 3, w: 1920, h: 1080 })
		expect(post).toHaveBeenLastCalledWith({ type: VIEWER_GOTO_PAGE_MESSAGE, page: 1 }, '*')

		post.mockClear()
		fromFrame(frame, { type: VIEWER_PAGE_MESSAGE, index: 1, total: 3, w: 1920, h: 1080 })
		expect(post).not.toHaveBeenCalled()
	})

	it('steps back with the left-hand button, which is off on the first slide', async () => {
		mockUseBriefings.mockReturnValue({
			cards: [cards[1], cards[0]],
			isLoading: false,
			isError: false,
		})
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Pipeline grew/ }))
		expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled()
		await user.click(screen.getByRole('button', { name: 'Next' }))
		expect(screen.getByRole('button', { name: 'Previous' })).toBeEnabled()
	})

	it('"Ask about this slide" fills the existing composer with the slide and sends nothing', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))

		await user.click(screen.getByRole('button', { name: /ask about this slide/i }))

		const box = screen.getByRole('textbox', { name: 'Talk about this briefing' })
		expect(box).toHaveValue('About "Two bets stalled; one needs your call" (briefing 1 of 2): ')
		await waitFor(() => expect(box).toHaveFocus())
		expect(screen.getAllByRole('textbox', { name: 'Talk about this briefing' })).toHaveLength(1)
		expect(mockCreateConversation).not.toHaveBeenCalled()
	})

	it('"Tell me more" sends the question to the author with the page attached, then opens the chat', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))

		await user.click(screen.getByRole('button', { name: /tell me more/i }))

		expect(mockCreateConversation).toHaveBeenCalledTimes(1)
		const input = mockCreateConversation.mock.calls[0]?.[0]
		expect(input.participant_actor_ids).toEqual(['cos-1'])
		expect(input.initial_message).toContain('Tell me more about this briefing')
		expect(input.initial_message).toContain('Two bets stalled; one needs your call')
		// The page is a real attachment, not text pasted into the message.
		expect(input.initial_message).not.toContain('file_id')
		expect(input.initial_message_metadata).toEqual({
			attachments: [{ file_id: 'a', name: 'Briefing 2026-10-21.html', mime_type: 'text/html' }],
		})
		// The author's name is for the card, not for the question.
		expect(input.initial_message).not.toContain('from Chief of Staff')
		await waitFor(() =>
			expect(mockNavigate).toHaveBeenCalledWith({
				to: '/$workspaceId/chats/$conversationId',
				params: { workspaceId: 'ws-1', conversationId: 'conv-1' },
			}),
		)
		expect(screen.queryByTestId('briefing-viewer')).toBeNull()
	})

	it('"Tell me more" asks the default agent when the author is not a known agent', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Pipeline grew/ }))

		await user.click(screen.getByRole('button', { name: /tell me more/i }))

		expect(mockCreateConversation.mock.calls[0]?.[0].participant_actor_ids).toEqual(['default-1'])
	})

	it('"Tell me more" keeps the viewer open when the chat cannot be started', async () => {
		mockCreateConversation.mockRejectedValue(new Error('boom'))
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))

		await user.click(screen.getByRole('button', { name: /tell me more/i }))

		await waitFor(() => expect(mockCreateConversation).toHaveBeenCalled())
		expect(screen.getByTestId('briefing-viewer')).toBeInTheDocument()
		expect(mockNavigate).not.toHaveBeenCalled()
	})

	it('closes when the background around the frame is clicked', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))

		// The viewer is a modal dialog now: the scrim around it is a sibling of the content.
		const scrim = document.querySelector('.bg-black\\/50')
		expect(scrim).not.toBeNull()
		await user.click(scrim as Element)

		await waitFor(() => expect(screen.queryByTestId('briefing-viewer')).toBeNull())
	})

	it('stays open when the page itself is clicked', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))

		await user.click(screen.getByText('1 / 3'))

		expect(screen.getByTestId('briefing-viewer')).toBeInTheDocument()
	})

	it('"Open page" links to the file', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))

		expect(screen.getByRole('link', { name: 'Open page' })).toHaveAttribute(
			'href',
			'/$workspaceId/files/$fileId',
		)
	})

	it('moves one slide at a time with the arrow keys and J / K, across briefings', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))

		await user.keyboard('{ArrowDown}')
		expect(screen.getByText('2 / 3')).toBeInTheDocument()
		await user.keyboard('j')
		expect(screen.getByText('3 / 3')).toBeInTheDocument()
		await user.keyboard('{ArrowRight}')
		expect(frameOf('Pipeline grew by four leads')).toBeInTheDocument()

		await user.keyboard('k')
		expect(screen.getByText('3 / 3')).toBeInTheDocument()
		await user.keyboard('{ArrowUp}{ArrowLeft}')
		expect(screen.getByText('1 / 3')).toBeInTheDocument()
	})

	it('moves an opened card to the end of the row and drops its "new" mark', async () => {
		const user = userEvent.setup()
		renderRow()
		await user.click(screen.getByRole('button', { name: /Two bets stalled/ }))
		await user.keyboard('{Escape}')

		const [first, second] = screen.getAllByTestId('briefing-card')
		expect(first).toHaveAttribute('data-seen', 'false')
		expect(first).toHaveTextContent('Pipeline grew by four leads')
		expect(second).toHaveAttribute('data-seen', 'true')
	})
})
