import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

extension View {
	/// Gives the screen its large, collapsing title and the profile avatar, which opens the profile
	/// sheet (account, workspace, Agents, Files, Settings, sign out). Where search isn't a tab (below
	/// iOS 26) it also adds a search button. Apply to a screen's root content, inside its
	/// `NavigationStack`, and don't also set `.navigationTitle` on it.
	public func shellToolbar(environment: AppEnvironment, title: String? = nil) -> some View {
		modifier(ShellToolbarModifier(environment: environment, title: title))
	}
}

private struct ShellToolbarModifier: ViewModifier {
	let environment: AppEnvironment
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
				if let runtime, let session = environment.auth.session {
					ToolbarItem(placement: .primaryAction) {
						Button {
							runtime.showProfile = true
						} label: {
							ActorAvatar(name: session.name, kind: .human, size: MaskinSpace.s14)
						}
						.accessibilityLabel("Profile")
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
				.toolbarTitleDisplayMode(title == nil ? .inline : .inlineLarge)
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
