import MaskinCore
import MaskinDesign
import SwiftUI

extension View {
	/// Gives the screen its large, collapsing title.
	/// Where search isn't a tab (below iOS 26) it also adds a search button. Account, workspace,
	/// settings and sign-out live on the More tab, not here. Apply to a screen's root content,
	/// inside its `NavigationStack`, and don't also set `.navigationTitle` on it.
	public func shellToolbar(environment: AppEnvironment, title: String? = nil) -> some View {
		modifier(ShellToolbarModifier(title: title))
	}
}

private struct ShellToolbarModifier: ViewModifier {
	var title: String?
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	func body(content: Content) -> some View {
		content
			.shellTitle(title)
			.toolbar {
				if let runtime, !ShellTab.searchIsTab {
					ToolbarItem(placement: .primaryAction) {
						Button {
							runtime.showSearch = true
						} label: {
							Label("Search", systemImage: "magnifyingglass")
						}
					}
				}
			}
	}
}

extension View {
	/// The screen title as the system's large title: it sits above the content and collapses into
	/// the bar as the person scrolls (Apple's pattern for a tab's root screen). macOS keeps the
	/// system title.
	fileprivate func shellTitle(_ title: String?) -> some View {
		#if os(iOS)
			return self
				.navigationTitle(title ?? "")
				.navigationBarTitleDisplayMode(title == nil ? .inline : .large)
		#else
			return navigationTitle(title ?? "")
		#endif
	}

	/// iOS 26: search collapses to a toolbar icon that expands into the field when tapped.
	/// A regular search field elsewhere.
	func searchMinimized() -> some View {
		#if os(iOS)
			if #available(iOS 26, *) {
				return AnyView(searchToolbarBehavior(.minimize))
			}
		#endif
		return AnyView(self)
	}
}

extension ToolbarItemPlacement {
	static var shellLeading: ToolbarItemPlacement {
		#if os(iOS)
			.topBarLeading
		#else
			.navigation
		#endif
	}
}

/// The screen title, in the style every tab shares.
struct ShellTitleText: View {
	let text: String

	var body: some View {
		Text(text)
			.maskinText(.title)
			.foregroundStyle(MaskinColor.ink)
			.lineLimit(1)
			// A title is never truncated to make room for the buttons beside it.
			.fixedSize(horizontal: true, vertical: false)
			.accessibilityAddTraits(.isHeader)
	}
}

extension ToolbarContent {
	/// iOS 26 wraps toolbar items in a glass capsule; a title shouldn't look like a button.
	func hidingSharedBackground() -> some ToolbarContent {
		if #available(iOS 26, macOS 26, *) {
			return self.sharedBackgroundVisibility(.hidden)
		}
		return self
	}
}
