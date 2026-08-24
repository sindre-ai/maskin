import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const mockUseBriefing = vi.fn()
vi.mock('@/hooks/use-briefing', () => ({
	useBriefing: (...args: unknown[]) => mockUseBriefing(...args),
}))

const createConversationMutateAsync = vi.fn()
vi.mock('@/hooks/use-conversations', () => ({
	useCreateConversation: () => ({ mutateAsync: createConversationMutateAsync, isPending: false }),
}))

const mockUseObjects = vi.fn(() => ({ data: [] }))
vi.mock('@/hooks/use-objects', () => ({
	useObjects: (...args: unknown[]) => mockUseObjects(...(args as [])),
}))

vi.mock('@/hooks/use-actors', () => ({
	useDefaultChatAgent: () => ({ id: 'agent-1', name: 'Workspace Coach' }),
	useActors: () => ({ data: [] }),
	useActor: () => ({ data: undefined }),
}))

// The chat Composer drags in the whole chat surface (uploads, slash picker,
// SSE); the drawer only cares that a send routes through onSend.
vi.mock('@/components/chat/chat', () => ({
	Composer: ({
		onSend,
		placeholder,
	}: {
		onSend: (content: string) => Promise<void>
		placeholder?: string
	}) => (
		<button type="button" onClick={() => void onSend('Turn this into a task')}>
			{placeholder}
		</button>
	),
}))

import {
	BriefDrawer,
	briefMentionedIds,
	briefSpokenText,
	splitBriefHeadline,
} from '@/components/foryou/brief-drawer'
import { estimateDurationMs, formatClock } from '@/hooks/use-brief-playback'
import { TestWrapper } from '../../setup'

const OBJECT_ID = '11111111-2222-4333-8444-555555555555'

function buildBriefObject() {
	return {
		id: OBJECT_ID,
		workspaceId: 'ws-1',
		type: 'bet',
		title: 'Cut signup friction',
		status: 'active',
		content: '',
		metadata: {},
		createdBy: 'actor-1',
		createdAt: null,
		updatedAt: null,
	}
}

/** Minimal SpeechSynthesis stand-in — jsdom ships none, which is exactly the
 *  unsupported branch the drawer has to degrade into. */
function installSpeechSynthesis() {
	const speak = vi.fn()
	const cancel = vi.fn()
	Object.defineProperty(window, 'speechSynthesis', {
		configurable: true,
		value: { speak, cancel },
	})
	Object.defineProperty(window, 'SpeechSynthesisUtterance', {
		configurable: true,
		value: class {
			text: string
			onboundary: unknown = null
			onend: unknown = null
			onerror: unknown = null
			constructor(text: string) {
				this.text = text
			}
		},
	})
	return { speak, cancel }
}

function removeSpeechSynthesis() {
	// @ts-expect-error — deleting an optional test-only global
	window.speechSynthesis = undefined
	// @ts-expect-error — deleting an optional test-only global
	window.SpeechSynthesisUtterance = undefined
}

describe('briefSpokenText', () => {
	it('strips markdown syntax and the raw id lines', () => {
		const spoken = briefSpokenText(
			'# Acme brief\n\n- **Cut signup friction** [active]\n  id: `abc`\n\nSee [the bet](/ws/objects/1).',
		)
		expect(spoken).toBe('Acme brief Cut signup friction [active] See the bet.')
	})
})

describe('briefMentionedIds', () => {
	it('collects every distinct object id the brief names', () => {
		const ids = briefMentionedIds(`- **A bet**\n  id: \`${OBJECT_ID}\`\n  id: \`${OBJECT_ID}\``)
		expect(ids).toEqual([OBJECT_ID])
	})

	it('returns nothing for a brief with no ids', () => {
		expect(briefMentionedIds('# Acme brief\n\nNothing to see.')).toEqual([])
	})
})

describe('brief playback readouts', () => {
	it('estimates a duration from the word count and formats it as a clock', () => {
		expect(estimateDurationMs('')).toBe(0)
		expect(estimateDurationMs(new Array(170).fill('word').join(' '))).toBe(60_000)
		expect(formatClock(60_000)).toBe('1:00')
		expect(formatClock(5_500)).toBe('0:06')
	})
})

describe('splitBriefHeadline', () => {
	it('lifts a leading H1 out of the markdown body', () => {
		const { headline, body } = splitBriefHeadline('# Acme — workspace briefing\n\nBody line.')
		expect(headline).toBe('Acme — workspace briefing')
		expect(body.trim()).toBe('Body line.')
	})

	it('leaves the document intact when it has no leading heading', () => {
		const { headline, body } = splitBriefHeadline('Just a paragraph.')
		expect(headline).toBeNull()
		expect(body).toBe('Just a paragraph.')
	})
})

