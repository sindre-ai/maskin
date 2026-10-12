import AppIntents
import MaskinCore

/// Lets the TV app discover the intents that live in MaskinCore, the same ones the iPhone offers.
struct MaskinTVIntentsPackage: AppIntentsPackage {
	static var includedPackages: [any AppIntentsPackage.Type] { [MaskinIntentsPackage.self] }
}

/// "Hey Siri, what needs me?" on Apple TV (6-TV.md). The intents mirror the iPhone's; the overnight
/// brief opens the app on For you, where the briefing carousel is. Each phrase names the app.
struct MaskinTVShortcuts: AppShortcutsProvider {
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
			intent: OvernightBriefIntent(),
			phrases: [
				"Overnight brief in \(.applicationName)",
				"What did the agents do overnight in \(.applicationName)",
			],
			shortTitle: "Overnight brief", systemImageName: "moon.stars")
	}
}
