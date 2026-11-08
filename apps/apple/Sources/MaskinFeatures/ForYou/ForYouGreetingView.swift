import MaskinDesign
import SwiftUI

/// The greeting that heads For you: 34 pt bold, tight leading, at most two lines in a column about
/// 260 pt wide ("Good evening, Sebastian"). Nothing sits under it: no summary and no caption.
struct ForYouGreetingView: View {
	let text: String

	/// The widest the greeting runs before it wraps.
	static let maxWidth: CGFloat = 260

	var body: some View {
		Text(text)
			.font(MaskinTypeface.sans(MaskinFontSize.t34, weight: .bold, relativeTo: .largeTitle))
			.tracking(-0.04 * MaskinFontSize.t34)
			.lineSpacing(-MaskinSpace.s1)
			.lineLimit(2)
			.minimumScaleFactor(0.8)
			.foregroundStyle(MaskinColor.ink)
			.frame(maxWidth: Self.maxWidth, alignment: .leading)
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.top, MaskinSpace.s12)
			.accessibilityAddTraits(.isHeader)
	}
}
