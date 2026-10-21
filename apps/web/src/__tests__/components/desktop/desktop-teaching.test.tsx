import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { instances, FakeRfb } = vi.hoisted(() => {
	type Listener = (event: CustomEvent) => void
	const instances: Array<InstanceType<typeof FakeRfb>> = []
	class FakeRfb {
		viewOnly = true
		scaleViewport = false
		resizeSession = true
		listeners = new Map<string, Listener>()
		canvas: HTMLCanvasElement
		constructor(
			public target: HTMLElement,
			public url: string,
			public options: unknown,
		) {
			// noVNC mounts a canvas inside the target; the recorder reads and snapshots it.
			this.canvas = document.createElement('canvas')
			this.canvas.getBoundingClientRect = () =>
				({ left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360 }) as DOMRect
			target.appendChild(this.canvas)
			instances.push(this)
		}
		addEventListener(type: string, listener: Listener) {
			this.listeners.set(type, listener)
		}
		emit(type: string) {
			this.listeners.get(type)?.(new CustomEvent(type))
		}
		disconnect() {}
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
		desktop: { connect: vi.fn(), remove: vi.fn(), teach: vi.fn(), deleteTeaching: vi.fn() },
		actors: { list: vi.fn() },
		sessions: { get: vi.fn() },
	},
}))

import { DesktopViewer } from '@/components/desktop/desktop-viewer'
import { api } from '@/lib/api'
import { toast } from 'sonner'
import { createWorkspaceWrapper } from '../../setup'

const WS = '11111111-1111-4111-8111-111111111111'
const VIEWED = '99999999-9999-4999-8999-999999999999'
const CHIEF = '22222222-2222-4222-8222-222222222222'
const COACH = '33333333-3333-4333-8333-333333333333'

const actor = (id: string, name: string, type: 'agent' | 'human' = 'agent') => ({ id, name, type })

function renderViewer() {
	return render(<DesktopViewer workspaceId={WS} agentId={VIEWED} onOpenAgent={vi.fn()} />, {
		wrapper: createWorkspaceWrapper(),
	})
}

async function goLive() {
	renderViewer()
	await waitFor(() => expect(instances).toHaveLength(1))
	const rfb = instances[0] as InstanceType<typeof FakeRfb>
	act(() => rfb.emit('connect'))
	return rfb
}

async function startRecording(user: ReturnType<typeof userEvent.setup>) {
	const rfb = await goLive()
	await user.click(screen.getByRole('button', { name: 'Teach a task' }))
	await user.type(
		await screen.findByLabelText('What are you about to show?'),
		'Export the weekly report to PDF',
	)
	await user.click(screen.getByRole('button', { name: 'Start recording' }))
	return rfb
}

const press = (el: Element, x = 320, y = 180) =>
	el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: x, clientY: y }))

