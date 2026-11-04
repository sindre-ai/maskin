// Plain-text clipboard hand-off between the person's browser and the agent's
// computer (noVNC). Text only: no images or files.

/** The slice of the noVNC client these helpers use. */
export interface ClipboardRfb {
	clipboardPasteFrom: (text: string) => void
	sendKey: (keysym: number, code: string | null, down?: boolean) => void
	focus: () => void
}

export type ClipboardResult = { ok: true } | { ok: false; message: string }

const BLOCKED = 'Your browser blocked clipboard access. Allow it for this site and try again.'

const XK_CONTROL_L = 0xffe3
const XK_V = 0x76

// x11vnc takes the text in asynchronously; Ctrl+V sent at once would paste the old clipboard.
const REMOTE_SETTLE_MS = 150

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
	if (!text) return { ok: false, message: 'Your clipboard has no text to paste.' }

	rfb.clipboardPasteFrom(text)
	await new Promise((resolve) => setTimeout(resolve, REMOTE_SETTLE_MS))
	rfb.sendKey(XK_CONTROL_L, 'ControlLeft', true)
	rfb.sendKey(XK_V, 'KeyV', true)
	rfb.sendKey(XK_V, 'KeyV', false)
	rfb.sendKey(XK_CONTROL_L, 'ControlLeft', false)
	rfb.focus()
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
