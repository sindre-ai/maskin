import AppIntents
import MaskinCore
import MaskinDesign
import SwiftUI

/// Lets the app target discover the intents that live in MaskinCore (so they are shared with any
/// extension that links the same package instead of being copied).
struct MaskinAppIntentsPackage: AppIntentsPackage {
	static var includedPackages: [any AppIntentsPackage.Type] { [MaskinIntentsPackage.self] }
}

/// The phrases Siri, Spotlight and the Shortcuts app offer without any setup. Each phrase must
/// contain the app name.
struct MaskinShortcuts: AppShortcutsProvider {
	static var appShortcuts: [AppShortcut] {
		AppShortcut(
			intent: WhatNeedsMeSnippetIntent(),
			phrases: [
				"What needs me in \(.applicationName)",
				"What needs me on \(.applicationName)",
				"What's waiting on me in \(.applicationName)",
				"What's blocked on me in \(.applicationName)",
				"What's blocked on me on \(.applicationName)",
			],
			shortTitle: "What needs me?", systemImageName: "bell.badge")
		AppShortcut(
			intent: OvernightBriefIntent(),
			phrases: [
				"Overnight brief in \(.applicationName)",
				"What did the agents do overnight in \(.applicationName)",
				"My \(.applicationName) overnight brief",
			],
			shortTitle: "Overnight brief", systemImageName: "moon.stars")
		AppShortcut(
			intent: AskAgentIntent(),
			phrases: [
				"Ask \(\.$agent) in \(.applicationName)",
				"Message \(\.$agent) in \(.applicationName)",
				"Ask an agent in \(.applicationName)",
			],
			shortTitle: "Ask an agent", systemImageName: "bubble.left.and.text.bubble.right")
		AppShortcut(
			intent: RunAgentIntent(),
			phrases: [
				"Run \(\.$agent) in \(.applicationName)",
				"Start \(\.$agent) in \(.applicationName)",
			],
			shortTitle: "Run an agent", systemImageName: "play.circle")
		AppShortcut(
			intent: OpenAgentThreadIntent(),
			phrases: ["Open \(\.$agent) in \(.applicationName)"],
			shortTitle: "Open an agent's chat", systemImageName: "text.bubble")
	}
}

/// "What needs me in Maskin": the same answer as `WhatNeedsMeIntent` (Core), with the v3 snippet
/// under the spoken line: the count as a title and up to three decision titles. It lives in the
/// app target because the snippet is SwiftUI, which MaskinCore does not import.
struct WhatNeedsMeSnippetIntent: AppIntent {
	static let title: LocalizedStringResource = "What needs me?"
	static let description = IntentDescription(
		"Tells you how many decisions your agents are waiting on, and the most urgent ones.",
		categoryName: "For you")
	/// Decision titles are private: neither spoken nor shown on a locked device.
	static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

	func perform() async throws -> some IntentResult & ReturnsValue<String> & ProvidesDialog & ShowsSnippetView {
		let summary = await MaskinIntentsContext.whatNeedsMe()
		return .result(
			value: summary.detail, dialog: IntentDialog(stringLiteral: summary.spoken),
			view: NeedsMeSnippetView(summary: summary))
	}
}

/// The count as a title, then one row per decision and an Open link to the top one. Only what the
/// snapshot carries: no rows when nothing needs you, no Open when there is nowhere to go.
struct NeedsMeSnippetView: View {
	let summary: NeedsMeSummary

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			Text(summary.snippetTitle)
				.maskinText(.headline)
				.foregroundStyle(MaskinColor.ink)
			ForEach(Array(summary.titles.enumerated()), id: \.offset) { _, title in
				Text(title)
					.maskinText(.subhead)
					.foregroundStyle(MaskinColor.ink3)
					.lineLimit(1)
			}
			if summary.count > 0, let link = summary.link {
				Link(destination: link) {
					Text("Open")
						.maskinText(.caption)
						.foregroundStyle(MaskinSurface.onInverse)
						.padding(.horizontal, MaskinSpace.s9)
						.frame(minHeight: MaskinSpace.touchMin)
						.background(MaskinSurface.inverse, in: Capsule())
				}
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(MaskinSpace.s7)
	}
}
