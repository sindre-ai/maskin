// Plain-text clipboard hand-off between the person's browser and the agent's
// computer (noVNC). Text only: no images or files.

/** The slice of the noVNC client these helpers use. */
export interface ClipboardRfb {
	clipboardPasteFrom: (text: string) => void
	sendKey: (keysym: number, code: string | null, down?: boolean) => void
	focus: () => void
}

export type ClipboardResult = { ok: true } | { ok: false; message: string }

const NO_TEXT = 'Your clipboard has no text to paste.'
const BLOCKED = 'Your browser blocked clipboard access. Allow it for this site and try again.'

const XK_CONTROL_L = 0xffe3
const XK_C = 0x63
const XK_V = 0x76

// x11vnc takes the text in asynchronously; Ctrl+V sent at once would paste the old clipboard.
const REMOTE_SETTLE_MS = 150

/** How long after Ctrl/Cmd+C the computer's clipboard is still taken as the answer to that key press. */
export const COPY_WINDOW_MS = 3000

/** Presses Ctrl+<key> on the computer. The computer is Linux, so this is Ctrl even when the person pressed Cmd. */
function pressCtrl(rfb: ClipboardRfb, keysym: number, code: string) {
	rfb.sendKey(XK_CONTROL_L, 'ControlLeft', true)
	rfb.sendKey(keysym, code, true)
	rfb.sendKey(keysym, code, false)
	rfb.sendKey(XK_CONTROL_L, 'ControlLeft', false)
}

/** Puts text on the computer's clipboard, then presses Ctrl+V there so it lands in the focused field. */
async function sendPaste(rfb: ClipboardRfb, text: string) {
	rfb.clipboardPasteFrom(text)
	await new Promise((resolve) => setTimeout(resolve, REMOTE_SETTLE_MS))
	pressCtrl(rfb, XK_V, 'KeyV')
	rfb.focus()
}

/**
 * Sends what is on the person's clipboard to the computer, then presses Ctrl+V
 * there so it lands in the focused field. (Terminals paste with Ctrl+Shift+V:
 * the text is on the computer's clipboard either way.) Reading needs a click.
 */
export async function pasteToDesktop(rfb: ClipboardRfb): Promise<ClipboardResult> {
	let text: string
	try {
		text = await navigator.clipboard.readText()
	} catch {
		return { ok: false, message: BLOCKED }
	}
	if (!text) return { ok: false, message: NO_TEXT }

	await sendPaste(rfb, text)
	return { ok: true }
}

/** Puts text the computer copied onto the person's clipboard. Writing needs a click. */
export async function copyFromDesktop(text: string): Promise<ClipboardResult> {
	try {
		await navigator.clipboard.writeText(text)
		return { ok: true }
	} catch {
		return { ok: false, message: BLOCKED }
	}
}

/** Remembers that the person just pressed copy, so the computer's next clipboard text is theirs to keep. */
export function createCopyArming(now: () => number = Date.now) {
	let armedUntil = 0
	return {
		arm() {
			armedUntil = now() + COPY_WINDOW_MS
		},
		disarm() {
			armedUntil = 0
		},
		/** True once per copy key press, and only within the window. */
		take() {
			if (now() > armedUntil) return false
			armedUntil = 0
			return true
		},
	}
}

/**
 * The computer sent its clipboard. If the person pressed copy a moment ago, writes it to their
 * clipboard and says how that went; null means this text was not theirs to take.
 */
export async function takeRemoteCopy(
	arming: ReturnType<typeof createCopyArming>,
	text: string,
): Promise<ClipboardResult | null> {
	if (!text || !arming.take()) return null
	return copyFromDesktop(text)
}

export interface ClipboardShortcutHandlers {
	/** The paste key press found nothing to paste. */
	onPasteFailed: (message: string) => void
	/** The person pressed copy: the computer's clipboard that arrives next is theirs to keep. */
	onCopyPressed: () => void
}

/**
 * Makes Ctrl/Cmd+V and Ctrl/Cmd+C work on the computer's picture. noVNC swallows every
 * key press on its canvas, which also stops the browser's paste event, so these keys are
 * caught first (capture phase) and kept from noVNC:
 * - V is only kept from noVNC. The browser then fires its paste event, which hands over
 *   the text without a permission prompt.
 * - C is sent as Ctrl+C. Ctrl+C on a PC already reaches the computer as it is; Cmd+C on
 *   a Mac is turned into Ctrl+C.
 * - Cmd (Meta) never reaches the computer: a raw Super+V would do nothing there.
 * Returns a function that removes the listeners.
 */
export function attachClipboardShortcuts(
	target: HTMLElement,
	getRfb: () => ClipboardRfb | null,
	handlers: ClipboardShortcutHandlers,
): () => void {
	function onKeyDown(e: KeyboardEvent) {
		if (e.key === 'Meta') {
			e.stopPropagation()
			return
		}
		const rfb = getRfb()
		if (!rfb) return
		const plain = !e.shiftKey && !e.altKey
		if (plain && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
			// Not preventDefault: that would cancel the paste event.
			e.stopPropagation()
			return
		}
		if (plain && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
			handlers.onCopyPressed()
			if (!e.metaKey) return
			e.stopPropagation()
			e.preventDefault()
			pressCtrl(rfb, XK_C, 'KeyC')
			return
		}
		// Any other Cmd shortcut would reach the computer as a plain letter.
		if (e.metaKey) e.stopPropagation()
	}

	function onPaste(e: ClipboardEvent) {
		const rfb = getRfb()
		if (!rfb) return
		e.preventDefault()
		const text = e.clipboardData?.getData('text/plain') ?? ''
		if (!text) {
			handlers.onPasteFailed(NO_TEXT)
			return
		}
		void sendPaste(rfb, text)
	}

	target.addEventListener('keydown', onKeyDown, true)
	target.addEventListener('paste', onPaste)
	return () => {
		target.removeEventListener('keydown', onKeyDown, true)
		target.removeEventListener('paste', onPaste)
	}
}
