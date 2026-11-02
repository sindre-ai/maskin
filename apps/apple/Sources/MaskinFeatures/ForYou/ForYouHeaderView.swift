import MaskinDesign
import SwiftUI

/// What sits under For you's large greeting ("Good evening, Sebastian"): one sentence that says how
/// many decisions wait, in ink, then who needs a call first, in a quieter ink. With no `lead` it
/// falls back to the older date line over the one-sentence summary. The recap chips of the
/// prototype ("the CTO ruled on Keychain") have no source in the store yet and are not drawn.
struct ForYouHeaderView: View {
	let dateLine: String
	let spokenDate: String
	let summary: String?
	/// "5 decisions are waiting on you."
	var lead: String?
	/// "Strategist needs a call: Pricing plan."
	var detail: String?

	var body: some View {
		Group {
			if let lead {
				leadSentence(lead)
			} else {
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
				.accessibilityElement(children: .ignore)
				.accessibilityLabel([spokenDate, summary].compactMap { $0 }.joined(separator: ". "))
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	private func leadSentence(_ lead: String) -> some View {
		let strong = Text(lead)
			.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: .semibold))
			.foregroundStyle(MaskinColor.ink)
		let rest = Text(detail.map { " " + $0 } ?? "")
			.font(MaskinTypeface.sans(MaskinFontSize.t16))
			.foregroundStyle(MaskinColor.ink3)
		return Text("\(strong)\(rest)")
			.lineSpacing(MaskinSpace.s2)
			.fixedSize(horizontal: false, vertical: true)
			.accessibilityElement(children: .ignore)
			.accessibilityLabel([lead, detail].compactMap { $0 }.joined(separator: " "))
	}
}
