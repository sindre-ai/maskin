import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildWorkspaceWithRole } from '../../factories'
import { TestWrapper } from '../../setup'

const mockGet = vi.fn()
const mockSet = vi.fn()
const mockActors = vi.fn()
const mockWorkspace = { current: buildWorkspaceWithRole({ role: 'admin' }) }
const mockActor = vi.fn()

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
			actors: { ...actual.api.actors, list: (...a: unknown[]) => mockActors(...a) },
			dineroBooking: {
				get: (...a: unknown[]) => mockGet(...a),
				set: (...a: unknown[]) => mockSet(...a),
			},
		},
	}
})

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { DineroBookingCard } from '@/components/settings/dinero-booking-card'

const STATEMENT = 'With booking on, the flow books the vouchers it is sure about.'

function state(over: Record<string, unknown> = {}) {
	return { enabled: false, statement: STATEMENT, set_by: null, set_at: null, ...over }
}

function renderCard() {
	return render(
		<TestWrapper>
			<DineroBookingCard workspaceId={mockWorkspace.current.id} />
		</TestWrapper>,
	)
}

describe('Settings > Dinero booking', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockGet.mockResolvedValue(state())
		mockSet.mockImplementation(async (_ws: string, body: { enabled: boolean }) =>
			state({ enabled: body.enabled }),
		)
		mockActors.mockResolvedValue([])
		mockActor.mockReturnValue({ id: 'me', name: 'Me', type: 'human', email: null })
		mockWorkspace.current = buildWorkspaceWithRole({ role: 'admin' })
	})

	it('shows the statement and that the switch covers every company on the login', async () => {
		renderCard()
		expect(await screen.findByText(STATEMENT)).toBeInTheDocument()
		expect(screen.getByText(/covers every company that login reaches/)).toBeInTheDocument()
		expect(screen.getByText(/Booking is off/)).toBeInTheDocument()
	})

	it('needs the tick before off can go to on, and sends acknowledged true', async () => {
		const user = userEvent.setup()
		renderCard()
		const button = await screen.findByRole('button', { name: 'Switch booking on' })
		expect(button).toBeDisabled()
		await user.click(screen.getByRole('checkbox', { name: 'I have read this' }))
		expect(button).toBeEnabled()
		await user.click(button)
		expect(mockSet).toHaveBeenCalledWith(mockWorkspace.current.id, {
			enabled: true,
			acknowledged: true,
		})
	})

	it('asks for a new tick after booking was switched on and off again', async () => {
		let enabled = false
		mockGet.mockImplementation(async () => state({ enabled }))
		mockSet.mockImplementation(async (_ws: string, body: { enabled: boolean }) => {
			enabled = body.enabled
			return state({ enabled })
		})
		const user = userEvent.setup()
		renderCard()
		await user.click(await screen.findByRole('checkbox', { name: 'I have read this' }))
		await user.click(screen.getByRole('button', { name: 'Switch booking on' }))
		await user.click(await screen.findByRole('button', { name: 'Switch booking off' }))
		const again = await screen.findByRole('button', { name: 'Switch booking on' })
		expect(screen.getByRole('checkbox', { name: 'I have read this' })).not.toBeChecked()
		expect(again).toBeDisabled()
	})

	it('switches on to off with one click and no tick', async () => {
		mockGet.mockResolvedValue(state({ enabled: true, set_at: '2026-11-25T10:00:00.000Z' }))
		const user = userEvent.setup()
		renderCard()
		expect(await screen.findByText(/Booking is on/)).toBeInTheDocument()
		expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
		await user.click(screen.getByRole('button', { name: 'Switch booking off' }))
		expect(mockSet).toHaveBeenCalledWith(mockWorkspace.current.id, { enabled: false })
	})

	it('is hidden for a member who is not an admin or owner', () => {
		mockWorkspace.current = buildWorkspaceWithRole({ role: 'member' })
		renderCard()
		expect(screen.queryByText('Dinero booking')).not.toBeInTheDocument()
		expect(mockGet).not.toHaveBeenCalled()
	})

	it('is hidden for an agent even when its role is admin', () => {
		mockActor.mockReturnValue({ id: 'a', name: 'Bot', type: 'agent', email: null })
		renderCard()
		expect(screen.queryByText('Dinero booking')).not.toBeInTheDocument()
	})
})