describe('BriefDrawer', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseObjects.mockReturnValue({ data: [] })
		mockUseBriefing.mockReturnValue({
			data: { workspace_id: 'ws-1', markdown: '# Your Monday brief\n\nTwo bets need a read.' },
			isLoading: false,
			isError: false,
			error: null,
			refetch: vi.fn(),
		})
	})

	it('renders nothing until it is opened', () => {
		render(<BriefDrawer workspaceId="ws-1" open={false} onOpenChange={vi.fn()} />, {
			wrapper: TestWrapper,
		})
		expect(screen.queryByTestId('brief-drawer')).not.toBeInTheDocument()
	})

	it('renders the briefing headline and body when open', () => {
		render(<BriefDrawer workspaceId="ws-1" open onOpenChange={vi.fn()} />, {
			wrapper: TestWrapper,
		})

		expect(screen.getByText('Your brief')).toBeInTheDocument()
		expect(screen.getByRole('heading', { name: 'Your Monday brief' })).toBeInTheDocument()
		expect(screen.getByText('Two bets need a read.')).toBeInTheDocument()
	})

	it('renders no player when the browser has no SpeechSynthesis', () => {
		removeSpeechSynthesis()
		render(<BriefDrawer workspaceId="ws-1" open onOpenChange={vi.fn()} />, {
			wrapper: TestWrapper,
		})

		expect(screen.queryByTestId('brief-player')).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Listen instead' })).not.toBeInTheDocument()
		// The prose is still there — read mode is the fallback, not an error.
		expect(screen.getByText('Two bets need a read.')).toBeInTheDocument()
	})

	it('stops speaking when the drawer is closed', async () => {
		const { speak, cancel } = installSpeechSynthesis()
		const user = userEvent.setup()
		// The drawer stays mounted across open/close, so the hook's unmount
		// cleanup never runs here — closing has to cancel speech on its own.
		const { rerender } = render(<BriefDrawer workspaceId="ws-1" open onOpenChange={vi.fn()} />, {
			wrapper: TestWrapper,
		})

		await user.click(screen.getByRole('button', { name: 'Read the brief aloud' }))
		expect(speak).toHaveBeenCalledTimes(1)
		cancel.mockClear()

		rerender(<BriefDrawer workspaceId="ws-1" open={false} onOpenChange={vi.fn()} />)
		expect(cancel).toHaveBeenCalled()

		// Reopening must offer to play again, not show a stale Stop control.
		rerender(<BriefDrawer workspaceId="ws-1" open onOpenChange={vi.fn()} />)
		expect(screen.getByRole('button', { name: 'Read the brief aloud' })).toBeInTheDocument()
		removeSpeechSynthesis()
	})

	it('plays the brief through SpeechSynthesis and swaps the prose for listen mode', async () => {
		const { speak } = installSpeechSynthesis()
		const user = userEvent.setup()
		render(<BriefDrawer workspaceId="ws-1" open onOpenChange={vi.fn()} />, {
			wrapper: TestWrapper,
		})

		expect(screen.getByTestId('brief-player')).toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Read the brief aloud' }))
		expect(speak).toHaveBeenCalledTimes(1)
		expect(screen.getByRole('button', { name: 'Stop reading the brief' })).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Listen instead' }))
		expect(screen.queryByText('Two bets need a read.')).not.toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Read instead' }))
		expect(screen.getByText('Two bets need a read.')).toBeInTheDocument()
		removeSpeechSynthesis()
	})

	it('lists the objects the brief names as MENTIONED chips', () => {
		mockUseBriefing.mockReturnValue({
			data: {
				workspace_id: 'ws-1',
				markdown: `# Your Monday brief\n\n- **Cut signup friction** [active]\n  id: \`${OBJECT_ID}\``,
			},
			isLoading: false,
			isError: false,
			error: null,
			refetch: vi.fn(),
		})
		mockUseObjects.mockReturnValue({ data: [buildBriefObject()] } as never)

		render(<BriefDrawer workspaceId="ws-1" open onOpenChange={vi.fn()} />, {
			wrapper: TestWrapper,
		})

		expect(screen.getByText('Mentioned')).toBeInTheDocument()
		// The chip is a link into the object; the brief body also prints the
		// title in bold, hence the role query.
		const chip = screen.getByRole('link', { name: /Cut signup friction/ })
		expect(chip).toBeInTheDocument()
		expect(screen.getByLabelText('Status active')).toBeInTheDocument()
	})

	it('closes on Escape', async () => {
		const user = userEvent.setup()
		const onOpenChange = vi.fn()
		render(<BriefDrawer workspaceId="ws-1" open onOpenChange={onOpenChange} />, {
			wrapper: TestWrapper,
		})

		await user.keyboard('{Escape}')
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})

	it('sends a follow-up through useCreateConversation and closes the drawer', async () => {
		const user = userEvent.setup()
		const onOpenChange = vi.fn()
		createConversationMutateAsync.mockResolvedValue({ id: 'conv-1' })
		render(<BriefDrawer workspaceId="ws-1" open onOpenChange={onOpenChange} />, {
			wrapper: TestWrapper,
		})

		await user.click(
			screen.getByRole('button', {
				name: 'Ask Workspace Coach to turn any of this into a task…',
			}),
		)

		await waitFor(() =>
			expect(createConversationMutateAsync).toHaveBeenCalledWith({
				title: 'Workspace Coach',
				participant_actor_ids: ['agent-1'],
				initial_message: 'Turn this into a task',
			}),
		)
		expect(onOpenChange).toHaveBeenCalledWith(false)
	})
})
