import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// "Why are you holding it?": the reason is optional and goes on the timeline with the hold. The
/// reader can type it, say it (Dictate), pick a preset, or Skip and hold without one.
struct HoldReasonSheet: View {
	/// Who waits rather than guessing: the agent that asked.
	var agent: String?
	/// Called with the reason, or nil for Skip. The sheet dismisses itself afterwards.
	let commit: (String?) -> Void

	@State private var text = ""
	@State private var listening = false
	@FocusState private var focused: Bool
	@Environment(\.dismiss) private var dismiss

	private var reason: String? { HoldReason.normalized(text) }

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s0) {
				Text("Why are you holding it?")
					.maskinText(.sheetTitle).foregroundStyle(MaskinColor.ink)
					.accessibilityAddTraits(.isHeader)
				Text(HoldReason.subtitle(agent: agent))
					.maskinText(.body).foregroundStyle(MaskinColor.ink4)
					.padding(.top, MaskinSpace.s4)
				field.padding(.top, MaskinSpace.s8)
				VStack(spacing: MaskinSpace.s4) {
					ForEach(HoldReason.presets, id: \.self) { preset in
						Button {
							MaskinHaptics.play(.selection)
							text = preset
						} label: {
							Text(preset).maskinText(.body).foregroundStyle(MaskinColor.ink2)
								.multilineTextAlignment(.leading)
								.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin, alignment: .leading)
								.padding(.horizontal, MaskinSpace.s7)
								.background(
									MaskinSurface.card,
									in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
								.contentShape(Rectangle())
						}
						.buttonStyle(.maskinPressed)
					}
				}
				.padding(.top, MaskinSpace.s6)
				Button("Hold with this reason") { finish(reason) }
					.buttonStyle(.primaryAction)
					.disabled(reason == nil)
					.padding(.top, MaskinSpace.s8)
				Button("Skip") { finish(nil) }
					.maskinText(.body).fontWeight(.semibold)
					.foregroundStyle(MaskinColor.ink3)
					.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
					.buttonStyle(.maskinPressed)
					.accessibilityHint("Holds without a reason")
			}
			.padding(.horizontal, MaskinSpace.s10)
			.padding(.top, MaskinSpace.s10)
			.padding(.bottom, MaskinSpace.s12)
		}
		.ambientBackground()
		.scrollDismissesKeyboard(.interactively)
		.presentationDetents([.medium, .large])
		.presentationDragIndicator(.visible)
	}

	private var field: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			TextField("Not until\u{2026}", text: $text, axis: .vertical)
				.lineLimit(3...6)
				.maskinText(.body)
				.focused($focused)
				.frame(minHeight: MaskinSpace.touchMin * 1.5, alignment: .topLeading)
			HStack(spacing: MaskinSpace.s4) {
				DictationButton(text: $text, listening: $listening)
				Text("Say it out loud if that\u{2019}s faster")
					.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
				Spacer(minLength: 0)
			}
		}
		.padding(MaskinSpace.s7)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
	}

	private func finish(_ reason: String?) {
		MaskinHaptics.play(.success)
		commit(reason)
		dismiss()
	}
}
