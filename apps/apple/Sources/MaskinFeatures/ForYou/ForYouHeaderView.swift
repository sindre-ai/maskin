import MaskinDesign
import SwiftUI

/// The date and the one sentence on the top of For you, under the system's large "For you" title
/// (a system title cannot have a line above it, so the date sits beneath it). The sentence says what
/// is blocked on the reader; with nothing sourceable it is left out and only the date shows.
struct ForYouHeaderView: View {
	let dateLine: String
	let spokenDate: String
	let summary: String?

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			Text(dateLine)
				.font(MaskinTypeface.mono(MaskinFontSize.t12, weight: .semibold)).tracking(0.96)
				.foregroundStyle(MaskinColor.ink5)
			if let summary {
				Text(summary)
					.font(MaskinTypeface.sans(MaskinFontSize.t15))
					.foregroundStyle(MaskinColor.ink3)
					.fixedSize(horizontal: false, vertical: true)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel([spokenDate, summary].compactMap { $0 }.joined(separator: ". "))
	}
}
