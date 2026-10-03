import SwiftUI

/// Keyboard shortcuts and menu-bar commands for iPad (hold ⌘ for the shortcut sheet) and Mac.
/// The focused scene's `AppRuntime` is published by `MainShell` via `.focusedSceneValue`.
public struct ShellCommands: Commands {
	@FocusedValue(\.appRuntime) private var runtime

	/// Tabs reachable by ⌘1…⌘n, in order. Search has its own ⌘K.
	static let shortcutTabs: [ShellTab] = ShellTab.allCases.filter { $0 != .search }

	public init() {}

	public var body: some Commands {
		CommandMenu("Go") {
			ForEach(Array(Self.shortcutTabs.enumerated()), id: \.element) {
				index, tab in
				Button(tab.title) { runtime?.selectedTab = tab }
					.keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
					.disabled(runtime == nil)
			}
			Divider()
			Button("Search") { runtime?.focusSearch() }
				.keyboardShortcut("k", modifiers: .command)
				.disabled(runtime == nil)
			Button("Notifications") { runtime?.showNotifications = true }
				.keyboardShortcut("i", modifiers: [.command, .shift])
				.disabled(runtime == nil)
		}
	}
}

extension AppRuntime {
	/// Search is a tab where the system gives it one (iOS 26+, Mac); otherwise a sheet.
	fileprivate func focusSearch() {
		if ShellTab.searchIsTab { selectedTab = .search } else { showSearch = true }
	}
}

private struct AppRuntimeKey: FocusedValueKey {
	typealias Value = AppRuntime
}

extension FocusedValues {
	var appRuntime: AppRuntime? {
		get { self[AppRuntimeKey.self] }
		set { self[AppRuntimeKey.self] = newValue }
	}
}
