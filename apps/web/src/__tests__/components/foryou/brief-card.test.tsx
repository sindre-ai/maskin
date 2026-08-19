import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const mockUseSpokenBrief = vi.fn()
vi.mock('@/hooks/use-briefing', () => ({
	useSpokenBrief: (...args: unknown[]) => mockUseSpokenBrief(...args),
}))

const mockUseObjects = vi.fn(() => ({ data: [] }))
vi.mock('@/hooks/use-objects', () => ({
	useObjects: (...args: unknown[]) => mockUseObjects(...(args as [])),
}))

vi.mock('@/hooks/use-actors', () => ({
	useDefaultChatAgent: () => ({ id: 'agent-1', name: 'Chief of Staff' }),
	useActors: () => ({ data: [] }),
	useActor: () => ({ data: undefined }),
}))

import { BriefCard } from '@/components/foryou/brief-card'
import { TestWrapper } from '../../setup'

const OBJECT_ID = '11111111-2222-4333-8444-555555555555'

const SCRIPT =
	'Cut signup friction is the one worth your attention today. Three of five tasks are done, and nothing else is blocked.'

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

function buildSpokenBrief(overrides: Record<string, unknown> = {}) {
	return {
		workspace_id: 'ws-1',
		headline: 'Cut signup friction is the one worth your attention today.',
		script: SCRIPT,
		mentioned_ids: [OBJECT_ID],
		generated_at: '2026-08-19T08:00:00.000Z',
		source: 'agent' as const,
		agent: { id: 'agent-1', name: 'Chief of Staff' },
		model: 'claude-haiku-4-5-20251001',
		...overrides,
	}
}

/**
 * Minimal SpeechSynthesis stand-in — jsdom ships none, which is exactly the
 * unsupported branch the card has to degrade into.
 *
 * `speak` fires `onend` on the next microtask, the way a real engine finishes
 * an utterance. Without that the hook stops after the first sentence, since
 * it queues the next one from the previous one's `onend`.
 */
function installSpeechSynthesis() {
	const speak = vi.fn((utterance: { text: string; onend: (() => void) | null }) => {
		queueMicrotask(() => act(() => utterance.onend?.()))
	})
	Object.defineProperty(window, 'speechSynthesis', {
		configurable: true,
		value: {
			speak,
			cancel: vi.fn(),
			getVoices: () => [],
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		},
	})
	Object.defineProperty(window, 'SpeechSynthesisUtterance', {
		configurable: true,
		value: class {
			text: string
			rate = 1
			pitch = 1
			voice: unknown = null
			onboundary: ((event: { charIndex: number }) => void) | null = null
			onend: (() => void) | null = null
			onerror: (() => void) | null = null
			constructor(text: string) {
				this.text = text
			}
		},
	})
	return { speak }
}

function removeSpeechSynthesis() {
	Reflect.deleteProperty(window, 'speechSynthesis')
	Reflect.deleteProperty(window, 'SpeechSynthesisUtterance')
}

/**
 * A `useSpokenBrief` stand-in that yields nothing until `refetch` is called —
 * the on-demand contract the card is built around. It holds the value in real
 * component state so a refetch re-renders the card, which is the whole point:
 * the card has to play the script it receives, not the empty one it rendered
 * with.
 */
function mockOnDemandBrief(brief = buildSpokenBrief()) {
	const refetch = vi.fn()
	mockUseSpokenBrief.mockImplementation(() => {
		const [data, setData] = useState<unknown>(undefined)
		refetch.mockImplementation(async () => {
			setData(brief)
			return { data: brief }
		})
		return { data, isFetching: false, isError: false, error: null, refetch }
	})
	return { refetch }
}

describe('BriefCard', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		removeSpeechSynthesis()
		mockUseObjects.mockReturnValue({ data: [] })
	})

	it('generates nothing until the reader asks for it', () => {
		const { refetch } = mockOnDemandBrief()
		render(<BriefCard workspaceId="ws-1" />, { wrapper: TestWrapper })

		expect(refetch).not.toHaveBeenCalled()
		expect(screen.getByText(/tap to play/)).toBeInTheDocument()
	})

	it('writes the brief when the card is expanded', async () => {
		const { refetch } = mockOnDemandBrief()
		render(<BriefCard workspaceId="ws-1" />, { wrapper: TestWrapper })

		await userEvent.click(screen.getByRole('button', { name: "Today's brief" }))
		await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1))
	})

	it('speaks the script rather than markdown when play is pressed', async () => {
		const { speak } = installSpeechSynthesis()
		mockOnDemandBrief()
		render(<BriefCard workspaceId="ws-1" />, { wrapper: TestWrapper })

		await userEvent.click(screen.getByRole('button', { name: 'Read the brief aloud' }))

		// One utterance per sentence, and every one is plain prose.
		await waitFor(() => expect(speak).toHaveBeenCalledTimes(2))
		const spoken = speak.mock.calls.map((call) => call[0].text)
		expect(spoken.join(' ')).toBe(SCRIPT)
		for (const text of spoken) {
			expect(text).not.toMatch(/[#*`]|id:/)
		}
	})

	it('renders the transcript unconditionally when the browser cannot speak', async () => {
		mockOnDemandBrief()
		render(<BriefCard workspaceId="ws-1" />, { wrapper: TestWrapper })

		expect(screen.queryByRole('button', { name: 'Read the brief aloud' })).not.toBeInTheDocument()
		await userEvent.click(screen.getByRole('button', { name: "Today's brief" }))

		expect(await screen.findByText(SCRIPT)).toBeInTheDocument()
		expect(screen.queryByTestId('brief-player')).not.toBeInTheDocument()
	})

	it('lists the objects the brief named', async () => {
		mockUseObjects.mockReturnValue({ data: [buildBriefObject()] } as never)
		mockOnDemandBrief()
		render(<BriefCard workspaceId="ws-1" />, { wrapper: TestWrapper })

		await userEvent.click(screen.getByRole('button', { name: "Today's brief" }))

		expect(await screen.findByText('Mentioned')).toBeInTheDocument()
		expect(screen.getByText('Cut signup friction')).toBeInTheDocument()
	})

	it('credits the agent that wrote it once there is a brief', async () => {
		installSpeechSynthesis()
		mockOnDemandBrief()
		render(<BriefCard workspaceId="ws-1" />, { wrapper: TestWrapper })

		await userEvent.click(screen.getByRole('button', { name: "Today's brief" }))
		expect(await screen.findByText(/by Chief of Staff/)).toBeInTheDocument()
	})

	it('surfaces a retry when the brief could not be written', async () => {
		const refetch = vi.fn()
		mockUseSpokenBrief.mockReturnValue({
			data: undefined,
			isFetching: false,
			isError: true,
			error: new Error('nope'),
			refetch,
		})
		render(<BriefCard workspaceId="ws-1" />, { wrapper: TestWrapper })

		await userEvent.click(screen.getByRole('button', { name: "Today's brief" }))
		expect(await screen.findByText("Couldn't write the brief")).toBeInTheDocument()
	})
})
