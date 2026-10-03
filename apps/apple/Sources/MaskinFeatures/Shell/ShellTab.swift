import Foundation

/// The top-level destinations. Search is the system search tab (a detached button on iOS 26).
enum ShellTab: String, CaseIterable, Hashable, Identifiable {
	case forYou, chats, objects, loops, agents, search

	var id: String { rawValue }

	/// Search is its own detached tab only where the system presents the `.search` role that way
	/// (iOS 26+; the Mac sidebar has room for it). Below that a sixth tab would push Agents or
	/// Search behind a "More" tab on iPhone, so Search becomes a toolbar button instead.
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
		case .chats: "Chats"
		case .objects: "Objects"
		case .loops: "Loops"
		case .agents: "Agents"
		case .search: "Search"
		}
	}

	var systemImage: String {
		switch self {
		case .forYou: "sparkles"
		case .chats: "bubble.left.and.bubble.right"
		case .objects: "square.stack.3d.up"
		case .loops: "arrow.triangle.2.circlepath"
		case .agents: "person.2"
		case .search: "magnifyingglass"
		}
	}
}
