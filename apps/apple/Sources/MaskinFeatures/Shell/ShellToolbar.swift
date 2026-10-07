import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// What a screen puts in the floating pill at the top right, besides its title and the profile
/// avatar (which every root screen gets).
///
///     .shellToolbar(
///         environment: environment, title: "Objects",
///         actions: ShellActions(
///             display: ShellDisplayMenu {
///                 Picker("Sort", selection: $sort) { ... }
///                 Toggle("Show done", isOn: $showDone)
///             }))
///
/// Order in the pill is Live, New, Display, then the avatar in a capsule of its own. The per-tab
/// sets are `ShellTab.barItems`. While the content is scrolled New folds away (Live, Display and the
/// avatar stay). Search is never a bar item: it is the trailing search tab.
public struct ShellActions {
	/// The "+" button (Team: New conversation). Nil hides it.
	public var new: (() -> Void)?
	/// The "+" button's accessibility label.
	public var newLabel: String
	/// The dark Live button that opens the live daily briefing (For you only).
	public var live: Bool
	/// The filter-icon menu. Nil hides it.
	public var display: ShellDisplayMenu?

	public init(
		new: (() -> Void)? = nil, newLabel: String = "New", live: Bool = false,
		display: ShellDisplayMenu? = nil
	) {
		self.new = new
		self.newLabel = newLabel
		self.live = live
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
	/// Gives the screen its large, collapsing title, its pill of actions and the profile avatar.
	/// Account, workspace, settings and sign-out live in the profile sheet the avatar opens. Apply to
	/// a screen's root content, inside its `NavigationStack`, and don't also set `.navigationTitle`
	/// on it.
	public func shellToolbar(
		environment: AppEnvironment, title: String? = nil, actions: ShellActions = ShellActions()
	) -> some View {
		modifier(ShellToolbarModifier(environment: environment, title: title, actions: actions))
	}
}

private struct ShellToolbarModifier: ViewModifier {
	var environment: AppEnvironment
	var title: String?
	var actions: ShellActions
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@Environment(\.liveMeeting) private var liveMeeting
	@Environment(\.shellShowsAvatar) private var avatarAllowed
	/// True once the content has scrolled away from the top: New folds away.
	@State private var scrolled = false

	/// The avatar opens the profile sheet. Not shown inside a sheet (it would open one over it).
	private var showsAvatar: Bool {
		runtime != nil && avatarAllowed && environment.auth.session != nil
	}

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
							Label(LiveMeetingRequest.dailyBriefing.buttonLabel, systemImage: "waveform")
						}
						.shellLiveButton()
					}
					if let new = actions.new, !scrolled {
						Button(action: new) { Label(actions.newLabel, systemImage: "plus") }
					}
					if let display = actions.display {
						Menu {
							display.content
						} label: {
							Label("Display", systemImage: "line.3.horizontal.decrease")
						}
					}
				}
				if showsAvatar {
					AvatarToolbarItem(name: environment.auth.session?.name ?? "") {
						runtime?.showProfile = true
					}
				}
			}
	}
}

/// The profile button: the person's initials, 48pt, in a glass capsule of its own at the
/// trailing edge, apart from the tool group before it.
private struct AvatarToolbarItem: ToolbarContent {
	let name: String
	let action: () -> Void

	var body: some ToolbarContent {
		if #available(iOS 26, macOS 26, *) {
			ToolbarSpacer(.fixed, placement: .primaryAction)
		}
		ToolbarItem(placement: .primaryAction) {
			Button(action: action) {
				ActorAvatar(name: name, kind: .human, size: MaskinSpace.s14 + MaskinSpace.s2)
					.frame(width: MaskinSpace.touchMin + MaskinSpace.s2, height: MaskinSpace.touchMin + MaskinSpace.s2)
			}
			.accessibilityLabel("Account")
		}
	}
}

private struct ShellShowsAvatarKey: EnvironmentKey {
	static let defaultValue = true
}

extension EnvironmentValues {
	/// False inside a sheet, where a root screen's avatar would open a profile sheet over it.
	var shellShowsAvatar: Bool {
		get { self[ShellShowsAvatarKey.self] }
		set { self[ShellShowsAvatarKey.self] = newValue }
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
