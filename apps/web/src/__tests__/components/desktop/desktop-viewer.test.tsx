import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
		emit(type: string, detail?: unknown) {
			this.listeners.get(type)?.(new CustomEvent(type, { detail }))
		}
		clipboardPasteFrom = vi.fn()
		sendKey = vi.fn()
		disconnect() {
			this.disconnected = true
		}
		focus() {}
	}
	return { instances, FakeRfb }
})

vi.mock('@novnc/novnc/lib/rfb', () => ({ default: FakeRfb }))
vi.mock('@/hooks/use-feature-flag', () => ({ useFeatureFlag: vi.fn(() => false) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/api', () => ({
	api: { desktop: { connect: vi.fn(), remove: vi.fn() } },
}))

import { DesktopViewer } from '@/components/desktop/desktop-viewer'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { api } from '@/lib/api'
import { KEYBOARD_SENTINEL } from '@/lib/desktop-keyboard'
import { createWorkspaceWrapper } from '../../setup'

const WS = '11111111-1111-4111-8111-111111111111'
const VIEWED = '99999999-9999-4999-8999-999999999999'

function renderViewer() {
	return render(<DesktopViewer workspaceId={WS} agentId={VIEWED} />, {
		wrapper: createWorkspaceWrapper(),
	})
}

