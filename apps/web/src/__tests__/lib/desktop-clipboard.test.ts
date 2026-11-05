import { attachClipboardShortcuts, copyFromDesktop, pasteToDesktop } from '@/lib/desktop-clipboard'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function fakeRfb() {
	return { clipboardPasteFrom: vi.fn(), sendKey: vi.fn(), focus: vi.fn() }
}

function stubClipboard(clipboard: Partial<Clipboard>) {
	Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true })
}

describe('desktop clipboard', () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it('sends the clipboard text to the computer, then presses Ctrl+V', async () => {
		stubClipboard({ readText: vi.fn().mockResolvedValue('a sentence') })
		const rfb = fakeRfb()

		const pending = pasteToDesktop(rfb)
		await vi.runAllTimersAsync()

		expect(await pending).toEqual({ ok: true })
		expect(rfb.clipboardPasteFrom).toHaveBeenCalledWith('a sentence')
		// Ctrl down, V down, V up, Ctrl up: the text must be on the computer before Ctrl+V.
		expect(rfb.sendKey.mock.calls.map(([, code, down]) => `${code}:${down}`)).toEqual([
			'ControlLeft:true',
			'KeyV:true',
			'KeyV:false',
			'ControlLeft:false',
		])
		expect(rfb.clipboardPasteFrom.mock.invocationCallOrder[0]).toBeLessThan(
			rfb.sendKey.mock.invocationCallOrder[0] as number,
		)
	})

	it('says so when the browser blocks reading the clipboard, and sends nothing', async () => {
		stubClipboard({
			readText: vi.fn().mockRejectedValue(new DOMException('no', 'NotAllowedError')),
		})
		const rfb = fakeRfb()

		const result = await pasteToDesktop(rfb)

		expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/blocked/i) })
		expect(rfb.clipboardPasteFrom).not.toHaveBeenCalled()
		expect(rfb.sendKey).not.toHaveBeenCalled()
	})

	it('does not paste an empty clipboard', async () => {
		stubClipboard({ readText: vi.fn().mockResolvedValue('') })
		const rfb = fakeRfb()

		expect(await pasteToDesktop(rfb)).toMatchObject({ ok: false })
		expect(rfb.clipboardPasteFrom).not.toHaveBeenCalled()
	})

	it('copies text from the computer to the browser clipboard', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined)
		stubClipboard({ writeText })

		expect(await copyFromDesktop('from the computer')).toEqual({ ok: true })
		expect(writeText).toHaveBeenCalledWith('from the computer')
	})

	it('says so when the browser blocks writing the clipboard', async () => {
		stubClipboard({
			writeText: vi.fn().mockRejectedValue(new DOMException('no', 'NotAllowedError')),
		})

		expect(await copyFromDesktop('x')).toMatchObject({
			ok: false,
			message: expect.stringMatching(/blocked/i),
		})
	})
})

describe('clipboard shortcuts on the computer picture', () => {
	let target: HTMLElement
	let canvas: HTMLElement
	let reachedNoVnc: string[]
	let rfb: ReturnType<typeof fakeRfb>
	let handlers: { onPasteFailed: ReturnType<typeof vi.fn>; onCopyPressed: ReturnType<typeof vi.fn> }
	let detach: () => void

	beforeEach(() => {
		vi.useFakeTimers()
		target = document.createElement('div')
		canvas = document.createElement('canvas')
		target.appendChild(canvas)
		document.body.appendChild(target)
		// Stands in for noVNC: its listener sits on the canvas, below the viewer's capture listener.
		reachedNoVnc = []
		canvas.addEventListener('keydown', (e) => reachedNoVnc.push(`${e.key}`))
		rfb = fakeRfb()
		handlers = { onPasteFailed: vi.fn(), onCopyPressed: vi.fn() }
		detach = attachClipboardShortcuts(target, () => rfb, handlers)
	})
	afterEach(() => {
		detach()
		target.remove()
		vi.useRealTimers()
	})

	function press(init: KeyboardEventInit) {
		const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
		canvas.dispatchEvent(event)
		return event
	}

	function paste(text: string) {
		const event = new Event('paste', { bubbles: true, cancelable: true })
		Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } })
		canvas.dispatchEvent(event)
		return event
	}

	const sentKeys = () => rfb.sendKey.mock.calls.map(([, code, down]) => `${code}:${down}`)
	const ctrlC = ['ControlLeft:true', 'KeyC:true', 'KeyC:false', 'ControlLeft:false']

	it.each([
		['Ctrl', { ctrlKey: true }],
		['Cmd', { metaKey: true }],
	])('pastes the text from the paste event with %s+V, as Ctrl+V', async (_name, mod) => {
		const keydown = press({ key: 'v', code: 'KeyV', ...mod })
		// V must not reach noVNC, and must not be cancelled or the browser never fires paste.
		expect(reachedNoVnc).toEqual([])
		expect(keydown.defaultPrevented).toBe(false)

		const pasteEvent = paste('a sentence')
		await vi.runAllTimersAsync()

		expect(pasteEvent.defaultPrevented).toBe(true)
		expect(rfb.clipboardPasteFrom).toHaveBeenCalledWith('a sentence')
		expect(sentKeys()).toEqual(['ControlLeft:true', 'KeyV:true', 'KeyV:false', 'ControlLeft:false'])
		expect(rfb.clipboardPasteFrom.mock.invocationCallOrder[0]).toBeLessThan(
			rfb.sendKey.mock.invocationCallOrder[0] as number,
		)
	})

	it('says so when the clipboard has no text, and sends nothing', async () => {
		paste('')
		await vi.runAllTimersAsync()

		expect(handlers.onPasteFailed).toHaveBeenCalledWith(expect.stringMatching(/no text/i))
		expect(rfb.clipboardPasteFrom).not.toHaveBeenCalled()
		expect(rfb.sendKey).not.toHaveBeenCalled()
	})

	it('sends Ctrl+C to the computer for Cmd+C, and never Cmd itself', () => {
		press({ key: 'Meta', code: 'MetaLeft', metaKey: true })
		press({ key: 'c', code: 'KeyC', metaKey: true })

		expect(reachedNoVnc).toEqual([])
		expect(sentKeys()).toEqual(ctrlC)
		expect(handlers.onCopyPressed).toHaveBeenCalledTimes(1)
	})

	it('lets Ctrl+C through to noVNC as it is, and marks the copy', () => {
		press({ key: 'c', code: 'KeyC', ctrlKey: true })

		expect(reachedNoVnc).toEqual(['c'])
		expect(rfb.sendKey).not.toHaveBeenCalled()
		expect(handlers.onCopyPressed).toHaveBeenCalledTimes(1)
	})

	it('leaves other keys alone, and keeps other Cmd shortcuts from typing a letter', () => {
		press({ key: 'a', code: 'KeyA' })
		press({ key: 'c', code: 'KeyC', ctrlKey: true, shiftKey: true })
		press({ key: 'a', code: 'KeyA', metaKey: true })

		expect(reachedNoVnc).toEqual(['a', 'c'])
		expect(handlers.onCopyPressed).not.toHaveBeenCalled()
		expect(rfb.sendKey).not.toHaveBeenCalled()
	})

	it('stops listening when detached', () => {
		detach()
		press({ key: 'v', code: 'KeyV', ctrlKey: true })
		const pasteEvent = paste('x')

		expect(reachedNoVnc).toEqual(['v'])
		expect(pasteEvent.defaultPrevented).toBe(false)
		expect(rfb.clipboardPasteFrom).not.toHaveBeenCalled()
	})
})
