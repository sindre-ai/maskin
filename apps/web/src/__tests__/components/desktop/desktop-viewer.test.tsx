import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { instances, FakeRfb } = vi.hoisted(() => {
	type Listener = (event: CustomEvent) => void
	const instances: Array<InstanceType<typeof FakeRfb>> = []
	class FakeRfb {
		viewOnly = false
		scaleViewport = false
		resizeSession = true
		disconnected = false
		listeners = new Map<string, Listener>()
		constructor(
			public target: HTMLElement,
			public url: string,
			public options: { credentials?: { password?: string } },
		) {
			instances.push(this)
		}
		addEventListener(type: string, listener: Listener) {
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
vi.mock('@/lib/api', () => ({
	api: { desktop: { connect: vi.fn(), remove: vi.fn() } },
}))

import { DesktopViewer } from '@/components/desktop/desktop-viewer'
import { api } from '@/lib/api'
import { createWorkspaceWrapper } from '../../setup'

const WS = '11111111-1111-4111-8111-111111111111'

// The viewer publishes its status and Take over button into the page header, so
// render it under the header stand-in the app shell's nav row is replaced by.
function renderViewer() {
	return render(<DesktopViewer workspaceId={WS} />, {
		wrapper: createWorkspaceWrapper({}, { renderPageHeader: true }),
	})
}

describe('DesktopViewer', () => {
	beforeEach(() => {
		instances.length = 0
		vi.mocked(api.desktop.connect).mockReset()
		vi.mocked(api.desktop.connect).mockResolvedValue({
			ticket: 'tkt',
			path: '/api/desktop/stream',
			password: 'vnc-pw',
		})
	})

	it('shows the starting state while the desktop boots', async () => {
		vi.mocked(api.desktop.connect).mockReturnValue(new Promise(() => {}))
		renderViewer()

		// The status lives in the header; the frame only carries the hint.
		const header = screen.getByRole('banner')
		expect(await within(header).findByText('Starting your desktop…')).toBeInTheDocument()
		expect(screen.getByText(/first start can take up to a minute/i)).toBeInTheDocument()
		expect(screen.getAllByText(/starting your desktop/i)).toHaveLength(1)
	})

	it('puts the live status and Take over in the header, not the page', async () => {
		renderViewer()
		await waitFor(() => expect(instances).toHaveLength(1))
		act(() => (instances[0] as InstanceType<typeof FakeRfb>).emit('connect'))

		const header = screen.getByRole('banner')
		expect(await within(header).findByText('Live')).toBeInTheDocument()
		expect(within(header).getByRole('button', { name: /take over/i })).toBeInTheDocument()
		expect(screen.getAllByText('Live')).toHaveLength(1)
		expect(screen.getAllByRole('button', { name: /take over/i })).toHaveLength(1)
	})

	it('connects with the ticket and password, view-only by default', async () => {
		renderViewer()

		await waitFor(() => expect(instances).toHaveLength(1))
		const rfb = instances[0] as InstanceType<typeof FakeRfb>
		const url = new URL(rfb.url)
		expect(url.pathname).toBe('/api/desktop/stream')
		expect(url.searchParams.get('ticket')).toBe('tkt')
		expect(url.protocol).toMatch(/^wss?:$/)
		expect(rfb.options.credentials?.password).toBe('vnc-pw')
		expect(rfb.viewOnly).toBe(true)
		expect(rfb.scaleViewport).toBe(true)
		expect(api.desktop.connect).toHaveBeenCalledWith(WS)
	})

	it('lets the user take over and hand control back', async () => {
		const user = userEvent.setup()
		renderViewer()
		await waitFor(() => expect(instances).toHaveLength(1))
		const rfb = instances[0] as InstanceType<typeof FakeRfb>

		act(() => rfb.emit('connect'))
		expect(await screen.findByText('Live')).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: /take over/i }))
		expect(rfb.viewOnly).toBe(false)

		await user.click(screen.getByRole('button', { name: /stop controlling/i }))
		expect(rfb.viewOnly).toBe(true)
	})

	it('does not offer takeover before the stream is live', async () => {
		renderViewer()
		await waitFor(() => expect(instances).toHaveLength(1))

		expect(screen.queryByRole('button', { name: /take over/i })).not.toBeInTheDocument()
	})

	it('offers a reconnect with a fresh ticket after the connection drops', async () => {
		const user = userEvent.setup()
		renderViewer()
		await waitFor(() => expect(instances).toHaveLength(1))
		const first = instances[0] as InstanceType<typeof FakeRfb>
		act(() => first.emit('connect'))
		act(() => first.emit('disconnect'))

		expect(await screen.findByText('The connection was closed')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /take over/i })).not.toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: /reconnect/i }))

		await waitFor(() => expect(instances).toHaveLength(2))
		expect(api.desktop.connect).toHaveBeenCalledTimes(2)
	})

	it('reports a failure to start and can retry', async () => {
		const user = userEvent.setup()
		vi.mocked(api.desktop.connect).mockRejectedValueOnce(new Error('No desktop could be started'))
		renderViewer()

		expect(await screen.findByText("Couldn't open the desktop")).toBeInTheDocument()
		expect(screen.getByText('No desktop could be started')).toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: /reconnect/i }))
		await waitFor(() => expect(instances).toHaveLength(1))
	})

	it('reports a stream that never came up', async () => {
		renderViewer()
		await waitFor(() => expect(instances).toHaveLength(1))

		act(() => (instances[0] as InstanceType<typeof FakeRfb>).emit('disconnect'))

		expect(await screen.findByText("Couldn't open the desktop")).toBeInTheDocument()
		expect(screen.getByText("Couldn't connect to the desktop.")).toBeInTheDocument()
	})

	it('closes the stream on unmount', async () => {
		const { unmount } = renderViewer()
		await waitFor(() => expect(instances).toHaveLength(1))

		unmount()

		expect((instances[0] as InstanceType<typeof FakeRfb>).disconnected).toBe(true)
	})
})
