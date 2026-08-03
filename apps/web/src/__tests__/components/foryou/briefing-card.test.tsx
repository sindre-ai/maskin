import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { FileDetail, LatestBriefingResponse, ObjectResponse } from '@/lib/api'
import { buildObjectResponse } from '../../factories'
import { TestWrapper } from '../../setup'

const mockUseFile = vi.fn()
const mockTrackAudioPlayed = vi.fn()
const mockTrackRead = vi.fn()

vi.mock('@/hooks/use-files', () => ({
	useFile: (...args: unknown[]) => mockUseFile(...args),
}))

vi.mock('@/lib/analytics', () => ({
	trackFypBriefingRead: (p: { entity_id: string }) => mockTrackRead(p),
	trackFypBriefingAudioPlayed: (p: { entity_id: string }) => mockTrackAudioPlayed(p),
}))

import { BriefingCard } from '@/components/foryou/briefing-card'

function buildBriefingObject(overrides: Partial<ObjectResponse> = {}): ObjectResponse {
	return buildObjectResponse({
		id: 'brf-1',
		type: 'knowledge',
		title: 'Daily briefing',
		status: 'validated',
		content: [
			'- First bullet from the CoS briefing',
			'- Second bullet referencing [Bet A](/ws-1/objects/bet-a)',
			'- Third bullet referencing [Task B](/ws-1/objects/task-b)',
			'- Fourth bullet referencing [Insight C](/ws-1/objects/insight-c)',
		].join('\n'),
		createdAt: '2026-07-21T08:00:00.000Z',
		...overrides,
	})
}

function buildBriefingPayload(
	overrides: Partial<LatestBriefingResponse> = {},
): LatestBriefingResponse & { object: NonNullable<LatestBriefingResponse['object']> } {
	return {
		object: buildBriefingObject(),
		audioFileId: 'file-1',
		unreadDelta: 3,
		...overrides,
	} as LatestBriefingResponse & { object: NonNullable<LatestBriefingResponse['object']> }
}

function buildAudioFile(overrides: Partial<FileDetail> = {}): FileDetail {
	return {
		id: 'file-1',
		workspaceId: 'ws-1',
		name: 'briefing.mp3',
		description: null,
		mimeType: 'audio/mpeg',
		sizeBytes: 1234,
		storageKey: 'key',
		createdBy: 'actor-1',
		createdAt: '2026-07-21T08:00:00.000Z',
		updatedAt: '2026-07-21T08:00:00.000Z',
		content: 'YmFzZTY0YXVkaW8=',
		encoding: 'base64',
		url: '/api/files/file-1/download',
		annotations: [],
		...overrides,
	}
}

describe('BriefingCard', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockUseFile.mockReturnValue({ data: buildAudioFile() })
	})

	it('renders the briefing title, kicker, and unread-since badge', () => {
		render(<BriefingCard workspaceId="ws-1" briefing={buildBriefingPayload()} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('Daily briefing')).toBeInTheDocument()
		expect(screen.getByText('Briefing')).toBeInTheDocument()
		expect(screen.getByText('3 new since last briefing')).toBeInTheDocument()
	})

	it('omits the unread-since badge when unreadDelta is 0', () => {
		render(
			<BriefingCard workspaceId="ws-1" briefing={buildBriefingPayload({ unreadDelta: 0 })} />,
			{ wrapper: TestWrapper },
		)
		expect(screen.queryByTestId('briefing-unread-delta')).not.toBeInTheDocument()
	})

	it('renders three deep-link chips as clickable object links', () => {
		render(<BriefingCard workspaceId="ws-1" briefing={buildBriefingPayload()} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByRole('link', { name: 'Bet A' })).toHaveAttribute(
			'href',
			'/ws-1/objects/bet-a',
		)
		expect(screen.getByRole('link', { name: 'Task B' })).toHaveAttribute(
			'href',
			'/ws-1/objects/task-b',
		)
		expect(screen.getByRole('link', { name: 'Insight C' })).toHaveAttribute(
			'href',
			'/ws-1/objects/insight-c',
		)
	})

	it('renders an audio element with the play control enabled once the file loads', () => {
		render(<BriefingCard workspaceId="ws-1" briefing={buildBriefingPayload()} />, {
			wrapper: TestWrapper,
		})
		const audio = screen.getByTestId('briefing-audio') as HTMLAudioElement
		expect(audio.src).toContain('data:audio/mpeg;base64,')
		expect(screen.getByRole('button', { name: /play briefing audio/i })).not.toBeDisabled()
	})

	it('disables the play control when audio has not rendered yet', () => {
		mockUseFile.mockReturnValue({ data: undefined })
		render(
			<BriefingCard workspaceId="ws-1" briefing={buildBriefingPayload({ audioFileId: null })} />,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByRole('button', { name: /play briefing audio/i })).toBeDisabled()
		expect(screen.getByText('Audio rendering')).toBeInTheDocument()
	})

	it('fires the audio-played event past 60s of playback', () => {
		render(<BriefingCard workspaceId="ws-1" briefing={buildBriefingPayload()} />, {
			wrapper: TestWrapper,
		})
		const audio = screen.getByTestId('briefing-audio') as HTMLAudioElement
		Object.defineProperty(audio, 'currentTime', { value: 30, configurable: true, writable: true })
		fireEvent.timeUpdate(audio)
		expect(mockTrackAudioPlayed).not.toHaveBeenCalled()

		Object.defineProperty(audio, 'currentTime', { value: 61, configurable: true, writable: true })
		fireEvent.timeUpdate(audio)
		expect(mockTrackAudioPlayed).toHaveBeenCalledWith({ entity_id: 'brf-1' })
		// Only fires once per mount.
		fireEvent.timeUpdate(audio)
		expect(mockTrackAudioPlayed).toHaveBeenCalledTimes(1)
	})
})
