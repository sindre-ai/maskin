import MaskinDesign
import SwiftUI

/// The prose under the greeting title on For you (v3): a grey paragraph saying how many decisions
/// wait on the reader and, when it is true, how many they have answered and who carries on. The
/// title is the greeting itself, so there is no date line. With nothing sourceable the view shows
/// nothing rather than an invented line.
struct ForYouHeaderView: View {
	let summary: String?

	var body: some View {
		if let summary {
			Text(summary)
				.font(MaskinTypeface.sans(MaskinFontSize.t17))
				.lineSpacing(MaskinSpace.s2)
				.foregroundStyle(MaskinColor.ink4)
				.fixedSize(horizontal: false, vertical: true)
				.frame(maxWidth: .infinity, alignment: .leading)
		}
	}
}
