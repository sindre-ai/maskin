import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The in-app explanation shown before the system's notification prompt, once the person has seen
/// an agent ask them something. "Not now" (or swiping it away) is remembered for a week.
struct NotificationPromptSheet: View {
	var onTurnOn: () -> Void
	var onNotNow: () -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			Image(systemName: "bell.badge")
				.maskinSymbol(MaskinFontSize.t24, weight: .semibold)
				.foregroundStyle(MaskinColor.ink)
				.accessibilityHidden(true)
			Text("Get told when an agent needs a decision")
				.maskinText(.largeTitle)
				.foregroundStyle(MaskinColor.ink)
				.fixedSize(horizontal: false, vertical: true)
				.accessibilityAddTraits(.isHeader)
			Text("Agents do the work and stop when a call is yours to make. A notification means one is waiting. You choose which kinds in Settings, and quiet hours keep the rest for the morning.")
				.maskinText(.body)
				.foregroundStyle(MaskinColor.ink4)
				.fixedSize(horizontal: false, vertical: true)
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				Button("Turn on notifications", action: onTurnOn)
					.buttonStyle(.primaryAction)
				Button("Not now", action: onNotNow)
					.buttonStyle(.maskinPressed)
					.maskinText(.subhead)
					.fontWeight(.semibold)
					.foregroundStyle(MaskinColor.ink3)
					.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
			}
			.padding(.top, MaskinSpace.s5)
		}
		.padding(.horizontal, MaskinSpace.s12)
		.padding(.vertical, MaskinSpace.s12)
		.frame(maxWidth: 480)
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
		.ambientBackground()
		.presentationDetents([.medium, .large])
	}
}
