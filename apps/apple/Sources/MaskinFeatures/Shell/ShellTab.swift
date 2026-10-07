import Foundation

/// The top-level destinations: four tabs, plus Search as the system search tab (the trailing glass
/// button on iOS 26). Account, workspace, Agents, Files, Marketplace and Settings live in the
/// profile sheet behind the avatar on every root screen; there is no More tab.
enum ShellTab: String, CaseIterable, Hashable, Identifiable {
	case forYou, chats, loops, objects, search

	var id: String { rawValue }

	/// Search is the system `.search` tab role on iOS 26+ (the detached trailing button on iPhone, a
	/// sidebar entry on iPad) and a sidebar entry on the Mac. Below iOS 26 the role doesn't exist, so
	/// Search falls back to a toolbar button.
	static var searchIsTab: Bool {
		#if os(iOS)
			if #available(iOS 26, *) { return true }
			return false
		#else
			return true
		#endif
	}

	/// The tabs to show, in order.
	static var visible: [ShellTab] {
		allCases.filter { $0 != .search || searchIsTab }
	}

	var title: String {
		switch self {
		case .forYou: "For you"
		case .chats: "Team"
		case .loops: "Flows"
		case .objects: "Objects"
		case .search: "Search"
		}
	}

	var systemImage: String {
		switch self {
		case .forYou: "sparkles"
		case .chats: "bubble.left.and.bubble.right"
		case .objects: "square.stack.3d.up"
		case .loops: "arrow.triangle.2.circlepath"
		case .search: "magnifyingglass"
		}
	}
}
