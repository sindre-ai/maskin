import { render, screen } from '@testing-library/react'
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

const mockUseObjects = vi.fn(() => ({ data: [] }))
vi.mock('@/hooks/use-objects', () => ({
	useObjects: (...args: unknown[]) => mockUseObjects(...(args as [])),
}))

vi.mock('@/hooks/use-actors', () => ({
	useDefaultChatAgent: () => ({ id: 'agent-1', name: 'Workspace Coach' }),
	useActors: () => ({ data: [] }),
	useActor: () => ({ data: undefined }),
}))

import {
	BriefCard,
	briefMentionedIds,
	briefSpokenText,
	briefTranscript,
	splitBriefHeadline,
} from '@/components/foryou/brief-card'
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
	Object.defineProperty(window, 'speechSynthesis', {
		configurable: true,
		value: { speak, cancel: vi.fn() },
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
	return speak
}

function removeSpeechSynthesis() {
	// `installSpeechSynthesis` defines these as non-writable, so they have to be
	// redefined rather than assigned back to undefined.
	Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: undefined })
	Object.defineProperty(window, 'SpeechSynthesisUtterance', {
		configurable: true,
		value: undefined,
	})
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

describe('briefTranscript', () => {
	it('drops the machine id lines but keeps the prose', () => {
		const transcript = briefTranscript(
			`- **A bet**\n  id: \`${OBJECT_ID}\`\n\nTwo bets need a read.`,
		)
		expect(transcript).not.toContain(OBJECT_ID)
		expect(transcript).toContain('Two bets need a read.')
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

describe('BriefCard', () => {
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

	it('renders collapsed as the feed\u2019s first card, with the body hidden', () => {
		render(<BriefCard workspaceId="ws-1" />, { wrapper: TestWrapper })

		expect(screen.getByTestId('brief-card')).toBeInTheDocument()
		expect(screen.getByText("Today's brief")).toBeInTheDocument()
		expect(screen.queryByText('Two bets need a read.')).not.toBeInTheDocument()
	})

	it('reveals the headline when opened, and leads with the player over the prose', async () => {
		installSpeechSynthesis()
		const user = userEvent.setup()
		render(<BriefCard workspaceId="ws-1" />, { wrapper: TestWrapper })

		await user.click(screen.getByRole('button', { name: "Today's brief" }))
		expect(screen.getByText('Your Monday brief')).toBeInTheDocument()
		expect(screen.getByTestId('brief-player')).toBeInTheDocument()
		// The brief is made to be listened to — the transcript stays folded.
		expect(screen.queryByText('Two bets need a read.')).not.toBeInTheDocument()
		removeSpeechSynthesis()
	})

	it('renders no player when the browser has no SpeechSynthesis', async () => {
		removeSpeechSynthesis()
		const user = userEvent.setup()
		render(<BriefCard workspaceId="ws-1" />, { wrapper: TestWrapper })

		await user.click(screen.getByRole('button', { name: "Today's brief" }))
		expect(screen.queryByTestId('brief-player')).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /Show the transcript/ })).not.toBeInTheDocument()
		// With nothing to listen to, the transcript is the brief.
		expect(screen.getByText('Two bets need a read.')).toBeInTheDocument()
	})

	it('plays the brief from the collapsed header without opening it', async () => {
		const speak = installSpeechSynthesis()
		const user = userEvent.setup()
		render(<BriefCard workspaceId="ws-1" />, { wrapper: TestWrapper })

		await user.click(screen.getByRole('button', { name: 'Read the brief aloud' }))
		expect(speak).toHaveBeenCalledTimes(1)
		expect(screen.queryByText('Two bets need a read.')).not.toBeInTheDocument()
		removeSpeechSynthesis()
	})

	it('unfolds and re-folds the transcript', async () => {
		installSpeechSynthesis()
		const user = userEvent.setup()
		render(<BriefCard workspaceId="ws-1" />, { wrapper: TestWrapper })

		await user.click(screen.getByRole('button', { name: "Today's brief" }))
		await user.click(screen.getByRole('button', { name: 'Prefer to read? Show the transcript' }))
		expect(screen.getByText('Two bets need a read.')).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: 'Hide the transcript' }))
		expect(screen.queryByText('Two bets need a read.')).not.toBeInTheDocument()
		removeSpeechSynthesis()
	})

	it('lists the objects the brief names as MENTIONED chips', async () => {
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

		const user = userEvent.setup()
		render(<BriefCard workspaceId="ws-1" />, { wrapper: TestWrapper })
		await user.click(screen.getByRole('button', { name: "Today's brief" }))

		expect(screen.getByText('Mentioned')).toBeInTheDocument()
		// The chip is a link into the object, carrying its status as a word.
		expect(screen.getByRole('link', { name: /Cut signup friction/ })).toBeInTheDocument()
		expect(screen.getByLabelText('Status active')).toHaveTextContent('Active')
	})
})
