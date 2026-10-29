#if os(iOS)
import MaskinCore
import SwiftUI
import UIKit
import WebKit

/// Where typed keys go: the page in the web view. Held weakly so the screen owns nothing extra.
@MainActor
final class ComputerPageBridge {
	weak var webView: WKWebView?

	func sendText(_ text: String) {
		webView?.evaluateJavaScript("maskinComputer.sendText(\(ComputerJS.literal(text)))")
	}

	func sendSpecial(_ name: String) {
		webView?.evaluateJavaScript("maskinComputer.sendSpecial(\(ComputerJS.literal(name)))")
	}
}

enum ComputerJS {
	/// A string as a JavaScript literal, so nothing in it can break out of the call.
	static func literal(_ value: String) -> String {
		(try? JSONEncoder().encode(value)).flatMap { String(data: $0, encoding: .utf8) } ?? "\"\""
	}
}

/// The bundled noVNC page in a locked-down web view. It is not the web app: no cookies, no
/// navigation, no network fetch of code. Swift hands it the stream address and password and it
/// reports connect and disconnect back.
struct ComputerWebView: UIViewRepresentable {
	let stream: ComputerStream?
	let controlling: Bool
	let bridge: ComputerPageBridge
	let onEvent: (ComputerPageEvent) -> Void

	func makeCoordinator() -> Coordinator { Coordinator() }

	func makeUIView(context: Context) -> WKWebView {
		let configuration = WKWebViewConfiguration()
		// Nothing the page does is remembered.
		configuration.websiteDataStore = .nonPersistent()
		configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
		configuration.userContentController.add(context.coordinator, name: "computer")
		let view = WKWebView(frame: .zero, configuration: configuration)
		view.navigationDelegate = context.coordinator
		view.isOpaque = false
		view.backgroundColor = .clear
		view.scrollView.isScrollEnabled = false
		view.scrollView.bounces = false
		view.scrollView.contentInsetAdjustmentBehavior = .never
		context.coordinator.webView = view
		bridge.webView = view
		if let page = Bundle.module.url(forResource: "computer", withExtension: "html", subdirectory: "Resources") {
			view.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
		}
		return view
	}

	func updateUIView(_ view: WKWebView, context: Context) {
		let coordinator = context.coordinator
		coordinator.onEvent = onEvent
		coordinator.stream = stream
		coordinator.controlling = controlling
		coordinator.flush()
	}

	static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
		view.evaluateJavaScript("maskinComputer.disconnect()")
		view.configuration.userContentController.removeScriptMessageHandler(forName: "computer")
	}

	final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
		weak var webView: WKWebView?
		var onEvent: (ComputerPageEvent) -> Void = { _ in }
		var stream: ComputerStream?
		var controlling = false
		private var ready = false
		private var appliedStream: UUID?
		private var appliedControlling = false

		func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
			guard let body = message.body as? [String: Any], let name = body["event"] as? String else { return }
			if name == "ready" {
				ready = true
				flush()
			} else if let event = ComputerPageEvent(name: name) {
				onEvent(event)
			}
		}

		/// Only the bundled page itself may load: no link, redirect or script navigation.
		func webView(
			_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
			decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
		) {
			let local = navigationAction.request.url?.isFileURL == true && navigationAction.navigationType == .other
			decisionHandler(local ? .allow : .cancel)
		}

		/// Brings the page in line with what the model wants: a new stream is a new connection,
		/// and a missing one closes it. Waits until the page says it is ready.
		@MainActor func flush() {
			guard ready, let webView else { return }
			if appliedStream != stream?.id {
				appliedStream = stream?.id
				appliedControlling = false
				if let stream {
					webView.evaluateJavaScript(
						"maskinComputer.connect(\(ComputerJS.literal(stream.url.absoluteString)), \(ComputerJS.literal(stream.password)))")
				} else {
					webView.evaluateJavaScript("maskinComputer.disconnect()")
				}
			}
			if appliedControlling != controlling {
				appliedControlling = controlling
				webView.evaluateJavaScript("maskinComputer.setControlling(\(controlling))")
			}
		}
	}
}

/// A zero-size responder that raises the system keyboard and forwards what is typed. The web view
/// cannot raise the keyboard from script, so the keys are caught here and sent to the page.
final class ComputerKeyCatcherView: UIView, UIKeyInput {
	var onText: (String) -> Void = { _ in }
	var onReturn: () -> Void = {}
	var onDelete: () -> Void = {}

	override var canBecomeFirstResponder: Bool { true }
	var hasText: Bool { true }
	var autocorrectionType: UITextAutocorrectionType = .no
	var autocapitalizationType: UITextAutocapitalizationType = .none
	var spellCheckingType: UITextSpellCheckingType = .no
	var smartQuotesType: UITextSmartQuotesType = .no
	var smartDashesType: UITextSmartDashesType = .no

	func insertText(_ text: String) {
		if text == "\n" { onReturn() } else { onText(text) }
	}

	func deleteBackward() { onDelete() }
}

struct ComputerKeyCatcher: UIViewRepresentable {
	/// On while the person is in control; off hides the keyboard.
	let active: Bool
	/// Changes each time the person asks for the keyboard.
	let requests: Int
	let bridge: ComputerPageBridge

	func makeCoordinator() -> Coordinator { Coordinator() }

	func makeUIView(context: Context) -> ComputerKeyCatcherView { ComputerKeyCatcherView() }

	func updateUIView(_ view: ComputerKeyCatcherView, context: Context) {
		view.onText = { [bridge] in bridge.sendText($0) }
		view.onReturn = { [bridge] in bridge.sendSpecial("return") }
		view.onDelete = { [bridge] in bridge.sendSpecial("backspace") }
		guard active else {
			view.resignFirstResponder()
			context.coordinator.seen = requests
			return
		}
		if context.coordinator.seen != requests {
			context.coordinator.seen = requests
			view.becomeFirstResponder()
		}
	}

	final class Coordinator {
		var seen = 0
	}
}
#endif