// Skipped while "Teach a task" is switched off in the desktop viewer.
describe.skip('Teach a task on an agent computer', () => {
	beforeEach(() => {
		instances.length = 0
		localStorage.clear()
		vi.clearAllMocks()
		vi.mocked(api.desktop.connect).mockResolvedValue({
			ticket: 'tkt',
			path: '/api/desktop/stream',
			password: 'pw',
		})
		vi.mocked(api.actors.list).mockResolvedValue([
			actor(CHIEF, 'Chief of Staff'),
			actor(COACH, 'Workspace Coach'),
			actor('44444444-4444-4444-8444-444444444444', 'A Human', 'human'),
		] as never)
		vi.mocked(api.sessions.get).mockResolvedValue({ id: 'sess', status: 'running' } as never)
		vi.mocked(api.desktop.teach).mockResolvedValue({
			recording_id: 'abcdef123456',
			session_id: '55555555-5555-4555-8555-555555555555',
			agent_id: COACH,
			frames_stored: 2,
			events_stored: 1,
		})
		vi.mocked(api.desktop.deleteTeaching).mockResolvedValue({ deleted: 4 })
		// jsdom has no canvas encoder.
		HTMLCanvasElement.prototype.toBlob = (cb: BlobCallback) => {
			cb(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9])], { type: 'image/jpeg' }))
		}
	})

	it('offers Teach a task in the toolbar only once the desktop is live', async () => {
		renderViewer()
		await waitFor(() => expect(instances).toHaveLength(1))
		expect(screen.queryByRole('button', { name: 'Teach a task' })).not.toBeInTheDocument()

		act(() => (instances[0] as InstanceType<typeof FakeRfb>).emit('connect'))

		const header = screen.getByRole('toolbar', { name: 'Computer controls' })
		expect(await within(header).findByRole('button', { name: 'Teach a task' })).toBeInTheDocument()
	})

	it('needs a description before it will start, and lists only agents', async () => {
		const user = userEvent.setup()
		await goLive()
		await user.click(screen.getByRole('button', { name: 'Teach a task' }))

		expect(await screen.findByRole('button', { name: 'Start recording' })).toBeDisabled()
		await user.click(screen.getByRole('combobox', { name: /which agent/i }))
		expect(await screen.findByRole('option', { name: 'Chief of Staff' })).toBeInTheDocument()
		expect(screen.queryByRole('option', { name: 'A Human' })).not.toBeInTheDocument()
	})

	it('starts recording: takes control, shows the recording chip and a Stop button', async () => {
		const user = userEvent.setup()
		const rfb = await startRecording(user)

		const header = screen.getByRole('toolbar', { name: 'Computer controls' })
		expect(await within(header).findByText(/^Recording · 0:00 · teaching /)).toBeInTheDocument()
		expect(within(header).getByRole('button', { name: 'Stop recording' })).toBeInTheDocument()
		expect(within(header).queryByRole('button', { name: 'Take over' })).not.toBeInTheDocument()
		expect(rfb.viewOnly).toBe(false) // the person is driving, so they can demonstrate
	})

	it('sends what was recorded to the chosen agent when stopped', async () => {
		const user = userEvent.setup()
		const rfb = await startRecording(user)

		press(rfb.canvas) // a click in the middle of the screen
		await user.click(screen.getByRole('button', { name: 'Stop recording' }))

		await waitFor(() => expect(api.desktop.teach).toHaveBeenCalledTimes(1))
		const [ws, body] = vi.mocked(api.desktop.teach).mock.calls[0] as [
			string,
			Record<string, unknown>,
		]
		expect(ws).toBe(WS)
		expect(body).toMatchObject({
			agent_id: COACH, // the workspace's default agent, since nothing was picked or remembered
			description: 'Export the weekly report to PDF',
		})
		const events = body.events as Array<Record<string, unknown>>
		expect(events[0]).toMatchObject({ type: 'click', x: 640, y: 360, button: 'left' })
		expect((body.frames as unknown[]).length).toBeGreaterThanOrEqual(1)
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith(
				'Workspace Coach is learning this task',
				expect.anything(),
			),
		)
		// Back to normal: Take over is offered again and the recording chip is gone.
		expect(await screen.findByRole('button', { name: 'Take over' })).toBeInTheDocument()
		expect(screen.queryByText(/^Recording/)).not.toBeInTheDocument()
	})

	it('does not send an empty recording', async () => {
		const user = userEvent.setup()
		await startRecording(user)

		await user.click(screen.getByRole('button', { name: 'Stop recording' }))

		await waitFor(() =>
			expect(toast.info).toHaveBeenCalledWith('Nothing was recorded', expect.anything()),
		)
		expect(api.desktop.teach).not.toHaveBeenCalled()
	})

	it('reports a failed send without losing the page', async () => {
		vi.mocked(api.desktop.teach).mockRejectedValue(
			new Error('Could not start the learning session'),
		)
		const user = userEvent.setup()
		const rfb = await startRecording(user)
		press(rfb.canvas)

		await user.click(screen.getByRole('button', { name: 'Stop recording' }))

		await waitFor(() =>
			expect(toast.error).toHaveBeenCalledWith("Couldn't send the recording", {
				description: 'Could not start the learning session',
			}),
		)
		expect(await screen.findByRole('button', { name: 'Teach a task' })).toBeEnabled()
	})

	it("keeps the recording while the agent's session is still running", async () => {
		const user = userEvent.setup()
		const rfb = await startRecording(user)
		press(rfb.canvas)
		await user.click(screen.getByRole('button', { name: 'Stop recording' }))
		await waitFor(() => expect(api.sessions.get).toHaveBeenCalled())

		expect(api.desktop.deleteTeaching).not.toHaveBeenCalled()
	})

	it("deletes the recording once the agent's session has ended", async () => {
		vi.mocked(api.sessions.get).mockResolvedValue({ id: 'sess', status: 'completed' } as never)
		const user = userEvent.setup()
		const rfb = await startRecording(user)
		press(rfb.canvas)

		await user.click(screen.getByRole('button', { name: 'Stop recording' }))

		await waitFor(() =>
			expect(api.desktop.deleteTeaching).toHaveBeenCalledWith(WS, 'abcdef123456', COACH),
		)
		expect(api.desktop.deleteTeaching).toHaveBeenCalledTimes(1)
	})

	it('remembers the agent that was taught last', async () => {
		const user = userEvent.setup()
		localStorage.setItem('desktop-teach-agent', CHIEF)
		const rfb = await startRecording(user)
		press(rfb.canvas)

		await user.click(screen.getByRole('button', { name: 'Stop recording' }))

		await waitFor(() => expect(api.desktop.teach).toHaveBeenCalled())
		expect(vi.mocked(api.desktop.teach).mock.calls[0]?.[1]).toMatchObject({ agent_id: CHIEF })
	})

	it('discards the recording if the connection drops mid-way', async () => {
		const user = userEvent.setup()
		const rfb = await startRecording(user)
		press(rfb.canvas)

		act(() => rfb.emit('disconnect'))

		await waitFor(() =>
			expect(toast.warning).toHaveBeenCalledWith(
				'The desktop connection dropped',
				expect.anything(),
			),
		)
		expect(screen.queryByText(/^Recording/)).not.toBeInTheDocument()
		expect(api.desktop.teach).not.toHaveBeenCalled()
	})
})
