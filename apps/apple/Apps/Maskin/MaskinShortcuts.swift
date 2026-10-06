import AppIntents
import MaskinCore

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
			intent: WhatNeedsMeIntent(),
			phrases: [
				"What needs me in \(.applicationName)",
				"What needs me on \(.applicationName)",
				"What's waiting on me in \(.applicationName)",
			],
			shortTitle: "What needs me?", systemImageName: "bell.badge")
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