describe('DesktopViewer', () => {
	beforeEach(() => {
		instances.length = 0
		vi.mocked(useFeatureFlag).mockReturnValue(false)
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

		// The status lives in the toolbar; the frame only carries the hint.
		const header = screen.getByRole('toolbar', { name: 'Computer controls' })
		expect(await within(header).findByText('Starting this computer…')).toBeInTheDocument()
		expect(screen.getByText(/first start can take up to a minute/i)).toBeInTheDocument()
		expect(screen.getAllByText(/starting this computer/i)).toHaveLength(1)
	})

	it('puts the live status and Take over in the toolbar', async () => {
		renderViewer()
		await waitFor(() => expect(instances).toHaveLength(1))
		act(() => (instances[0] as InstanceType<typeof FakeRfb>).emit('connect'))

		const header = screen.getByRole('toolbar', { name: 'Computer controls' })
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
		expect(api.desktop.connect).toHaveBeenCalledWith(WS, VIEWED)
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

	describe('analytics flow', () => {
		function renderWithFlow() {
			const flow = {
				opened: vi.fn(),
				firstFrame: vi.fn(),
				connectionLost: vi.fn(),
				takeOver: vi.fn(),
				closed: vi.fn(),
			}
			render(<DesktopViewer workspaceId={WS} agentId={VIEWED} flow={flow} />, {
				wrapper: createWorkspaceWrapper(),
			})
			return flow
		}

		it('reports the time to first frame once the picture is live, and take-over starts and ends', async () => {
			const user = userEvent.setup()
			const flow = renderWithFlow()
			await waitFor(() => expect(instances).toHaveLength(1))
			const rfb = instances[0] as InstanceType<typeof FakeRfb>

			act(() => rfb.emit('connect'))
			await screen.findByText('Live')
			expect(flow.firstFrame).toHaveBeenCalledTimes(1)
			expect(flow.firstFrame).toHaveBeenCalledWith(expect.any(Number))

			await user.click(screen.getByRole('button', { name: /take over/i }))
			expect(flow.takeOver).toHaveBeenLastCalledWith(true)
			await user.click(screen.getByRole('button', { name: /stop controlling/i }))
			expect(flow.takeOver).toHaveBeenLastCalledWith(false)
		})

		it('reports a lost connection with whether a picture had been shown', async () => {
			const flow = renderWithFlow()
			await waitFor(() => expect(instances).toHaveLength(1))
			const rfb = instances[0] as InstanceType<typeof FakeRfb>

			act(() => rfb.emit('connect'))
			await screen.findByText('Live')
			act(() => rfb.emit('disconnect'))

			expect(flow.connectionLost).toHaveBeenCalledTimes(1)
			expect(flow.connectionLost).toHaveBeenCalledWith(true)
		})

		it('reports a stream that closed before any picture as lost without a first frame', async () => {
			const flow = renderWithFlow()
			await waitFor(() => expect(instances).toHaveLength(1))
			const rfb = instances[0] as InstanceType<typeof FakeRfb>

			act(() => rfb.emit('disconnect'))

			expect(flow.firstFrame).not.toHaveBeenCalled()
			expect(flow.connectionLost).toHaveBeenCalledWith(false)
		})
	})

	describe('clipboard buttons', () => {
		async function takeOver(user: ReturnType<typeof userEvent.setup>) {
			renderViewer()
			await waitFor(() => expect(instances).toHaveLength(1))
			const rfb = instances[0] as InstanceType<typeof FakeRfb>
			act(() => rfb.emit('connect'))
			await screen.findByText('Live')
			await user.click(screen.getByRole('button', { name: /take over/i }))
			return rfb
		}

		it('are off without the flag', async () => {
			const user = userEvent.setup()
			await takeOver(user)

			expect(screen.queryByRole('button', { name: /paste from your clipboard/i })).toBeNull()
		})

		it('are not shown without a touch screen: the keys do the work', async () => {
			vi.mocked(useFeatureFlag).mockReturnValue(true)
			const user = userEvent.setup()
			renderViewer()
			await waitFor(() => expect(instances).toHaveLength(1))
			const rfb = instances[0] as InstanceType<typeof FakeRfb>
			act(() => rfb.emit('connect'))
			await screen.findByText('Live')
			expect(screen.queryByRole('button', { name: /paste from your clipboard/i })).toBeNull()

			await user.click(screen.getByRole('button', { name: /take over/i }))
			expect(screen.queryByRole('button', { name: /paste from your clipboard/i })).toBeNull()
			expect(screen.queryByRole('button', { name: /copy to your clipboard/i })).toBeNull()

			// Text from the computer that the person did not ask for is not theirs to take.
			act(() => rfb.emit('clipboard', { text: 'copied there' }))
			expect(screen.queryByRole('button', { name: /copy to your clipboard/i })).toBeNull()
		})

		it('bring in Copy only after the browser refused the write', async () => {
			vi.mocked(useFeatureFlag).mockReturnValue(true)
			const user = userEvent.setup()
			const rfb = await takeOver(user)
			const refused = new DOMException('no', 'NotAllowedError')
			const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(refused)

			act(() => {
				rfb.target.dispatchEvent(
					new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', ctrlKey: true, bubbles: true }),
				)
			})
			act(() => rfb.emit('clipboard', { text: 'copied there' }))

			expect(await screen.findByRole('button', { name: /copy to your clipboard/i })).toBeEnabled()
			expect(writeText).toHaveBeenCalledWith('copied there')
			expect(screen.queryByRole('button', { name: /paste from your clipboard/i })).toBeNull()

			await user.click(screen.getByRole('button', { name: /stop controlling/i }))
			expect(screen.queryByRole('button', { name: /copy to your clipboard/i })).toBeNull()
		})
	})

	it('puts the popup switch in a top row above the picture, with the toolbarEnd', async () => {
		const user = userEvent.setup()
		const { container } = render(
			<DesktopViewer
				workspaceId={WS}
				agentId={VIEWED}
				variant="immersive"
				toolbarEnd={<button type="button">Minimize</button>}
			/>,
			{ wrapper: createWorkspaceWrapper() },
		)
		await waitFor(() => expect(instances).toHaveLength(1))
		const rfb = instances[0] as InstanceType<typeof FakeRfb>
		act(() => rfb.emit('connect'))

		const switchBar = await screen.findByRole('toolbar', { name: 'Computer controls' })
		expect(within(switchBar).getByText('Watching')).toBeInTheDocument()
		const minimize = screen.getByRole('button', { name: 'Minimize' })
		expect(switchBar.parentElement).toBe(minimize.parentElement)
		// Nothing sits under the picture: the picture is the last thing in the viewer.
		const picture = container.querySelector('.aspect-video') as HTMLElement
		expect(picture.nextElementSibling).toBeNull()

		await user.click(screen.getByRole('button', { name: 'Take over' }))
		expect(rfb.viewOnly).toBe(false)
		expect(within(switchBar).getByText("You're in control")).toBeInTheDocument()
	})

	it('does not offer takeover before the stream is live', async () => {
		renderViewer()
		await waitFor(() => expect(instances).toHaveLength(1))

		expect(screen.queryByRole('button', { name: /take over/i })).not.toBeInTheDocument()
	})

	it('offers to wake an idle computer with a fresh ticket after the connection drops', async () => {
		const user = userEvent.setup()
		renderViewer()
		await waitFor(() => expect(instances).toHaveLength(1))
		const first = instances[0] as InstanceType<typeof FakeRfb>
		act(() => first.emit('connect'))
		act(() => first.emit('disconnect'))

		expect(await screen.findByText('The computer is idle')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /take over/i })).not.toBeInTheDocument()

		await user.click(screen.getByRole('button', { name: /wake up/i }))

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

	describe('on a phone', () => {
		const originalMatchMedia = window.matchMedia
		afterEach(() => {
			window.matchMedia = originalMatchMedia
		})

		function usePrimaryPointer(coarse: boolean) {
			window.matchMedia = ((query: string) =>
				({
					matches: coarse && query === '(pointer: coarse)',
					media: query,
					onchange: null,
					addEventListener: () => {},
					removeEventListener: () => {},
					addListener: () => {},
					removeListener: () => {},
					dispatchEvent: () => false,
				}) as unknown as MediaQueryList) as typeof window.matchMedia
		}

		async function takeControl() {
			const user = userEvent.setup()
			renderViewer()
			await waitFor(() => expect(instances).toHaveLength(1))
			const rfb = instances[0] as InstanceType<typeof FakeRfb>
			act(() => rfb.emit('connect'))
			await user.click(await screen.findByRole('button', { name: /take over/i }))
			return rfb
		}

		it('offers the keyboard only while in control', async () => {
			usePrimaryPointer(true)
			const user = userEvent.setup()
			renderViewer()
			await waitFor(() => expect(instances).toHaveLength(1))
			act(() => (instances[0] as InstanceType<typeof FakeRfb>).emit('connect'))

			await user.click(await screen.findByRole('button', { name: /take over/i }))
			expect(screen.getByRole('button', { name: 'Show keyboard' })).toBeInTheDocument()
			expect(screen.getByLabelText('Type on the computer')).toBeInTheDocument()

			await user.click(screen.getByRole('button', { name: /stop controlling/i }))
			expect(screen.queryByRole('button', { name: 'Show keyboard' })).not.toBeInTheDocument()
			expect(screen.queryByLabelText('Type on the computer')).not.toBeInTheDocument()
		})

		it('keeps both clipboard buttons, with Copy waiting for text from the computer', async () => {
			vi.mocked(useFeatureFlag).mockReturnValue(true)
			usePrimaryPointer(true)
			const user = userEvent.setup()
			const rfb = await takeControl()

			expect(screen.getByRole('button', { name: /paste from your clipboard/i })).toBeEnabled()
			expect(screen.getByRole('button', { name: /copy to your clipboard/i })).toBeDisabled()

			act(() => rfb.emit('clipboard', { text: 'copied there' }))
			expect(screen.getByRole('button', { name: /copy to your clipboard/i })).toBeEnabled()

			await user.click(screen.getByRole('button', { name: /stop controlling/i }))
			expect(screen.queryByRole('button', { name: /paste from your clipboard/i })).toBeNull()
		})

		it('has no on-screen keyboard where a real keyboard is the main input', async () => {
			usePrimaryPointer(false)
			await takeControl()

			expect(screen.queryByRole('button', { name: 'Show keyboard' })).not.toBeInTheDocument()
			expect(screen.queryByLabelText('Type on the computer')).not.toBeInTheDocument()
		})

		it('sends typed text to the computer as key presses', async () => {
			usePrimaryPointer(true)
			const rfb = await takeControl()
			const field = screen.getByLabelText('Type on the computer')

			fireEvent.input(field, { target: { value: `${KEYBOARD_SENTINEL}Hi` } })

			expect(rfb.sendKey.mock.calls).toEqual([
				[0x48, null],
				[0x69, null],
			])
		})

		it('sends Backspace when the keyboard deletes a letter', async () => {
			usePrimaryPointer(true)
			const rfb = await takeControl()
			const field = screen.getByLabelText('Type on the computer')

			fireEvent.input(field, { target: { value: KEYBOARD_SENTINEL.slice(1) } })

			expect(rfb.sendKey.mock.calls).toEqual([[0xff08, 'Backspace']])
		})

		it('sends Enter as Return', async () => {
			usePrimaryPointer(true)
			const rfb = await takeControl()
			const field = screen.getByLabelText('Type on the computer')

			const notCancelled = fireEvent.keyDown(field, { key: 'Enter', code: 'Enter' })

			expect(notCancelled).toBe(false)
			expect(rfb.sendKey.mock.calls).toEqual([[0xff0d, 'Enter']])
		})

		it('puts the keyboard away when asked, and brings it back', async () => {
			usePrimaryPointer(true)
			const user = userEvent.setup()
			await takeControl()
			const field = screen.getByLabelText('Type on the computer')

			await user.click(screen.getByRole('button', { name: 'Show keyboard' }))
			expect(field).toHaveFocus()
			await user.click(screen.getByRole('button', { name: 'Hide keyboard' }))
			expect(field).not.toHaveFocus()
			expect(screen.getByRole('button', { name: 'Show keyboard' })).toBeInTheDocument()
		})
	})
})
