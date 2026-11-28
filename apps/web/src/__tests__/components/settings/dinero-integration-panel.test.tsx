import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWorkspaceWithRole } from '../../factories'
import { TestWrapper } from '../../setup'

const mockWorkspace = { current: buildWorkspaceWithRole({ role: 'admin' }) }
const mockActor = vi.fn()
const mockLog = vi.fn()
const mockBooking = vi.fn()

vi.mock('@/lib/workspace-context', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/workspace-context')>()),
	useWorkspace: () => ({
		workspace: mockWorkspace.current,
		workspaceId: mockWorkspace.current.id,
		sseStatus: 'connected',
	}),
}))

vi.mock('@/lib/auth', () => ({ getStoredActor: () => mockActor() }))

vi.mock('@/lib/api', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/lib/api')>()
	return {
		...actual,
		api: {
			...actual.api,
			actors: { ...actual.api.actors, list: vi.fn().mockResolvedValue([]) },
			dineroBooking: { get: (...a: unknown[]) => mockBooking(...a), set: vi.fn() },
			dineroReview: {
				...actual.api.dineroReview,
				log: (...a: unknown[]) => mockLog(...a),
				vatReport: vi.fn().mockResolvedValue({
					from: '',
					to: '',
					lines: [],
					totals: { input_vat: 0, output_vat: 0, complete: true, uncalculated_lines: 0 },
					figures_hash: 'a',
					notice: '',
				}),
			},
		},
	}
})

import { DineroIntegrationPanel } from '@/components/settings/dinero-integration-panel'

function renderPanel() {
	return render(
		<TestWrapper>
			<DineroIntegrationPanel workspaceId={mockWorkspace.current.id} />
		</TestWrapper>,
	)
}

describe('DineroIntegrationPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockLog.mockResolvedValue({
			from: '2026-10-24',
			to: '2026-11-23',
			items: [],
			figures_hash: 'a',
			approval: null,
			truncated: false,
		})
		mockBooking.mockResolvedValue({
			enabled: false,
			statement: 'Statement',
			set_by: null,
			set_at: null,
		})
		mockActor.mockReturnValue({ id: 'me', name: 'Me', type: 'human', email: null })
		mockWorkspace.current = buildWorkspaceWithRole({ role: 'admin' })
	})

	it('shows the review log to an admin', async () => {
		renderPanel()
		expect(await screen.findByRole('heading', { name: 'Dinero review' })).toBeInTheDocument()
		expect(mockLog).toHaveBeenCalled()
	})

	it('shows nothing and asks for nothing when the person is only a member', () => {
		mockWorkspace.current = buildWorkspaceWithRole({ role: 'member' })
		const { container } = renderPanel()
		expect(container).toBeEmptyDOMElement()
		expect(mockLog).not.toHaveBeenCalled()
		expect(mockBooking).not.toHaveBeenCalled()
	})
})
