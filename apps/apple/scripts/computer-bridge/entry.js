// Bridge between the Swift host and noVNC. Swift calls window.maskinComputer.connect(...) and
// setControlling(...); this page reports back through the "computer" message handler.
import RFBModule from '@novnc/novnc/lib/rfb'

const RFB = RFBModule?.default ? RFBModule.default : RFBModule
const screen = document.getElementById('screen')
let rfb = null

function post(event, detail) {
	try {
		window.webkit.messageHandlers.computer.postMessage({ event, detail: detail || null })
	} catch (_) {}
}

function teardown() {
	if (!rfb) return
	const old = rfb
	rfb = null
	try {
		old.disconnect()
	} catch (_) {}
}

const BACKSPACE = 0xff08
const RETURN = 0xff0d
function keysymFor(ch) {
	const cp = ch.codePointAt(0)
	return cp < 0x100 ? cp : 0x01000000 + cp
}

window.maskinComputer = {
	// ticket, password and url come from Swift and are never logged here.
	connect(url, password) {
		teardown()
		const mine = new RFB(screen, url, { credentials: { password } })
		rfb = mine
		mine.scaleViewport = true
		mine.resizeSession = false
		mine.viewOnly = true
		mine.addEventListener('connect', () => {
			if (rfb === mine) post('connect')
		})
		// An old connection closing after a newer one started must not touch the new one.
		mine.addEventListener('disconnect', () => {
			if (rfb !== mine) return
			rfb = null
			post('disconnect')
		})
	},
	setControlling(on) {
		if (!rfb) return
		rfb.viewOnly = !on
	},
	// Typed on the native keyboard (the web view cannot raise it from script), sent key by key.
	sendText(text) {
		if (!rfb) return
		for (const ch of text) rfb.sendKey(keysymFor(ch))
	},
	sendSpecial(name) {
		if (!rfb) return
		rfb.sendKey(name === 'backspace' ? BACKSPACE : RETURN)
	},
	disconnect() {
		teardown()
	},
}
post('ready')
