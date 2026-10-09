import Foundation

/// The top-level destinations, in tab-bar order: four tabs and the trailing system search tab.
/// There is no More tab and no Agents tab: Agents, Marketplace, Artefacts, Settings, Notifications and
/// Triggers open from the profile sheet (`ProfileMenu`).
public enum ShellTab: String, CaseIterable, Hashable, Identifiable, Sendable {
	case forYou, chats, loops, objects, search

	public var id: String { rawValue }

	/// The tabs that hold a screen of their own, in order. Search is the detached trailing tab.
	public static let primary: [ShellTab] = allCases.filter { $0 != .search }

	public var title: String {
		switch self {
		case .forYou: "For you"
		case .chats: "Team"
		case .loops: "Flows"
		case .objects: "Objects"
		case .search: "Search"
		}
	}

	/// What the floating bar at the top of this tab's root screen holds, left to right. Search has
	/// none: it is the system search tab, and its field is the bar.
	public var barItems: [ShellBarItem] {
		switch self {
		case .forYou: [.display, .live, .avatar]
		case .chats: [.display, .new, .avatar]
		case .loops: [.display, .avatar]
		case .objects: [.display, .avatar]
		case .search: [.avatar]
		}
	}
}

/// One control in a root screen's top bar.
public enum ShellBarItem: String, CaseIterable, Hashable, Sendable {
	/// The dark waveform circle that opens the live daily briefing (For you only).
	case live
	/// The "+" that starts a new conversation (Team only).
	case new
	/// The filter / display menu. Stays while the screen is scrolled.
	case display
	/// The profile avatar, which opens the profile sheet. Stays while the screen is scrolled.
	case avatar

	/// Secondary buttons fold away once the content has scrolled; the display menu and the avatar stay.
	public var collapsesOnScroll: Bool { self == .new }
}
