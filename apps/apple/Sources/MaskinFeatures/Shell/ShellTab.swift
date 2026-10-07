import Foundation
#if os(iOS)
	import UIKit
#endif

/// The top-level destinations. Search is the system search tab (a detached button on iOS 26).
enum ShellTab: String, CaseIterable, Hashable, Identifiable {
	case forYou, chats, objects, loops, agents, more, search

	var id: String { rawValue }

	/// Search is its own tab only where there is room for it: iPad (iOS 26+, as the system `.search`
	/// role) and the Mac sidebar. On iPhone it is a toolbar button. The phone's bar already holds five
	/// tabs, and a sixth makes iOS fold the overflow into its own "More" list, which would nest our
	/// More tab (and Search) one level deeper. Below iOS 26 it is a toolbar button everywhere.
	static var searchIsTab: Bool {
		#if os(iOS)
			if UIDevice.current.userInterfaceIdiom == .phone { return false }
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
		case .objects: "Objects"
		case .loops: "Flows"
		case .agents: "Agents"
		case .more: "More"
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
		case .more: "ellipsis"
		case .search: "magnifyingglass"
		}
	}
}
