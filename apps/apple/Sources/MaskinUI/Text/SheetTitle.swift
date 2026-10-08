import MaskinDesign
import SwiftUI

/// The title of a bottom sheet: 24 / 750 with an optional 14pt `ink4` subtitle, left-aligned over the
/// ambient wash. Sheets show it in place of the small inline navigation title.
public struct SheetTitle: View {
	private let title: String
	private let subtitle: String?

	public init(_ title: String, subtitle: String? = nil) {
		self.title = title
		self.subtitle = subtitle
	}

	public var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s1) {
			Text(title)
				.maskinText(.sheetTitle)
				.foregroundStyle(MaskinColor.ink)
				.accessibilityAddTraits(.isHeader)
			if let subtitle {
				Text(subtitle).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(.horizontal, MaskinSpace.s9)
		.padding(.bottom, MaskinSpace.s4)
	}
}

extension View {
	/// Pins a `SheetTitle` above this sheet's content, under the toolbar.
	public func sheetTitle(_ title: String, subtitle: String? = nil) -> some View {
		safeAreaInset(edge: .top, spacing: 0) { SheetTitle(title, subtitle: subtitle) }
	}
}
