/** jsdom has no HTMLDialogElement.showModal/close. A modal dialog is exposed to
 *  role queries only while open, so the stand-ins toggle the open attribute and
 *  fire close, which is what the browser does. Focus trapping and Escape are the
 *  browser's: tests drive Escape by dispatching the cancel event. */
export function installDialogPolyfill() {
	const proto = HTMLDialogElement.prototype
	proto.showModal = function showModal(this: HTMLDialogElement) {
		this.setAttribute('open', '')
	}
	proto.close = function close(this: HTMLDialogElement) {
		this.removeAttribute('open')
		this.dispatchEvent(new Event('close'))
	}
}
