import MaskinDesign
import SwiftUI

/// A draft preview, read-only, clamped to four lines. "Read all" opens the rest in place; there is
/// no editing here (editing a draft means Ask). "Read all" appears only when the text is cut.
struct ReadAllClamp<Content: View>: View {
	static var lineLimit: Int { 4 }

	/// Builds the text with the given line limit (nil: no limit).
	@ViewBuilder let content: (Int?) -> Content

	@State private var expanded = false
	@State private var fullHeight: CGFloat = 0
	@State private var clampedHeight: CGFloat = 0

	private var isCut: Bool { fullHeight > clampedHeight + 1 }

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			content(expanded ? nil : Self.lineLimit)
				.background(
					GeometryReader { proxy in
						Color.clear.preference(key: ClampedHeightKey.self, value: proxy.size.height)
					}
				)
				.onPreferenceChange(ClampedHeightKey.self) { if !expanded { clampedHeight = $0 } }
				.background(
					content(nil)
						.fixedSize(horizontal: false, vertical: true)
						.hidden()
						.background(
							GeometryReader { proxy in
								Color.clear.preference(key: FullHeightKey.self, value: proxy.size.height)
							}
						)
						.accessibilityHidden(true)
				)
				.onPreferenceChange(FullHeightKey.self) { fullHeight = $0 }
			if isCut || expanded {
				Button(expanded ? "Show less" : "Read all") {
					withAnimation(MaskinMotion.standard) { expanded.toggle() }
				}
				.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: MaskinFontWeight.w650))
				.foregroundStyle(MaskinColor.ink3)
				.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
				.buttonStyle(.maskinPressed)
			}
		}
	}
}

private struct ClampedHeightKey: PreferenceKey {
	static let defaultValue: CGFloat = 0
	static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct FullHeightKey: PreferenceKey {
	static let defaultValue: CGFloat = 0
	static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}
