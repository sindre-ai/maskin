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
/// Order in the pill is Display, Live, the avatar, then New at the very right; search is a collapsed icon at the very left, all inside ONE glass capsule (a single
/// `ToolbarItemGroup`). The per-tab sets are `ShellTab.barItems`. While the content is scrolled New folds away (Live, Display and the
/// avatar stay). Search is never a bar item: it is the trailing search tab.
public struct ShellActions {
	/// Three horizontal lines: For you and Flows.
	public static let filterSymbol = "line.3.horizontal.decrease"
	/// Sliders: Team and Objects.
	public static let slidersSymbol = "slider.horizontal.3"
	/// The "+" button (Team: New conversation). Nil hides it.
	public var new: (() -> Void)?
	/// The "+" button's accessibility label.
	public var newLabel: String
	/// The dark Live button that opens the live daily briefing (For you only).
	public var live: Bool
	/// The filter-icon menu. Nil hides it.
	public var display: ShellDisplayMenu?
	/// Makes the filter button a plain toggle instead of a menu (For you: it shows or hides the
	/// filter pills). Ignored when `display` is set.
	public var displayToggle: (() -> Void)?
	/// The Display menu's glyph: three lines (filter / sort) or sliders (display options).
	public var displaySymbol: String
	/// The display options are off their defaults: the Display button tints Patina (specs 7 §6, 8).
	public var displayActive: Bool
	/// Hides the profile avatar on this screen (Team).
	public var hidesAvatar: Bool
	/// Keeps the "+" button in the bar while the content scrolls (Team).
	public var newAlwaysVisible: Bool

	public init(
		new: (() -> Void)? = nil, newLabel: String = "New", live: Bool = false,
		display: ShellDisplayMenu? = nil, displaySymbol: String = ShellActions.filterSymbol,
		displayActive: Bool = false, displayToggle: (() -> Void)? = nil,
		hidesAvatar: Bool = false, newAlwaysVisible: Bool = false
	) {
		self.hidesAvatar = hidesAvatar
		self.newAlwaysVisible = newAlwaysVisible
		self.displayToggle = displayToggle
		self.displaySymbol = displaySymbol
		self.new = new
		self.newLabel = newLabel
		self.live = live
		self.display = display
		self.displayActive = displayActive
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
			// Every push from a root screen gets the arrow-only back button (user decision).
			.backChevronOnly()
			.trackScrolled($scrolled)
			.toolbar {
				// One item, one glass capsule: the tools and the avatar share it (separate items or a
				// ToolbarSpacer would split them into separate capsules). The buttons sit in a
				// zero-spacing stack because a ToolbarItemGroup puts system spacing between its
				// items, which left a wide gap between Live and the avatar; v6 packs 44 pt slots
				// edge to edge.
				ToolbarItemGroup(placement: .primaryAction) {
					Group {
					if let display = actions.display {
						Menu {
							display.content
						} label: {
							Label("Display", systemImage: actions.displaySymbol)
								.foregroundStyle(actions.displayActive ? MaskinColor.sigInk : MaskinColor.ink)
								.frame(width: MaskinSpace.s14 + MaskinSpace.s2, height: MaskinSpace.s14 + MaskinSpace.s2)
								.background(
									Circle().fill(actions.displayActive ? MaskinColor.sigTint : Color.clear))
								.accessibilityLabel(actions.displayActive ? "Display, options changed" : "Display")
						}
					}
					if actions.display == nil, let toggle = actions.displayToggle {
						Button(action: toggle) {
							Label("Filter", systemImage: actions.displaySymbol)
								.foregroundStyle(actions.displayActive ? MaskinColor.sigInk : MaskinColor.ink)
								.frame(width: MaskinSpace.s14 + MaskinSpace.s2, height: MaskinSpace.s14 + MaskinSpace.s2)
								.background(
									Circle().fill(actions.displayActive ? MaskinColor.sigTint : Color.clear))
						}
						.accessibilityLabel(actions.displayActive ? "Filter, shown" : "Filter")
					}
					// Live sits before the avatar, which stays last (as in the v6 bar).
					if actions.live {
						Button {
							liveMeeting.present(.dailyBriefing)
						} label: {
							ShellInkCircle(
								symbol: "waveform", label: LiveMeetingRequest.dailyBriefing.buttonLabel)
						}
						.buttonStyle(.plain)
					}
					if showsAvatar, !actions.hidesAvatar {
						Button {
							runtime?.showProfile = true
						} label: {
							ShellNavAvatar(name: environment.auth.session?.name ?? "")
							.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
							.contentShape(Circle())
						}
						.buttonStyle(.plain)
						.accessibilityLabel("Account")
					}
					if let new = actions.new, !scrolled || actions.newAlwaysVisible {
						Button(action: new) {
							ShellInkCircle(symbol: "plus", label: actions.newLabel)
						}
						.buttonStyle(.plain)
					}

					}
				}
			}
	}
}

/// A solid ink circle with a white glyph: the primary action of a bar (Live, New). It sits inside
/// the bar's glass capsule rather than being a glass button of its own.
struct ShellInkCircle: View {
	let symbol: String
	let label: String

	var body: some View {
		Image(systemName: symbol)
			.maskinSymbol(16, weight: .semibold)
			.foregroundStyle(MaskinSurface.onNavInk)
			.frame(width: MaskinSpace.s14 + MaskinSpace.s2, height: MaskinSpace.s14 + MaskinSpace.s2)
			.background(Circle().fill(MaskinSurface.navInk))
			.frame(minWidth: MaskinSpace.touchMin, minHeight: MaskinSpace.touchMin)
			.contentShape(Circle())
			.accessibilityLabel(label)
	}
}

/// The profile button in the bar: a Patina tint disc with a thin ring and the person's one initial.
struct ShellNavAvatar: View {
	let name: String

	private var initial: String {
		name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "?"
	}

	var body: some View {
		Text(initial)
			.maskinSymbol(17, weight: .bold)
			.foregroundStyle(MaskinColor.sigInk)
			.frame(width: MaskinSpace.s14 + MaskinSpace.s2, height: MaskinSpace.s14 + MaskinSpace.s2)
			.background(Circle().fill(MaskinColor.sigTint))
			.overlay(Circle().strokeBorder(MaskinColor.sig.opacity(0.3), lineWidth: 1))
			.accessibilityHidden(true)
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
	/// The screen title as the system's large title: on its own row below the bar's glass capsule,
	/// collapsing into the bar as the person scrolls (Apple's pattern for a tab's root screen). macOS keeps the
	/// system title.
	fileprivate func shellTitle(_ title: String?) -> some View {
		#if os(iOS)
			return self
				.navigationTitle(title ?? "")
				.toolbarTitleDisplayMode(title == nil ? .inline : .large)
		#else
			return navigationTitle(title ?? "")
		#endif
	}

	/// iOS 26: search collapses to a toolbar icon that expands into the field when tapped.
	/// A regular search field elsewhere.
	func searchMinimized() -> some View {
		#if os(iOS)
			if #available(iOS 26, *) {
				// The collapsed magnifier sits at the very left of the top bar.
				return AnyView(
					searchToolbarBehavior(.minimize)
						.toolbar { DefaultToolbarItem(kind: .search, placement: .topBarLeading) })
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
}
