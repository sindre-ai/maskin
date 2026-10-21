import {
	DesktopRecorder,
	type KeyInput,
	blobToBase64,
	buildTeachRequest,
	mapKeyPress,
} from '@/lib/desktop-recorder'
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({
	key: k,
	ctrlKey: false,
	altKey: false,
	metaKey: false,
	shiftKey: false,
	...mods,
})

describe('mapKeyPress', () => {
	it('treats plain characters (and space) as typed text', () => {
		expect(mapKeyPress(key('a'))).toEqual({ kind: 'text', text: 'a' })
		expect(mapKeyPress(key('A', { shiftKey: true }))).toEqual({ kind: 'text', text: 'A' })
		expect(mapKeyPress(key(' '))).toEqual({ kind: 'text', text: ' ' })
		expect(mapKeyPress(key('@', { shiftKey: true }))).toEqual({ kind: 'text', text: '@' })
	})

	it('maps special keys to xdotool names', () => {
		expect(mapKeyPress(key('Enter'))).toEqual({ kind: 'key', keys: 'Return' })
		expect(mapKeyPress(key('Escape'))).toEqual({ kind: 'key', keys: 'Escape' })
		expect(mapKeyPress(key('ArrowDown'))).toEqual({ kind: 'key', keys: 'Down' })
		expect(mapKeyPress(key('PageUp'))).toEqual({ kind: 'key', keys: 'Prior' })
		expect(mapKeyPress(key('F5'))).toEqual({ kind: 'key', keys: 'F5' })
	})

	it('builds shortcuts with modifiers in a fixed order', () => {
		expect(mapKeyPress(key('l', { ctrlKey: true }))).toEqual({ kind: 'key', keys: 'ctrl+l' })
		expect(mapKeyPress(key('t', { ctrlKey: true, shiftKey: true }))).toEqual({
			kind: 'key',
			keys: 'ctrl+t',
		})
		expect(mapKeyPress(key('Tab', { altKey: true }))).toEqual({ kind: 'key', keys: 'alt+Tab' })
		expect(mapKeyPress(key('Tab', { shiftKey: true }))).toEqual({ kind: 'key', keys: 'shift+Tab' })
		expect(mapKeyPress(key(' ', { ctrlKey: true }))).toEqual({ kind: 'key', keys: 'ctrl+space' })
	})

	it('ignores bare modifier presses and keys it cannot name safely', () => {
		expect(mapKeyPress(key('Shift', { shiftKey: true }))).toBeNull()
		expect(mapKeyPress(key('Control', { ctrlKey: true }))).toBeNull()
		expect(mapKeyPress(key('Dead'))).not.toEqual({ kind: 'key', keys: 'Dead; rm' })
		expect(mapKeyPress(key('+', { ctrlKey: true }))).toBeNull()
	})

	it('only ever produces names the API accepts', () => {
		const accepted = /^[A-Za-z0-9_]+(\+[A-Za-z0-9_]+)*$/
		for (const k of ['Enter', 'Tab', 'a', 'ArrowLeft', 'F12', 'Home', 'x']) {
			const m = mapKeyPress(key(k, { ctrlKey: true, altKey: true, shiftKey: true }))
			if (m?.kind === 'key') expect(m.keys).toMatch(accepted)
		}
	})
})

// ── recorder ─────────────────────────────────────────────────────────────

let now = 0
const jpeg = () =>
	new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])], { type: 'image/jpeg' })

function setup(
	captureFrame: Mock<() => Promise<Blob | null>> = vi.fn<() => Promise<Blob | null>>(async () =>
		jpeg(),
	),
) {
	const target = document.createElement('div')
	const canvas = document.createElement('canvas')
	// Displayed at half size: a 640x360 box standing in for the 1280x720 desktop.
	canvas.getBoundingClientRect = () =>
		({
			left: 100,
			top: 50,
			width: 640,
			height: 360,
			right: 740,
			bottom: 410,
			x: 100,
			y: 50,
		}) as DOMRect
	target.appendChild(canvas)
	document.body.appendChild(target)
	const onAutoStop = vi.fn()
	const recorder = new DesktopRecorder({ target, captureFrame, onAutoStop, now: () => now })
	return { target, canvas, recorder, captureFrame, onAutoStop }
}

