import { copyFromDesktop, pasteToDesktop } from '@/lib/desktop-clipboard'
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
