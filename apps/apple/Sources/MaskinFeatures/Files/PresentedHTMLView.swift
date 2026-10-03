import MaskinCore
import SwiftUI
import WebKit

/// An HTML page rendered in the same locked-down web view the file viewer uses, with no review
/// pins on top: scripts run, the network and navigation don't. Used wherever a page is presented
/// rather than annotated (the Outcomes feed and its full-screen presenter).
struct PresentedHTMLView: View {
	let html: String
	var revision = 0
	/// A preview inside a card passes `false` so a tap opens the page instead of scrolling it.
	var isInteractive = true

	var body: some View {
		HTMLWebView(html: html, revision: revision, probe: nil)
			.allowsHitTesting(isInteractive)
	}
}

/// Shared by the iOS and macOS wrappers.
@MainActor
private func makeSandboxedWebView() -> WKWebView {
	let configuration = WKWebViewConfiguration()
	// Nothing the page does is remembered, and it cannot open windows.
	configuration.websiteDataStore = .nonPersistent()
	configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
	return WKWebView(frame: .zero, configuration: configuration)
}

/// Lets only the initial document load happen. Link taps, scripted navigation and form posts are
/// all refused, matching the web's `sandbox="allow-scripts"` frame (no top navigation).
final class HTMLWebCoordinator: NSObject, WKNavigationDelegate {
	var loadedRevision = -1

	func webView(
		_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
		decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
	) {
		let url = navigationAction.request.url?.absoluteString ?? "about:blank"
		let initial = navigationAction.navigationType == .other && (url == "about:blank" || url.isEmpty)
		decisionHandler(initial ? .allow : .cancel)
	}
}

#if canImport(UIKit)
struct HTMLWebView: UIViewRepresentable {
	let html: String
	let revision: Int
	let probe: HTMLProbe?

	func makeCoordinator() -> HTMLWebCoordinator { HTMLWebCoordinator() }

	func makeUIView(context: Context) -> WKWebView {
		let view = makeSandboxedWebView()
		view.navigationDelegate = context.coordinator
		view.isOpaque = false
		view.backgroundColor = .clear
		view.scrollView.backgroundColor = .clear
		probe?.webView = view
		return view
	}

	func updateUIView(_ view: WKWebView, context: Context) {
		probe?.webView = view
		guard context.coordinator.loadedRevision != revision else { return }
		context.coordinator.loadedRevision = revision
		view.loadHTMLString(MiniAppHTML.prepare(html), baseURL: nil)
	}
}
#else
struct HTMLWebView: NSViewRepresentable {
	let html: String
	let revision: Int
	let probe: HTMLProbe?

	func makeCoordinator() -> HTMLWebCoordinator { HTMLWebCoordinator() }

	func makeNSView(context: Context) -> WKWebView {
		let view = makeSandboxedWebView()
		view.navigationDelegate = context.coordinator
		probe?.webView = view
		return view
	}

	func updateNSView(_ view: WKWebView, context: Context) {
		probe?.webView = view
		guard context.coordinator.loadedRevision != revision else { return }
		context.coordinator.loadedRevision = revision
		view.loadHTMLString(MiniAppHTML.prepare(html), baseURL: nil)
	}
}
#endif
