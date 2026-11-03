import MaskinDesign
import SwiftUI

/// The sentence under the greeting title on For you (v19): how many decisions wait on the reader.
/// The title is the greeting itself, so there is no date line. With nothing sourceable the view
/// shows nothing rather than an invented line.
struct ForYouHeaderView: View {
	let summary: String?

	var body: some View {
		if let summary {
			Text(summary)
				.font(MaskinTypeface.sans(MaskinFontSize.t17, weight: .semibold))
				.foregroundStyle(MaskinColor.ink)
				.fixedSize(horizontal: false, vertical: true)
				.frame(maxWidth: .infinity, alignment: .leading)
		}
	}
}
