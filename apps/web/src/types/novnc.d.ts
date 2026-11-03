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
		addEventListener(
			type: 'connect' | 'disconnect' | 'credentialsrequired' | 'securityfailure',
			listener: (event: CustomEvent) => void,
		): void
	}
}
