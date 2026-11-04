import {
	DESKTOP_SCREEN_HEIGHT,
	DESKTOP_SCREEN_WIDTH,
	TEACH_MAX_DURATION_MS,
	TEACH_MAX_EVENTS,
	TEACH_MAX_FRAMES,
	type TeachEvent,
	type TeachRequest,
} from '@maskin/shared'

// Records a demonstration on the workspace desktop for "Teach a task". It never
// records video: it logs what the person does (clicks, typing, keys, scrolling)
// and takes a JPEG still of the desktop at the moment of each step, before the
// screen reacts. Everything stays in memory until the person stops and sends it.

const FRAME_QUALITY = 0.6
// Typing is one event until the person pauses this long (or does something else).
const TYPING_IDLE_MS = 1000
// A second press this soon and this close is a double click, not two clicks.
const DOUBLE_CLICK_MS = 400
const DOUBLE_CLICK_PX = 8
// Wheel events within this window in one direction are one scroll.
const SCROLL_MERGE_MS = 500
// Non-click steps don't take a new still more often than this.
const MIN_FRAME_GAP_MS = 400

const NAMED_KEYS: Record<string, string> = {
	Enter: 'Return',
	Escape: 'Escape',
	Tab: 'Tab',
	Backspace: 'BackSpace',
	Delete: 'Delete',
	Insert: 'Insert',
	ArrowUp: 'Up',
	ArrowDown: 'Down',
	ArrowLeft: 'Left',
	ArrowRight: 'Right',
	Home: 'Home',
	End: 'End',
	PageUp: 'Prior',
	PageDown: 'Next',
	' ': 'space',
}

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'OS'])

export type KeyInput = {
	key: string
	ctrlKey: boolean
	altKey: boolean
	metaKey: boolean
	shiftKey: boolean
}

export type MappedKey = { kind: 'text'; text: string } | { kind: 'key'; keys: string } | null

/**
 * Maps a browser key press to what the recording stores: typed text for plain
 * characters, an xdotool-style key (e.g. "ctrl+l", "Return") for shortcuts and
 * special keys, and nothing for a bare modifier.
 */
export function mapKeyPress(e: KeyInput): MappedKey {
	if (MODIFIER_KEYS.has(e.key)) return null
	const hasCommandMod = e.ctrlKey || e.altKey || e.metaKey

	// A printable character typed on its own (Shift only changes which one).
	if (e.key.length === 1 && !hasCommandMod && e.key !== ' ') return { kind: 'text', text: e.key }
	if (e.key === ' ' && !hasCommandMod) return { kind: 'text', text: ' ' }

	let name = NAMED_KEYS[e.key]
	if (!name) {
		if (/^F([1-9]|1[0-2])$/.test(e.key)) name = e.key
		else if (e.key.length === 1) name = e.key.toLowerCase()
		else if (/^[A-Za-z0-9_]+$/.test(e.key)) name = e.key
		else return null
	}
	if (!/^[A-Za-z0-9_]+$/.test(name)) return null

	const parts: string[] = []
	if (e.ctrlKey) parts.push('ctrl')
	if (e.altKey) parts.push('alt')
	if (e.metaKey) parts.push('super')
	// Shift only matters for non-character keys here ("shift+Tab"); for characters
	// it already changed the key.
	if (e.shiftKey && e.key.length !== 1) parts.push('shift')
	parts.push(name)
	return { kind: 'key', keys: parts.join('+') }
}

export type RecordedFrame = { id: string; t_ms: number; blob: Blob }

export type RecordedDemo = {
	duration_ms: number
	events: TeachEvent[]
	frames: RecordedFrame[]
	final_frame?: string
}

export type DesktopRecorderOptions = {
	/** The element noVNC mounted its canvas into. */
	target: HTMLElement
	/** Called when the maximum length is reached; the caller should stop(). */
	onAutoStop?: () => void
	/** Injectable for tests (jsdom has no canvas.toBlob). */
	captureFrame?: (canvas: HTMLCanvasElement) => Promise<Blob | null>
	now?: () => number
}

function defaultCapture(canvas: HTMLCanvasElement): Promise<Blob | null> {
	// toBlob snapshots the canvas when called, so the still shows the screen as it
	// was at the event, even though encoding finishes later.
	return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', FRAME_QUALITY))
}

