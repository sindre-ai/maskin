import MaskinCore
import MaskinDesign
import SwiftUI

/// The agent's outbound draft inside a decision card, laid out as in v6: a label, a "To" row,
/// then the body clamped to four lines with "Read all". Read only on the phone: the first cut of
/// draft editing ships on the web, and Approve here sends the original, which the card says
/// (bet "Humans fix a LinkedIn post or email draft on the For You card"). When the server starts
/// returning the person's edit, it belongs on `DecisionDraft`, and this view shows the final text.
struct DraftPreview: View {
	let draft: DecisionDraft
	/// Says that Approve sends the draft as written. Off where the card has no Approve (the
	/// object's own screen shows the draft for reading only).
	var showsReadOnlyNote = true

	private var recipient: String? {
		draft.to?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
	}

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			Text(draft.label)
				.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: MaskinFontWeight.w650))
				.foregroundStyle(MaskinColor.ink4)
			if let recipient {
				VStack(alignment: .leading, spacing: MaskinSpace.s4) {
					HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s5) {
						Text("To")
							.font(MaskinTypeface.sans(MaskinFontSize.t14))
							.foregroundStyle(MaskinColor.ink5)
							.frame(width: 56, alignment: .leading)
						Text(recipient)
							.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: MaskinFontWeight.w650))
							.foregroundStyle(MaskinColor.ink)
							.frame(maxWidth: .infinity, alignment: .leading)
					}
					Rectangle().fill(MaskinSurface.separator).frame(height: 1)
				}
			}
			ReadAllClamp { limit in
				Text(draft.body)
					.font(MaskinTypeface.sans(MaskinFontSize.t15))
					.lineSpacing(MaskinSpace.s2)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(limit)
					.frame(maxWidth: .infinity, alignment: .leading)
			}
			if showsReadOnlyNote {
				Text("Approve sends this draft as written. To change it, use Discuss or edit it on the web.")
					.font(MaskinTypeface.sans(MaskinFontSize.t12))
					.foregroundStyle(MaskinColor.ink5)
					.frame(maxWidth: .infinity, alignment: .leading)
			}
		}
		.padding(MaskinSpace.s8)
		.frame(maxWidth: .infinity, alignment: .leading)
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.accessibilityElement(children: .contain)
	}
}

private extension String {
	var nonEmpty: String? { isEmpty ? nil : self }
}

/// "This can't be undone": the sheet an option that reaches real people or money asks through,
/// shown for options the agent marked `destructive`. Confirm is ink; Cancel is quiet.
struct ConfirmOptionSheet: View {
	let option: DecisionOption
	let confirm: () -> Void
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			Text("\(option.label)?").maskinText(.sheetTitle).foregroundStyle(MaskinColor.ink)
			VStack(alignment: .leading, spacing: MaskinSpace.s4) {
				Text("This can\u{2019}t be undone.")
					.maskinText(.body).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
				ForEach(option.consequences, id: \.self) {
					Text($0).maskinText(.body).foregroundStyle(MaskinColor.ink3)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			Spacer(minLength: 0)
			Button {
				dismiss()
				confirm()
			} label: {
				Text("Confirm")
					.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .bold))
					.foregroundStyle(MaskinSurface.onInverse)
					.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin + MaskinSpace.s4)
					.background(MaskinSurface.inverse, in: Capsule())
			}
			.buttonStyle(.maskinPressed(.shrink))
			Button("Cancel") { dismiss() }
				.maskinText(.body).foregroundStyle(MaskinColor.ink4)
				.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
		}
		.padding(MaskinSpace.s11)
		.presentationDetents([.medium])
		.presentationDragIndicator(.visible)
		.ambientBackground(showsBottom: false)
	}
}
