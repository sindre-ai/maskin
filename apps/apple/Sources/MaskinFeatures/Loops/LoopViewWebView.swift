import MaskinCore
import SwiftUI

#if canImport(WebKit)
import WebKit

/// The web view behind a loop's custom view. It is never more open than the web app's sandboxed
/// frame, and in some ways tighter:
///
/// - The page carries the platform policy (`default-src 'none'`, `connect-src 'none'`, no forms, no
///   base URL) that its own scripts cannot loosen; see `MiniAppHTML.prepareView`.
/// - Navigation is ours alone. The one navigation allowed is the load this class starts. Link taps,
///   scripted `location` changes, form posts, `window.open` and every navigation of a child frame
///   are cancelled before a request is made, so a page cannot send what it read by going somewhere.
///   This replaces the web's nested isolation frame.
/// - Content rules refuse every `http`, `https`, `ws`, `wss` and `ftp` load as a third layer.
/// - Real-time connection constructors are removed from the page and every frame it makes.
/// - Nothing is remembered between loads (non-persistent data store), media never plays on its own,
///   camera and microphone are refused, and there is no link preview or phone-number detection.
/// - No credential enters the page. It talks to the host through one message handler and receives
///   answers as plain data.
@MainActor
final class LoopViewWebCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
	private let model: LoopCustomViewModel
	private weak var webView: WKWebView?
	private var loadedGeneration = -1
	/// Loads this class started and has not yet seen reach the navigation delegate.
	private var pendingLoads = 0
	private var rulesInstalled = false
	private var loading: Task<Void, Never>?

	init(model: LoopCustomViewModel) {
		self.model = model
	}

	// MARK: Setup

	func makeWebView() -> WKWebView {
		let configuration = WKWebViewConfiguration()
		// Nothing the page does is remembered, and it cannot open windows.
		configuration.websiteDataStore = .nonPersistent()
		configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
		configuration.mediaTypesRequiringUserActionForPlayback = .all
		#if os(iOS)
		configuration.dataDetectorTypes = []
		configuration.allowsAirPlayForMediaPlayback = false
		configuration.allowsPictureInPictureMediaPlayback = false
		#endif

		let controller = WKUserContentController()
		// Before the page's first script, in every frame it makes.
		controller.addUserScript(
			WKUserScript(
				source: LoopViewBridge.realtimeBlockScript, injectionTime: .atDocumentStart,
				forMainFrameOnly: false))
		// Only the page itself gets the bridge and the size reporter.
		controller.addUserScript(
			WKUserScript(
				source: LoopViewBridge.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
		controller.addUserScript(
			WKUserScript(
				source: LoopViewBridge.sizeScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
		controller.add(LoopViewScriptHandler(coordinator: self), name: LoopViewBridge.handlerName)
		configuration.userContentController = controller

		let view = WKWebView(frame: .zero, configuration: configuration)
		view.navigationDelegate = self
		view.uiDelegate = self
		#if os(iOS)
		view.allowsLinkPreview = false
		view.isOpaque = false
		view.backgroundColor = .clear
		view.scrollView.backgroundColor = .clear
		// The loop page scrolls, not the view inside it; the tab sizes the view to its content.
		view.scrollView.isScrollEnabled = false
		view.scrollView.bounces = false
		#endif
		webView = view
		return view
	}

	/// Loads the page again when the model says a new one is due.
	func sync(_ view: WKWebView, document: String, generation: Int) {
		webView = view
		guard generation != loadedGeneration else { return }
		loadedGeneration = generation
		loading?.cancel()
		loading = Task { [weak self, weak view] in
			await self?.installBlockRules(on: view)
			guard !Task.isCancelled, let self, let view, self.loadedGeneration == generation else { return }
			self.pendingLoads += 1
			view.loadHTMLString(document, baseURL: nil)
		}
	}

	private func installBlockRules(on view: WKWebView?) async {
		guard !rulesInstalled, let controller = view?.configuration.userContentController else { return }
		rulesInstalled = true
		let store: WKContentRuleListStore? = WKContentRuleListStore.default()
		if let list = try? await store?.compileContentRuleList(
			forIdentifier: "maskin-view-no-network", encodedContentRuleList: LoopViewBridge.blockNetworkRules)
		{
			controller.add(list)
		}
	}

	// MARK: The page's messages

	fileprivate func receive(_ message: WKScriptMessage) {
		// Only the page itself: a frame it made cannot talk to the host.
		guard message.frameInfo.isMainFrame, let parsed = LoopViewBridge.parse(message.body) else { return }
		switch parsed {
		case .size(let height, _, _):
			model.sizeChanged(height)
		case .query(let id, let name):
			let generation = loadedGeneration
			Task { [weak self] in
				guard let self else { return }
				let reply = await model.answer(name: name)
				// The page was replaced while the server was answering; nobody is waiting for it.
				guard generation == loadedGeneration, let webView else { return }
				deliver(reply, id: id, to: webView)
			}
		}
	}

	private func deliver(_ reply: LoopViewBridge.Reply, id: Int, to view: WKWebView) {
		let ok: Bool
		let payload: Any
		switch reply {
		case .data(let value):
			ok = true
			payload = value.foundationValue
		case .error(let message):
			ok = false
			payload = message
		}
		// Arguments go in as values, never spliced into the script text.
		view.callAsyncJavaScript(
			"window.__maskinReply(id, ok, payload)", arguments: ["id": id, "ok": ok, "payload": payload],
			in: nil, in: .page, completionHandler: nil)
	}

	// MARK: Navigation: ours only

	func webView(
		_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
		decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
	) {
		let url = navigationAction.request.url?.absoluteString ?? "about:blank"
		let ours =
			pendingLoads > 0 && navigationAction.targetFrame?.isMainFrame == true
			&& navigationAction.navigationType == .other && (url == "about:blank" || url.isEmpty)
		if ours { pendingLoads -= 1 }
		decisionHandler(ours ? .allow : .cancel)
	}

	func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
		model.reload()
	}

	// MARK: UI: nothing opens, nothing is asked for

	func webView(
		_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
		for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
	) -> WKWebView? { nil }

	func webView(
		_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
		initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
		decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void
	) {
		decisionHandler(.deny)
	}
}

/// Holds the coordinator weakly: a content controller keeps its handlers alive for good.
@MainActor
private final class LoopViewScriptHandler: NSObject, WKScriptMessageHandler {
	private weak var coordinator: LoopViewWebCoordinator?

	init(coordinator: LoopViewWebCoordinator) {
		self.coordinator = coordinator
	}

	func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
		coordinator?.receive(message)
	}
}

extension JSONValue {
	/// Plain Foundation values, for handing to a script as an argument.
	fileprivate var foundationValue: Any {
		switch self {
		case .null: NSNull()
		case .bool(let b): b
		case .number(let n): n
		case .string(let s): s
		case .array(let items): items.map(\.foundationValue)
		case .object(let entries): entries.mapValues(\.foundationValue)
		}
	}
}

#if canImport(UIKit)
struct LoopViewWebView: UIViewRepresentable {
	let model: LoopCustomViewModel
	let document: String
	let generation: Int

	func makeCoordinator() -> LoopViewWebCoordinator { LoopViewWebCoordinator(model: model) }

	func makeUIView(context: Context) -> WKWebView { context.coordinator.makeWebView() }

	func updateUIView(_ view: WKWebView, context: Context) {
		context.coordinator.sync(view, document: document, generation: generation)
	}
}
#else
struct LoopViewWebView: NSViewRepresentable {
	let model: LoopCustomViewModel
	let document: String
	let generation: Int

	func makeCoordinator() -> LoopViewWebCoordinator { LoopViewWebCoordinator(model: model) }

	func makeNSView(context: Context) -> WKWebView { context.coordinator.makeWebView() }

	func updateNSView(_ view: WKWebView, context: Context) {
		context.coordinator.sync(view, document: document, generation: generation)
	}
}
#endif
#else
/// tvOS ships no WebKit: say so instead of rendering the page.
struct LoopViewWebView: View {
	let model: LoopCustomViewModel
	let document: String
	let generation: Int

	var body: some View {
		Text("Open this view on iPhone, iPad or Mac.").foregroundStyle(.secondary)
	}
}
#endif
