import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// What a tap on an object chip in a sentence shows: the card, an Open button and a Copy link
/// button, in a sheet the height of its content. Open closes the sheet, then opens the object.
struct LinkedChipSheet: View {
	/// Whether a chip tap shows this sheet. Turn it off and a tap opens the object straight away.
	static let tapShowsSheet = true

	let object: LinkedObject
	/// The web address Copy link puts on the pasteboard.
	let webURL: URL

	@Environment(\.dismiss) private var dismiss
	@Environment(\.dynamicTypeSize) private var typeSize
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var copied: Bool
	/// The height of the content, which is the sheet's detent. A first guess until it is measured.
	@State private var contentHeight: CGFloat = 320
	@AccessibilityFocusState private var openFocused: Bool

	init(object: LinkedObject, webURL: URL, copied: Bool = false) {
		self.object = object
		self.webURL = webURL
		_copied = State(initialValue: copied)
	}

	private static let buttonHeight: CGFloat = 48

	var body: some View {
		Group {
			if typeSize.isAccessibilitySize {
				ScrollView { content }
			} else {
				content
			}
		}
		.presentationDetents(typeSize.isAccessibilitySize ? [.large] : [.height(contentHeight)])
		.presentationDragIndicator(.visible)
		.accessibilityElement(children: .contain)
		.accessibilityLabel("Object preview")
		.accessibilityAction(.escape) { dismiss() }
		.onAppear { openFocused = true }
	}

	private var content: some View {
		VStack(spacing: MaskinSpace.s7) {
			HStack {
				Spacer(minLength: 0)
				Button { dismiss() } label: {
					Image(systemName: "xmark")
						.maskinSymbol(MaskinFontSize.t14, weight: .semibold)
						.foregroundStyle(MaskinColor.ink3)
						.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
						.contentShape(Rectangle())
				}
				.buttonStyle(.maskinPressed)
				.accessibilityLabel("Close")
			}
			LinkedObjectCard(object: object, preview: true)
			VStack(spacing: MaskinSpace.s5) {
				openButton
				copyButton
			}
		}
		.padding(.horizontal, MaskinSpace.s9)
		.padding(.bottom, MaskinSpace.s9)
		.onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { contentHeight = $0 }
	}

	private var openButton: some View {
		Button {
			LinkedOpener.openAfterClosing(object.target, close: { dismiss() }, runtime: runtime)
		} label: {
			Text("Open")
				.maskinText(.body).fontWeight(.semibold)
				.foregroundStyle(MaskinSurface.onInverse)
				.frame(maxWidth: .infinity, minHeight: Self.buttonHeight)
				.background(MaskinColor.ink, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
				.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityFocused($openFocused)
	}

	private var copyButton: some View {
		Button(action: copyLink) {
			Label(copied ? "Copied" : "Copy link", systemImage: copied ? "checkmark" : "link")
				.maskinText(.body).fontWeight(.semibold)
				.foregroundStyle(MaskinColor.ink)
				.frame(maxWidth: .infinity, minHeight: Self.buttonHeight)
				.overlay(
					RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
						.strokeBorder(MaskinSurface.line, lineWidth: 1)
				)
				.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
	}

	private func copyLink() {
		MarkdownClipboard.copy(webURL.absoluteString)
		MaskinHaptics.play(.selection)
		copied = true
		Task {
			try? await Task.sleep(for: .seconds(1.6))
			copied = false
		}
	}
}

extension LinkedItemStores {
	/// The sheet a chip tap shows, for an object the store has already read. Nil for anything else
	/// (an address that is not an object, one still loading, a draft), so the tap opens it as before.
	static func chipPreview(for url: URL, environment: AppEnvironment) -> AnyView? {
		guard LinkedChipSheet.tapShowsSheet, let link = DeepLink(url: url), case .object = link,
			let target = LinkedTarget.parse(href: url.absoluteString), let store = store(for: environment),
			case .object(let object)? = store.item(for: target)
		else { return nil }
		return AnyView(LinkedChipSheet(object: object, webURL: link.universalURL()).environment(\.linkedItems, store))
	}
}