export class DesktopRecorder {
	private readonly target: HTMLElement
	private readonly onAutoStop?: () => void
	private readonly capture: (canvas: HTMLCanvasElement) => Promise<Blob | null>
	private readonly now: () => number

	private startedAt = 0
	private running = false
	private events: TeachEvent[] = []
	private frames: Array<{ id: string; t_ms: number; blob: Promise<Blob | null> }> = []
	private lastFrameAt = Number.NEGATIVE_INFINITY
	private typing: { text: string; t_ms: number; frame?: string } | null = null
	private typingTimer: ReturnType<typeof setTimeout> | null = null
	private autoStopTimer: ReturnType<typeof setTimeout> | null = null

	constructor(opts: DesktopRecorderOptions) {
		this.target = opts.target
		this.onAutoStop = opts.onAutoStop
		this.capture = opts.captureFrame ?? defaultCapture
		this.now = opts.now ?? Date.now
	}

	get elapsedMs(): number {
		return this.running ? this.now() - this.startedAt : 0
	}

	get isRunning(): boolean {
		return this.running
	}

	start(): void {
		if (this.running) return
		this.running = true
		this.startedAt = this.now()
		this.target.addEventListener('pointerdown', this.onPointerDown, true)
		this.target.addEventListener('wheel', this.onWheel, { capture: true, passive: true })
		this.target.addEventListener('keydown', this.onKeyDown, true)
		this.autoStopTimer = setTimeout(() => this.onAutoStop?.(), TEACH_MAX_DURATION_MS)
	}

	/** Stops listening and resolves with everything captured. Safe to call twice. */
	async stop(): Promise<RecordedDemo> {
		if (this.running) {
			this.running = false
			this.target.removeEventListener('pointerdown', this.onPointerDown, true)
			this.target.removeEventListener('wheel', this.onWheel, true)
			this.target.removeEventListener('keydown', this.onKeyDown, true)
			if (this.autoStopTimer) clearTimeout(this.autoStopTimer)
		}
		this.flushTyping()
		const t = this.now() - this.startedAt
		const finalFrame = this.takeFrame(t, true)

		const resolved: RecordedFrame[] = []
		for (const f of this.frames) {
			const blob = await f.blob
			if (blob) resolved.push({ id: f.id, t_ms: f.t_ms, blob })
		}
		const have = new Set(resolved.map((f) => f.id))
		// A frame whose capture failed must not be referenced by an event.
		const events = this.events.map((e) =>
			e.frame && !have.has(e.frame) ? ({ ...e, frame: undefined } as TeachEvent) : e,
		)
		return {
			duration_ms: Math.min(t, TEACH_MAX_DURATION_MS + 60_000),
			events,
			frames: resolved,
			final_frame: finalFrame && have.has(finalFrame) ? finalFrame : undefined,
		}
	}

	// ── capture ────────────────────────────────────────────────────────────

	private canvas(): HTMLCanvasElement | null {
		return this.target.querySelector('canvas')
	}

	/** Takes a still now (synchronously snapshotting the canvas) and returns its id. */
	private takeFrame(t: number, force = false): string | undefined {
		const canvas = this.canvas()
		if (!canvas) return undefined
		if (this.frames.length >= TEACH_MAX_FRAMES) return undefined
		if (!force && t - this.lastFrameAt < MIN_FRAME_GAP_MS) return undefined
		const id = `f${String(this.frames.length + 1).padStart(3, '0')}`
		this.lastFrameAt = t
		this.frames.push({ id, t_ms: t, blob: this.capture(canvas).catch(() => null) })
		return id
	}

	private push(event: TeachEvent): void {
		if (this.events.length < TEACH_MAX_EVENTS) this.events.push(event)
	}

	/** Pointer position in desktop pixels, or null if it fell outside the screen. */
	private toDesktop(clientX: number, clientY: number): { x: number; y: number } | null {
		const canvas = this.canvas()
		if (!canvas) return null
		const rect = canvas.getBoundingClientRect()
		if (rect.width === 0 || rect.height === 0) return null
		const x = Math.round(((clientX - rect.left) / rect.width) * DESKTOP_SCREEN_WIDTH)
		const y = Math.round(((clientY - rect.top) / rect.height) * DESKTOP_SCREEN_HEIGHT)
		if (x < 0 || y < 0 || x >= DESKTOP_SCREEN_WIDTH || y >= DESKTOP_SCREEN_HEIGHT) return null
		return { x, y }
	}

