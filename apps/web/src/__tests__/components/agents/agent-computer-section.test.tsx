import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { instances, FakeRfb } = vi.hoisted(() => {
	const instances: Array<InstanceType<typeof FakeRfb>> = []
	class FakeRfb {
		viewOnly = true
		scaleViewport = false
		resizeSession = true
		disconnected = false
		listeners = new Map<string, (e: CustomEvent) => void>()
		constructor(
			public target: HTMLElement,
			public url: string,
			public options: unknown,
		) {
			instances.push(this)
		}
		addEventListener(type: string, listener: (e: CustomEvent) => void) {
			this.listeners.set(type, listener)
		}
		emit(type: string) {
			this.listeners.get(type)?.(new CustomEvent(type))
		}
		disconnect() {
			this.disconnected = true
		}
		focus() {}
	}
	return { instances, FakeRfb }
})

vi.mock('@novnc/novnc/lib/rfb', () => ({ default: FakeRfb }))
vi.mock('sonner', () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('@/lib/api', () => ({
	api: {
		desktop: { connect: vi.fn(), list: vi.fn(), remove: vi.fn(), teach: vi.fn() },
		actors: { list: vi.fn() },
	},
}))

import { AgentComputerSection } from '@/components/agents/agent-computer-section'
import { api } from '@/lib/api'
import { createWorkspaceWrapper } from '../../setup'

const AGENT = '99999999-9999-4999-8999-999999999999'
const agent = { id: AGENT, name: 'Ledger', type: 'agent' } as never

function listing(status?: 'running' | 'suspended') {
	vi.mocked(api.desktop.list).mockResolvedValue({
		desktops: status ? [{ agent_id: AGENT, status }] : [],
	})
}

const renderSection = () =>
	render(<AgentComputerSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

describe('AgentComputerSection', () => {
	beforeEach(() => {
		instances.length = 0
		vi.clearAllMocks()
		vi.mocked(api.desktop.connect).mockResolvedValue({
			ticket: 'tkt',
			path: '/api/desktop/stream',
			password: 'pw',
		})
		vi.mocked(api.actors.list).mockResolvedValue([])
	})

	it('does not start a computer just because the page was opened', async () => {
		listing(undefined)
		renderSection()

		expect(await screen.findByRole('button', { name: 'Start computer' })).toBeInTheDocument()
		expect(screen.getByText('Not started yet')).toBeInTheDocument()
		expect(api.desktop.connect).not.toHaveBeenCalled()
	})

	it('does not wake a sleeping computer on its own, and says it is asleep', async () => {
		listing('suspended')
		renderSection()

		expect(await screen.findByRole('button', { name: 'Wake up' })).toBeInTheDocument()
		expect(screen.getByText('Asleep')).toBeInTheDocument()
		expect(api.desktop.connect).not.toHaveBeenCalled()
	})

	it('connects for this agent when the user starts it', async () => {
		const user = userEvent.setup()
		listing(undefined)
		renderSection()

		await user.click(await screen.findByRole('button', { name: 'Start computer' }))

		await waitFor(() => expect(instances).toHaveLength(1))
		expect(api.desktop.connect).toHaveBeenCalledWith(expect.any(String), AGENT)
	})

	it('connects straight away when the computer is already running', async () => {
		listing('running')
		renderSection()

		await waitFor(() => expect(instances).toHaveLength(1))
		expect(screen.getByText('Running')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: 'Start computer' })).not.toBeInTheDocument()
	})

	it('expands into a popup with a single connection, and shrinks back', async () => {
		const user = userEvent.setup()
		listing('running')
		renderSection()
		await waitFor(() => expect(instances).toHaveLength(1))
		const inline = instances[0] as InstanceType<typeof FakeRfb>
		act(() => inline.emit('connect'))

		await user.click(await screen.findByRole('button', { name: 'Open computer in a popup' }))

		const dialog = await screen.findByRole('dialog')
		// The viewer mounts once the popup has finished animating in (so noVNC fits the
		// final size, not a moving one).
		await waitFor(() => expect(instances).toHaveLength(2))
		// The inline view closed its stream; the popup opened the only live one.
		expect(inline.disconnected).toBe(true)
		act(() => (instances[1] as InstanceType<typeof FakeRfb>).emit('connect'))
		// The popup's controls float under the picture once it is live.
		expect(await within(dialog).findByRole('button', { name: 'Take over' })).toBeInTheDocument()
		expect(within(dialog).getByText('Take control')).toBeInTheDocument()
		expect(screen.getByText(/is open in a popup/i)).toBeInTheDocument()

		await user.click(within(dialog).getByRole('button', { name: 'Close popup' }))

		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
		expect((instances[1] as InstanceType<typeof FakeRfb>).disconnected).toBe(true)
		await waitFor(() => expect(instances).toHaveLength(3))
		expect(screen.queryByText(/is open in a popup/i)).not.toBeInTheDocument()
	})
})
