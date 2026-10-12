import MaskinCore

extension ShellTab {
	var systemImage: String {
		switch self {
		case .forYou: "text.alignleft"
		case .chats: "message"
		case .loops: "arrow.clockwise"
		case .objects: "square.stack.3d.up"
		case .search: "magnifyingglass"
		}
	}
}