	// ── typing ─────────────────────────────────────────────────────────────

	private flushTyping(): void {
		if (this.typingTimer) clearTimeout(this.typingTimer)
		this.typingTimer = null
		if (!this.typing) return
		if (this.typing.text.length > 0) {
			this.push({
				type: 'type',
				t_ms: this.typing.t_ms,
				text: this.typing.text.slice(0, 4000),
				frame: this.typing.frame,
			})
		}
		this.typing = null
	}

	private addTyped(text: string, t: number): void {
		if (!this.typing) this.typing = { text: '', t_ms: t, frame: this.takeFrame(t) }
		this.typing.text += text
		if (this.typingTimer) clearTimeout(this.typingTimer)
		this.typingTimer = setTimeout(() => this.flushTyping(), TYPING_IDLE_MS)
	}

	// ── listeners ──────────────────────────────────────────────────────────

	private readonly onPointerDown = (e: PointerEvent): void => {
		const pos = this.toDesktop(e.clientX, e.clientY)
		if (!pos) return
		const t = this.now() - this.startedAt
		this.flushTyping()
		const button = e.button === 2 ? 'right' : e.button === 1 ? 'middle' : 'left'

		const prev = this.events[this.events.length - 1]
		if (
			prev &&
			prev.type === 'click' &&
			prev.button === button &&
			!prev.double &&
			t - prev.t_ms <= DOUBLE_CLICK_MS &&
			Math.hypot(prev.x - pos.x, prev.y - pos.y) <= DOUBLE_CLICK_PX
		) {
			prev.double = true
			return
		}
		this.push({
			type: 'click',
			t_ms: t,
			...pos,
			button,
			double: false,
			frame: this.takeFrame(t, true),
		})
	}

	private readonly onWheel = (e: WheelEvent): void => {
		const pos = this.toDesktop(e.clientX, e.clientY)
		if (!pos || e.deltaY === 0) return
		const t = this.now() - this.startedAt
		const direction = e.deltaY < 0 ? 'up' : 'down'
		const ticks = Math.max(1, Math.round(Math.abs(e.deltaY) / 100))
		const prev = this.events[this.events.length - 1]
		if (
			prev &&
			prev.type === 'scroll' &&
			prev.direction === direction &&
			t - prev.t_ms <= SCROLL_MERGE_MS
		) {
			prev.amount = Math.min(200, prev.amount + ticks)
			prev.t_ms = t
			return
		}
		this.flushTyping()
		this.push({
			type: 'scroll',
			t_ms: t,
			direction,
			amount: Math.min(200, ticks),
			...pos,
			frame: this.takeFrame(t),
		})
	}

	private readonly onKeyDown = (e: KeyboardEvent): void => {
		const mapped = mapKeyPress(e)
		if (!mapped) return
		const t = this.now() - this.startedAt
		if (mapped.kind === 'text') {
			this.addTyped(mapped.text, t)
			return
		}
		// Backspace edits what is being typed instead of logging a stray key.
		if (mapped.keys === 'BackSpace' && this.typing && this.typing.text.length > 0) {
			this.typing.text = this.typing.text.slice(0, -1)
			return
		}
		this.flushTyping()
		this.push({ type: 'key', t_ms: t, keys: mapped.keys, frame: this.takeFrame(t, true) })
	}
}

/** Blob -> base64 without the `data:` prefix, as the teach API expects. */
export function blobToBase64(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader()
		reader.onerror = () => reject(reader.error ?? new Error('Could not read the screenshot'))
		reader.onload = () => {
			const url = String(reader.result)
			resolve(url.slice(url.indexOf(',') + 1))
		}
		reader.readAsDataURL(blob)
	})
}

/** Turns a finished recording into the request body for `POST /api/desktop/teach`. */
export async function buildTeachRequest(
	demo: RecordedDemo,
	input: { agentId: string; description: string },
): Promise<TeachRequest> {
	const frames = await Promise.all(
		demo.frames.map(async (f) => ({
			id: f.id,
			t_ms: f.t_ms,
			data_base64: await blobToBase64(f.blob),
		})),
	)
	return {
		agent_id: input.agentId,
		description: input.description.trim(),
		duration_ms: demo.duration_ms,
		events: demo.events,
		frames,
		final_frame: demo.final_frame,
	}
}
