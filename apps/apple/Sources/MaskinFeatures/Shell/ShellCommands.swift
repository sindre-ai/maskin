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
			Button("New conversation") { runtime?.startNewConversation() }
				.keyboardShortcut("n", modifiers: .command)
				.disabled(runtime == nil)
			Button("Accept recommended option") { runtime?.acceptRecommendedOnSelection() }
				.keyboardShortcut(.return, modifiers: [])
				.disabled(runtime?.canAcceptRecommended != true)
		}
	}
}

extension AppRuntime {
	/// Search is the trailing tab everywhere.
	fileprivate func focusSearch() { selectedTab = .search }

	/// ⌘N: land on Team and open its new-conversation sheet.
	fileprivate func startNewConversation() {
		selectedTab = .chats
		newConversationRequested = true
	}

	/// The card selected in For you's detail column, when it is a decision with a recommended option
	/// that can be taken back. An option that can't be undone keeps its on-card confirmation, so
	/// Return never takes it.
	private var recommendedOnSelection: (option: DecisionOption, entry: FeedEntry)? {
		guard selectedTab == .forYou, let id = forYouSelection,
			let entry = forYou.store.entries.first(where: { $0.id == id }), entry.record == nil,
			let option = entry.card.decision?.recommended, !option.destructive
		else { return nil }
		return (option, entry)
	}

	fileprivate var canAcceptRecommended: Bool { recommendedOnSelection != nil }

	fileprivate func acceptRecommendedOnSelection() {
		guard let pick = recommendedOnSelection else { return }
		forYou.store.choose(pick.option, on: pick.entry.card)
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
