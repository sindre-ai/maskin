import MaskinCore
import MaskinDesign
import SwiftUI

/// What a screen puts in the floating pill at the top right, besides its title.
///
///     .shellToolbar(
///         environment: environment, title: "Objects",
///         actions: ShellActions(
///             new: { showCreate = true },
///             display: ShellDisplayMenu {
///                 Picker("Sort", selection: $sort) { ... }
///                 Toggle("Show done", isOn: $showDone)
///             }))
///
/// Order in the pill is Live, New, Search, Display. While the content is scrolled New and Search
/// fold away (Display stays). Search shows only where search is not already a tab
/// (`ShellTab.searchIsTab`); pass `search: false` for a screen that has none.
public struct ShellActions {
	/// The "+" button (New / New conversation). Nil hides it.
	public var new: (() -> Void)?
	/// The dark Live button that opens the daily briefing with the Chief of Staff (For you only).
	public var live: Bool
	/// The magnifier, on screens where search is a button rather than a tab.
	public var search: Bool
	/// The filter-icon menu. Nil hides it.
	public var display: ShellDisplayMenu?

	public init(
		new: (() -> Void)? = nil, live: Bool = false, search: Bool = true,
		display: ShellDisplayMenu? = nil
	) {
		self.new = new
		self.live = live
		self.search = search
		self.display = display
	}
}

/// The content of a screen's Display menu: pickers, toggles, sub-menus and buttons, exactly as in
/// any SwiftUI `Menu`. Type-erased so a screen can hand it to the shell.
public struct ShellDisplayMenu {
	let content: AnyView

	public init<Content: View>(@ViewBuilder _ content: () -> Content) {
		self.content = AnyView(content())
	}
}

extension View {
	/// Gives the screen its large, collapsing title and its pill of actions.
	/// Where search isn't a tab (below iOS 26, and on iPhone) it adds a search button. Account,
	/// workspace, settings and sign-out live on the More tab, not here. Apply to a screen's root
	/// content, inside its `NavigationStack`, and don't also set `.navigationTitle` on it.
	public func shellToolbar(
		environment: AppEnvironment, title: String? = nil, actions: ShellActions = ShellActions()
	) -> some View {
		modifier(ShellToolbarModifier(title: title, actions: actions))
	}
}

private struct ShellToolbarModifier: ViewModifier {
	var title: String?
	var actions: ShellActions
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@Environment(\.liveMeeting) private var liveMeeting
	/// True once the content has scrolled away from the top: New and Search fold away.
	@State private var scrolled = false

	private var showsSearch: Bool { actions.search && !ShellTab.searchIsTab && runtime != nil }

	func body(content: Content) -> some View {
		content
			.shellTitle(title)
			.trackScrolled($scrolled)
			.toolbar {
				ToolbarItemGroup(placement: .primaryAction) {
					if actions.live {
						Button {
							liveMeeting.present(.dailyBriefing)
						} label: {
							Label("Live briefing", systemImage: "waveform")
						}
						.shellLiveButton()
					}
					if let new = actions.new, !scrolled {
						Button(action: new) { Label("New", systemImage: "plus") }
							.keyboardShortcut("n", modifiers: .command)
					}
					if showsSearch, !scrolled {
						Button {
							runtime?.showSearch = true
						} label: {
							Label("Search", systemImage: "magnifyingglass")
						}
					}
					if let display = actions.display {
						Menu {
							display.content
						} label: {
							Label("Display", systemImage: "line.3.horizontal.decrease")
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

extension View {
	/// Reports whether the screen's scroll view has moved away from its top.
	fileprivate func trackScrolled(_ scrolled: Binding<Bool>) -> some View {
		if #available(iOS 18, macOS 15, *) {
			return AnyView(
				onScrollGeometryChange(for: Bool.self) { geometry in
					geometry.contentOffset.y + geometry.contentInsets.top > MaskinSpace.s14
				} action: { _, isScrolled in
					withAnimation(MaskinMotion.quick) { scrolled.wrappedValue = isScrolled }
				})
		}
		return AnyView(self)
	}

	/// The dark, prominent Live button of the pill (glass on iOS 26).
	func shellLiveButton() -> some View {
		if #available(iOS 26, macOS 26, *) {
			return AnyView(buttonStyle(.glassProminent).tint(MaskinSurface.inverse))
		}
		return AnyView(buttonStyle(.borderedProminent).tint(MaskinSurface.inverse))
	}
}
