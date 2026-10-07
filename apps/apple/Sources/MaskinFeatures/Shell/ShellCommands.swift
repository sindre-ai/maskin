import MaskinCore
import SwiftUI

/// Keyboard shortcuts and menu-bar commands for iPad (hold ⌘ for the shortcut sheet) and Mac.
/// The focused scene's `AppRuntime` is published by `MainShell` via `.focusedSceneValue`.
public struct ShellCommands: Commands {
	@FocusedValue(\.appRuntime) private var runtime

	/// Tabs reachable by ⌘1…⌘n, in order. Search has its own ⌘K.
	static let shortcutTabs: [ShellTab] = ShellTab.primary

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
		}
	}
}

extension AppRuntime {
	/// Search is the trailing tab everywhere.
	fileprivate func focusSearch() { selectedTab = .search }
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
