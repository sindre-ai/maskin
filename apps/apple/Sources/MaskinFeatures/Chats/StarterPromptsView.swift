import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The agent's own one-tap openers (the web's `StarterPrompts`), as chips above the message box. A
/// tap puts the prompt in the box after anything already typed, never replacing it, and focuses the
/// box, so the person can still change the words before sending; nothing is sent until they send.
/// Renders nothing for an agent with none.
struct StarterPromptsView: View {
	let prompts: [String]
	let onPick: (String) -> Void

	var body: some View {
		if !prompts.isEmpty {
			FlowLayout(spacing: MaskinSpace.s4, alignment: .leading) {
				ForEach(prompts, id: \.self) { prompt in
					Button {
						MaskinHaptics.play(.light)
						onPick(prompt)
					} label: {
						Text(prompt)
							.maskinText(.subhead).fontWeight(.medium).foregroundStyle(MaskinColor.ink)
							.multilineTextAlignment(.leading)
							.padding(.horizontal, MaskinSpace.s6)
							.frame(minHeight: MaskinSpace.touchMin)
							.background(MaskinSurface.card, in: Capsule())
							.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1))
							.contentShape(Capsule())
					}
					.buttonStyle(.maskinPressed(.shrink))
					.accessibilityHint("Adds it to the message box")
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			.accessibilityElement(children: .contain)
		}
	}
}