const press = (el: Element, init: MouseEventInit & { button?: number } = {}) =>
	el.dispatchEvent(
		new MouseEvent('pointerdown', { bubbles: true, clientX: 420, clientY: 230, ...init }),
	)
const keydown = (el: Element, k: string, init: KeyboardEventInit = {}) =>
	el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init }))

describe('DesktopRecorder', () => {
	beforeEach(() => {
		now = 1_000
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
		document.body.innerHTML = ''
	})

	it('records a click in desktop pixels with a still taken at that moment', async () => {
		const { canvas, recorder, captureFrame } = setup()
		recorder.start()
		now += 1500

		press(canvas) // (420-100)/640 -> 0.5 of 1280 = 640, (230-50)/360 -> 0.5 of 720 = 360

		const demo = await recorder.stop()
		expect(demo.events).toHaveLength(1)
		expect(demo.events[0]).toMatchObject({
			type: 'click',
			x: 640,
			y: 360,
			button: 'left',
			double: false,
			t_ms: 1500,
			frame: 'f001',
		})
		expect(demo.frames[0]?.id).toBe('f001')
		// One still for the click, one for the end of the demonstration.
		expect(captureFrame).toHaveBeenCalledTimes(2)
		expect(demo.final_frame).toBe('f002')
	})

	it('maps the right and middle buttons', async () => {
		const { canvas, recorder } = setup()
		recorder.start()
		now += 1000
		press(canvas, { button: 2 })
		now += 1000
		press(canvas, { button: 1 })

		const { events } = await recorder.stop()
		expect(events.map((e) => (e.type === 'click' ? e.button : null))).toEqual(['right', 'middle'])
	})

	it('folds a quick second press in the same place into a double click', async () => {
		const { canvas, recorder } = setup()
		recorder.start()
		now += 1000
		press(canvas)
		now += 150
		press(canvas, { clientX: 422 })

		const { events } = await recorder.stop()
		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({ type: 'click', double: true })
	})

	it('keeps two slow clicks as two clicks', async () => {
		const { canvas, recorder } = setup()
		recorder.start()
		now += 1000
		press(canvas)
		now += 900
		press(canvas)

		expect((await recorder.stop()).events).toHaveLength(2)
	})

	it('ignores presses that fall outside the desktop', async () => {
		const { canvas, recorder } = setup()
		recorder.start()
		press(canvas, { clientX: 50, clientY: 230 })
		press(canvas, { clientX: 420, clientY: 900 })

		expect((await recorder.stop()).events).toHaveLength(0)
	})

	it('joins typing into one event, honouring backspace, and flushes on a pause', async () => {
		const { canvas, recorder } = setup()
		recorder.start()
		now += 1000
		for (const k of ['h', 'e', 'l', 'x', 'Backspace', 'l', 'o']) keydown(canvas, k)
		now += 3000
		vi.advanceTimersByTime(1100) // typing idle timer

		const demo = await recorder.stop()
		expect(demo.events).toEqual([
			expect.objectContaining({ type: 'type', text: 'hello', frame: 'f001' }),
		])
	})

	it('records shortcuts and special keys as key events, ending any typing first', async () => {
		const { canvas, recorder } = setup()
		recorder.start()
		now += 1000
		keydown(canvas, 'a')
		now += 100
		keydown(canvas, 'l', { ctrlKey: true })
		now += 600
		keydown(canvas, 'Enter')

		const { events } = await recorder.stop()
		expect(
			events.map((e) => (e.type === 'type' ? `type:${e.text}` : e.type === 'key' ? e.keys : '?')),
		).toEqual(['type:a', 'ctrl+l', 'Return'])
	})

	it('treats Backspace with nothing typed as a key', async () => {
		const { canvas, recorder } = setup()
		recorder.start()
		now += 1000
		keydown(canvas, 'Backspace')

		expect((await recorder.stop()).events[0]).toMatchObject({ type: 'key', keys: 'BackSpace' })
	})

	it('merges wheel ticks in one direction into a single scroll', async () => {
		const { canvas, recorder } = setup()
		recorder.start()
		now += 1000
		const wheel = (deltaY: number) =>
			canvas.dispatchEvent(
				new WheelEvent('wheel', { bubbles: true, clientX: 420, clientY: 230, deltaY }),
			)
		wheel(100)
		now += 100
		wheel(100)
		now += 100
		wheel(100)
		now += 1000
		wheel(-100) // other direction, later: its own event

		const { events } = await recorder.stop()
		expect(events).toHaveLength(2)
		expect(events[0]).toMatchObject({ type: 'scroll', direction: 'down', amount: 3 })
		expect(events[1]).toMatchObject({ type: 'scroll', direction: 'up', amount: 1 })
	})

	it('stops capturing stills at the cap but keeps logging steps', async () => {
		const { canvas, recorder, captureFrame } = setup()
		recorder.start()
		for (let i = 0; i < 70; i++) {
			now += 1000
			press(canvas, { clientX: 150 + i * 3 })
		}

		const demo = await recorder.stop()
		expect(demo.events).toHaveLength(70)
		expect(demo.frames.length).toBeLessThanOrEqual(60)
		expect(captureFrame.mock.calls.length).toBeLessThanOrEqual(60)
		expect(demo.events.filter((e) => e.frame).length).toBeLessThanOrEqual(60)
		expect(demo.events.some((e) => e.frame === undefined)).toBe(true)
	})

	it('drops the reference to a still whose capture failed', async () => {
		const captureFrame = vi.fn(async () => null)
		const { canvas, recorder } = setup(captureFrame)
		recorder.start()
		now += 1000
		press(canvas)

		const demo = await recorder.stop()
		expect(demo.frames).toHaveLength(0)
		expect(demo.events[0]?.frame).toBeUndefined()
		expect(demo.final_frame).toBeUndefined()
	})

	it('stops listening after stop() and is safe to stop twice', async () => {
		const { canvas, recorder } = setup()
		recorder.start()
		await recorder.stop()
		press(canvas)

		const again = await recorder.stop()
		expect(again.events).toHaveLength(0)
		expect(recorder.isRunning).toBe(false)
	})

	it('asks to be stopped when the maximum length is reached', () => {
		const { recorder, onAutoStop } = setup()
		recorder.start()

		vi.advanceTimersByTime(10 * 60 * 1000 + 10)

		expect(onAutoStop).toHaveBeenCalledTimes(1)
	})
})

describe('buildTeachRequest', () => {
	it('encodes stills as bare base64 and trims the description', async () => {
		const req = await buildTeachRequest(
			{
				duration_ms: 5000,
				events: [
					{ type: 'click', t_ms: 10, x: 1, y: 2, button: 'left', double: false, frame: 'f001' },
				],
				frames: [{ id: 'f001', t_ms: 10, blob: jpeg() }],
				final_frame: 'f001',
			},
			{ agentId: 'agent-1', description: '  export the report  ' },
		)

		expect(req).toMatchObject({
			agent_id: 'agent-1',
			description: 'export the report',
			duration_ms: 5000,
			final_frame: 'f001',
		})
		expect(req.frames[0]?.data_base64).toBe(
			Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString('base64'),
		)
		expect(req.frames[0]?.data_base64).not.toContain('data:')
	})

	it('blobToBase64 round-trips', async () => {
		const b64 = await blobToBase64(new Blob(['hello']))
		expect(Buffer.from(b64, 'base64').toString()).toBe('hello')
	})
})
