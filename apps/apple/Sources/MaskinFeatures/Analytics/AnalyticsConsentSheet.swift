import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The one-time question before anything is sent: may Maskin see which features this phone uses.
/// Shown once, after sign-in, only in builds that can send. "No thanks" (or swiping it away) means
/// no, and Settings keeps the switch.
struct AnalyticsConsentSheet: View {
	var onShare: () -> Void
	var onNoThanks: () -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			Image(systemName: "chart.bar")
				.maskinSymbol(MaskinFontSize.t24, weight: .semibold)
				.foregroundStyle(MaskinColor.ink)
				.accessibilityHidden(true)
			Text("Help us make Maskin better")
				.maskinText(.largeTitle)
				.foregroundStyle(MaskinColor.ink)
				.fixedSize(horizontal: false, vertical: true)
				.accessibilityAddTraits(.isHeader)
			Text(AnalyticsCopy.explanation)
				.maskinText(.body)
				.foregroundStyle(MaskinColor.ink4)
				.fixedSize(horizontal: false, vertical: true)
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				Button("Share usage", action: onShare)
					.buttonStyle(.primaryAction)
				Button("No thanks", action: onNoThanks)
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

enum AnalyticsCopy {
	static let explanation =
		"Share which screens and features you use on this phone, and how often. It is tied to your account id, never your name, your email or anything you write. You can turn it off any time in Settings."
	static let settingsTitle = "Share product usage"
	static let settingsFooter =
		"Which screens and features you use on this phone. Never your name, your email or anything you write."
}
