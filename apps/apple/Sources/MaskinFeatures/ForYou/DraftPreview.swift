import MaskinCore
import MaskinDesign
import SwiftUI

/// The agent's outbound draft inside a decision card: a bordered box with its label, a "To" line
/// and the body clamped to four lines with "Read all". Read only; editing a draft means Ask.
struct DraftPreview: View {
	let draft: DecisionDraft

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			Text(draft.label.uppercased())
				.font(MaskinTypeface.mono(MaskinFontSize.t10, weight: .semibold))
				.maskinMonoLabelScale()
				.tracking(0.7)
				.foregroundStyle(MaskinColor.ink5)
			if let to = draft.to, !to.isEmpty {
				Text("To: \(to)")
					.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: MaskinFontWeight.semibold))
					.foregroundStyle(MaskinColor.ink3)
			}
			ReadAllClamp { limit in
				Text(draft.body)
					.font(MaskinTypeface.sans(MaskinFontSize.t14))
					.foregroundStyle(MaskinColor.ink3)
					.lineLimit(limit)
					.frame(maxWidth: .infinity, alignment: .leading)
			}
		}
		.padding(MaskinSpace.s7)
		.frame(maxWidth: .infinity, alignment: .leading)
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.accessibilityElement(children: .contain)
	}
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
