import MaskinDesign
import SwiftUI

/// What the Edit sheet asks the description field for when Save is tapped. The rich editor lives in
/// a web view, so its text is read from the page; the plain box keeps it in the sheet's own state.
@MainActor
@Observable
final class DescriptionEditorHandle {
	/// Set while the rich editor is on screen, cleared when the plain box takes over.
	@ObservationIgnored var readMarkdown: (() async -> String?)?
	var isRich: Bool { readMarkdown != nil }
	/// True until the rich editor has opened (or the plain box has taken over), so Save cannot be
	/// tapped before the page holds the description. On iPhone it starts true; elsewhere there is
	/// no page to wait for.
	#if os(iOS)
		var isOpening = true
	#else
		var isOpening = false
	#endif
}

/// The description field of the Edit sheet. On iPhone it is the same editor the web app uses
/// (a bundled page, see scripts/editor-bridge); a description the editor cannot hold safely, or a
/// page that does not load, opens the plain markdown box instead. Elsewhere it is the plain box.
struct DescriptionEditor: View {
	@Binding var text: String
	let handle: DescriptionEditorHandle
	var placeholder = "Description"

	var body: some View {
		#if os(iOS)
			RichDescriptionEditor(text: $text, handle: handle, placeholder: placeholder)
		#else
			MarkdownEditor(text: $text, placeholder: placeholder)
		#endif
	}
}

#if os(iOS)
import UIKit
import WebKit

private struct RichDescriptionEditor: View {
	@Binding var text: String
	let handle: DescriptionEditorHandle
	let placeholder: String

	@Environment(\.colorScheme) private var colorScheme
	@Environment(\.dynamicTypeSize) private var typeSize
	@State private var phase = Phase.loading

	private enum Phase { case loading, ready, plain }

	/// How long the page gets to open before the plain box is used instead.
	private static let openTimeout: Duration = .seconds(5)

	var body: some View {
		switch phase {
		case .plain:
			MarkdownEditor(text: $text, placeholder: placeholder)
		case .loading, .ready:
			RichEditorWebView(
				markdown: text, placeholder: placeholder, dark: colorScheme == .dark, typeSize: typeSize,
				handle: handle,
				onEvent: { event in
					switch event {
					case .opened:
						phase = .ready
						handle.isOpening = false
					case .readOnly: usePlainBox()
					}
				}
			)
			.opacity(phase == .ready ? 1 : 0)
			.overlay { if phase == .loading { ProgressView() } }
			.task {
				try? await Task.sleep(for: Self.openTimeout)
				if phase == .loading { usePlainBox() }
			}
		}
	}

	/// The text was never changed by the page, so the plain box starts from exactly what was loaded.
	private func usePlainBox() {
		handle.readMarkdown = nil
		handle.isOpening = false
		phase = .plain
	}
}

enum RichEditorEvent {
	case opened
	case readOnly

	init?(name: String) {
		switch name {
		case "opened": self = .opened
		case "readOnly": self = .readOnly
		default: return nil
		}
	}
}

/// The bundled editor page in a locked-down web view. It is not the web app: no cookies, no
/// navigation, no network fetch of code. Swift hands it the description and reads the markdown back
/// on Save; the page tells Swift when it is open, or when it holds the text read-only.
private struct RichEditorWebView: UIViewRepresentable {
	let markdown: String
	let placeholder: String
	let dark: Bool
	let typeSize: DynamicTypeSize
	let handle: DescriptionEditorHandle
	let onEvent: (RichEditorEvent) -> Void

	func makeCoordinator() -> Coordinator { Coordinator() }

	func makeUIView(context: Context) -> WKWebView {
		let configuration = WKWebViewConfiguration()
		// Nothing the page does is remembered.
		configuration.websiteDataStore = .nonPersistent()
		configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
		configuration.userContentController.add(context.coordinator, name: "editor")
		let view = WKWebView(frame: .zero, configuration: configuration)
		view.navigationDelegate = context.coordinator
		view.isOpaque = false
		view.backgroundColor = .clear
		view.scrollView.backgroundColor = .clear
		view.scrollView.contentInsetAdjustmentBehavior = .never
		view.scrollView.keyboardDismissMode = .interactive
		context.coordinator.webView = view
		handle.readMarkdown = { [weak view] in
			guard let view else { return nil }
			return try? await view.evaluateJavaScript("maskinEditor.getMarkdown()") as? String
		}
		if let page = Bundle.module.url(forResource: "editor", withExtension: "html", subdirectory: "EditorPage") {
			view.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent())
		}
		return view
	}

	func updateUIView(_ view: WKWebView, context: Context) {
		let coordinator = context.coordinator
		coordinator.onEvent = onEvent
		coordinator.markdown = markdown
		coordinator.placeholder = placeholder
		coordinator.dark = dark
		coordinator.fontScale = UIFontMetrics(forTextStyle: .body).scaledValue(for: 16) / 16
		coordinator.flush()
	}

	static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
		view.configuration.userContentController.removeScriptMessageHandler(forName: "editor")
	}

	final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
		weak var webView: WKWebView?
		var onEvent: (RichEditorEvent) -> Void = { _ in }
		var markdown = ""
		var placeholder = ""
		var dark = false
		var fontScale = 1.0
		private var ready = false
		private var opened = false
		private var appliedAppearance: String?

		func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
			guard let body = message.body as? [String: Any], let name = body["event"] as? String else { return }
			if name == "ready" {
				ready = true
				flush()
			} else if let event = RichEditorEvent(name: name) {
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

		/// Brings the page in line with light or dark mode and the text size, and opens the
		/// description once (never again: the page owns the text from then on). Waits until the page
		/// says it is ready.
		@MainActor func flush() {
			guard ready, let webView else { return }
			let appearance = "\(dark) \(fontScale)"
			if appliedAppearance != appearance {
				appliedAppearance = appearance
				webView.evaluateJavaScript("maskinEditor.setAppearance(\(dark), \(fontScale))")
			}
			if !opened {
				opened = true
				webView.evaluateJavaScript(
					"maskinEditor.open(\(ComputerJS.literal(markdown)), \(ComputerJS.literal(placeholder)))")
			}
		}
	}
}
#endif
