import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ArtifactDecisionCard, readArtifactKind } from '@/components/foryou/artifact-decision-card'
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

	it('returns null when the artifact kind is unknown (e.g. diff before T12 lands)', () => {
		const notification = buildNotificationResponse({
			metadata: {
				artifacts: [
					{ kind: 'diff', fileId: '11111111-1111-4111-8111-111111111111', title: 'PR diff' },
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
	})

	function renderCard(kind: 'mail' | 'post' | 'visual' | 'metric') {
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
})
