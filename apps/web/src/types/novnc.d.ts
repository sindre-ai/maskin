// @novnc/novnc ships no types. Only the surface the desktop viewer uses.
declare module '@novnc/novnc/lib/rfb' {
	export interface RfbOptions {
		credentials?: { username?: string; password?: string; target?: string }
		shared?: boolean
	}

	export default class RFB {
		constructor(target: HTMLElement, urlOrChannel: string, options?: RfbOptions)
		viewOnly: boolean
		scaleViewport: boolean
		resizeSession: boolean
		focusOnClick: boolean
		background: string
		disconnect(): void
		focus(): void
		/** Sends text to the remote's clipboard (VNC "client cut text"). */
		clipboardPasteFrom(text: string): void
		sendKey(keysym: number, code: string | null, down?: boolean): void
		sendKey(keysym: number, code: string | null, down?: boolean): void
		addEventListener(
			type: 'connect' | 'disconnect' | 'credentialsrequired' | 'securityfailure',
			listener: (event: CustomEvent) => void,
		): void
		/** Fires when the remote's clipboard changes; `detail.text` is the new text. */
		addEventListener(
			type: 'clipboard',
			listener: (event: CustomEvent<{ text: string }>) => void,
		): void
	}
}
