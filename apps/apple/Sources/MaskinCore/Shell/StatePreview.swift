import Foundation

/// What Settings > Advanced > Preview can force every tab to show, so loading, empty, error and
/// offline can be looked at without breaking the connection. Off by default; the tabs read their
/// real data and network state unless a switch is on. Held in `UserDefaults` so `@AppStorage` sees it.
public enum StatePreview: String, CaseIterable, Sendable {
	case loading, empty, error

	/// The one active screen-state preview, if any. Turning one on turns the others off.
	public static let screenKey = "maskin.preview.screenState"
	public static let offlineKey = "maskin.preview.offline"

	public var title: String {
		switch self {
		case .loading: "Loading state"
		case .empty: "Empty state"
		case .error: "Error state"
		}
	}

	public static func stored(in defaults: UserDefaults = .standard) -> StatePreview? {
		defaults.string(forKey: screenKey).flatMap(StatePreview.init(rawValue:))
	}
}

/// The words a tab uses when it has nothing to show, or could not load: an icon, a title and one line.
public struct TabStateCopy: Equatable, Sendable {
	public let symbol: String
	public let title: String
	public let message: String

	public static func empty(for tab: ShellTab) -> TabStateCopy {
		switch tab {
		case .forYou:
			TabStateCopy(symbol: "checkmark", title: "You're caught up", message: "Nothing needs you right now.")
		case .chats:
			TabStateCopy(symbol: "bubble.left", title: "No chats yet", message: "Start one with the Chief of Staff.")
		case .loops:
			TabStateCopy(
				symbol: "arrow.triangle.2.circlepath", title: "No flows yet",
				message: "Ask the Chief of Staff to set one up.")
		case .objects:
			TabStateCopy(symbol: "square.stack.3d.up", title: "No items yet", message: "Ask an agent to create one.")
		case .search, .newChat:
			TabStateCopy(symbol: "magnifyingglass", title: "Nothing here", message: "")
		}
	}

	public static func error(for tab: ShellTab) -> TabStateCopy {
		let what: String =
			switch tab {
			case .forYou: "your feed"
			case .chats: "chats"
			case .loops: "flows"
			case .objects: "items"
			case .search, .newChat: "this"
			}
		return TabStateCopy(
			symbol: "wifi.exclamationmark", title: "Couldn't load \(what)",
			message: "Check your connection and try again.")
	}
}
