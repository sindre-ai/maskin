import MaskinDesign
import SwiftUI

/// One labelled input on the auth screens: label above, a filled well, an optional trailing
/// control, and a hint line below that carries the problem (danger) or the standing help (muted).
struct AuthField<Input: View, Trailing: View>: View {
	let label: String
	var help: String?
	var problem: String?
	var isFocused: Bool
	@ViewBuilder var input: Input
	@ViewBuilder var trailing: Trailing

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.gapSnug) {
			Text(label)
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.ink3)

			HStack(spacing: MaskinSpace.gapDefault) {
				input
					.maskinText(.body)
					.foregroundStyle(MaskinColor.ink)
				trailing
			}
			.padding(.horizontal, MaskinSpace.s8)
			.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s3)
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.inputLg, style: .continuous))
			.overlay(
				RoundedRectangle(cornerRadius: MaskinRadius.inputLg, style: .continuous)
					.strokeBorder(borderColor, lineWidth: isFocused || problem != nil ? 1.5 : 1)
			)

			if let problem {
				Label {
					Text(problem)
				} icon: {
					Image(systemName: "exclamationmark.circle.fill")
				}
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.danger)
				.transition(.opacity)
			} else if let help {
				Text(help)
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink4)
			}
		}
		.accessibilityElement(children: .contain)
	}

	private var borderColor: Color {
		if problem != nil { return MaskinColor.danger }
		return isFocused ? MaskinColor.ink : MaskinSurface.line
	}
}

extension AuthField where Trailing == EmptyView {
	init(
		label: String, help: String? = nil, problem: String? = nil, isFocused: Bool,
		@ViewBuilder input: () -> Input
	) {
		self.init(
			label: label, help: help, problem: problem, isFocused: isFocused, input: input,
			trailing: { EmptyView() })
	}
}

/// Two-option switch between "Sign in" and "Create account". Drawn here (not a UIKit segmented
/// control) so it renders the same everywhere and in snapshots; each segment is a button that
/// reports itself selected to VoiceOver.
struct AuthModeSwitch: View {
	let selection: AuthScreenModel.Mode
	let onSelect: (AuthScreenModel.Mode) -> Void

	var body: some View {
		HStack(spacing: MaskinSpace.s1) {
			ForEach(AuthScreenModel.Mode.allCases, id: \.self) { mode in
				let selected = mode == selection
				Button { onSelect(mode) } label: {
					Text(mode.title)
						.maskinText(.subhead)
						.fontWeight(selected ? .semibold : .medium)
						.foregroundStyle(selected ? MaskinColor.ink : MaskinColor.ink4)
						.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin - MaskinSpace.s4)
						.background {
							if selected {
								RoundedRectangle(cornerRadius: MaskinRadius.btn, style: .continuous)
									.fill(MaskinSurface.card)
									.overlay(
										RoundedRectangle(cornerRadius: MaskinRadius.btn, style: .continuous)
											.strokeBorder(MaskinSurface.line, lineWidth: 1))
							}
						}
						.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
				.accessibilityAddTraits(selected ? .isSelected : [])
			}
		}
		.padding(MaskinSpace.s1)
		.background(MaskinColor.surfaceAlt, in: RoundedRectangle(cornerRadius: MaskinRadius.btnLg + MaskinSpace.s1, style: .continuous))
		.accessibilityElement(children: .contain)
	}
}
