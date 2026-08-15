import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ArtifactDecisionCard, readArtifactKind } from '@/components/foryou/artifact-decision-card'
import type { FileDetail } from '@/lib/api'
import { buildNotificationResponse } from '../../factories'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/hooks/use-events', () => ({
	useCreateComment: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'viewer', name: 'Viewer', type: 'human', email: null }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActor: () => ({ data: { id: 'other', name: 'Other', type: 'human' } }),
	useActors: () => ({
		data: [{ id: 'viewer', name: 'Viewer', type: 'human', isSystem: false }],
	}),
}))

const useFileMock = vi.fn<(workspaceId: string, fileId: string | null) => { data?: FileDetail }>()

vi.mock('@/hooks/use-files', () => ({
	useFile: (workspaceId: string, fileId: string | null) => useFileMock(workspaceId, fileId),
}))

function buildFileDetail(overrides: Partial<FileDetail> = {}): FileDetail {
	return {
		id: '11111111-1111-4111-8111-111111111111',
		workspaceId: 'ws-1',
		name: 'shot.png',
		description: null,
		mimeType: 'image/png',
		sizeBytes: 128,
		storageKey: 'files/shot.png',
		createdBy: 'actor-1',
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z',
		content: 'aGVsbG8=', // base64 of "hello"
		encoding: 'base64',
		url: '/api/files/11111111-1111-4111-8111-111111111111',
		annotations: [],
		...overrides,
	}
}

describe('readArtifactKind', () => {
	it('returns the artifact kind when it is a known renderer target', () => {
		const notification = buildNotificationResponse({
			metadata: {
				artifacts: [{ kind: 'mail', fileId: '11111111-1111-4111-8111-111111111111', title: 'x' }],
			},
		})
		expect(readArtifactKind(notification)).toBe('mail')
	})

	it('returns null when there is no metadata', () => {
		expect(readArtifactKind(buildNotificationResponse({ metadata: null }))).toBeNull()
	})

	it('returns null when the artifact kind is not a renderer target', () => {
		const notification = buildNotificationResponse({
			metadata: {
				artifacts: [
					{ kind: 'audio', fileId: '11111111-1111-4111-8111-111111111111', title: 'clip.mp3' },
				],
			},
		})
		expect(readArtifactKind(notification)).toBeNull()
	})

	it('returns null when artifacts is empty', () => {
		expect(readArtifactKind(buildNotificationResponse({ metadata: { artifacts: [] } }))).toBeNull()
	})
})

describe('ArtifactDecisionCard', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		useFileMock.mockReturnValue({ data: undefined })
	})

	function renderCard(kind: 'mail' | 'post' | 'visual' | 'metric' | 'diff') {
		const notification = buildNotificationResponse({
			id: `notif-${kind}`,
			title: `${kind} decision`,
			objectId: `obj-${kind}`,
			metadata: {
				artifacts: [
					{ kind, fileId: '11111111-1111-4111-8111-111111111111', title: `${kind} artifact` },
				],
				options: [
					{ label: 'Approve', value: 'approve', default: true },
					{ label: 'Reject', value: 'reject' },
				],
			},
		})
		render(
			<ArtifactDecisionCard
				workspaceId="ws-1"
				kind={kind}
				notification={notification}
				onRespond={vi.fn()}
			/>,
			{ wrapper: TestWrapper },
		)
	}

	it('routes mail to the mail renderer', () => {
		renderCard('mail')
		expect(screen.getByTestId('foryou-mail-renderer')).toBeInTheDocument()
	})

	it('routes post to the post renderer', () => {
		renderCard('post')
		expect(screen.getByTestId('foryou-post-renderer')).toBeInTheDocument()
	})

	it('routes visual to the visual renderer', () => {
		renderCard('visual')
		expect(screen.getByTestId('foryou-visual-renderer')).toBeInTheDocument()
	})

	it('routes metric to the metric renderer', () => {
		renderCard('metric')
		expect(screen.getByTestId('foryou-metric-renderer')).toBeInTheDocument()
	})

	it('routes diff to the diff renderer', () => {
		renderCard('diff')
		expect(screen.getByTestId('foryou-diff-renderer')).toBeInTheDocument()
	})

	it('resolves the visual artifact fileId to an inline data-URI preview', () => {
		useFileMock.mockReturnValue({
			data: buildFileDetail({ mimeType: 'image/png', content: 'aGVsbG8=', encoding: 'base64' }),
		})
		renderCard('visual')
		expect(useFileMock).toHaveBeenCalledWith('ws-1', '11111111-1111-4111-8111-111111111111')
		const preview = screen.getByTestId('foryou-visual-preview') as HTMLImageElement
		expect(preview.src).toBe('data:image/png;base64,aGVsbG8=')
		expect(screen.queryByTestId('foryou-visual-placeholder')).not.toBeInTheDocument()
	})

	it('falls back to the placeholder when the artifact file is not an inline-safe image', () => {
		useFileMock.mockReturnValue({
			data: buildFileDetail({ mimeType: 'image/svg+xml', name: 'diagram.svg' }),
		})
		renderCard('visual')
		expect(screen.getByTestId('foryou-visual-placeholder')).toBeInTheDocument()
		expect(screen.queryByTestId('foryou-visual-preview')).not.toBeInTheDocument()
	})

	function renderVisualWithStatus(status: string) {
		const notification = buildNotificationResponse({
			id: `notif-visual-${status}`,
			title: 'visual decision',
			objectId: 'obj-visual',
			status,
			metadata: {
				artifacts: [
					{ kind: 'visual', fileId: '11111111-1111-4111-8111-111111111111', title: 'shot.png' },
				],
				options: [
					{ label: 'Approve', value: 'approve', default: true },
					{ label: 'Reject', value: 'reject' },
				],
			},
		})
		render(
			<ArtifactDecisionCard
				workspaceId="ws-1"
				kind="visual"
				notification={notification}
				onRespond={vi.fn()}
			/>,
			{ wrapper: TestWrapper },
		)
	}

	it('shows the decision block for a pending visual notification', () => {
		renderVisualWithStatus('pending')
		expect(screen.getByTestId('decision-block')).toBeInTheDocument()
	})

	it('hides the decision block once the visual notification is resolved', () => {
		renderVisualWithStatus('resolved')
		expect(screen.queryByTestId('decision-block')).not.toBeInTheDocument()
	})

	it('hides the decision block for dismissed and expired visual notifications', () => {
		renderVisualWithStatus('dismissed')
		expect(screen.queryByTestId('decision-block')).not.toBeInTheDocument()
		renderVisualWithStatus('expired')
		expect(screen.queryAllByTestId('decision-block')).toHaveLength(0)
	})
})
