import MaskinCore

extension ShellTab {
	var systemImage: String {
		switch self {
		case .forYou: "text.alignleft"
		case .chats: "bubble.left.and.bubble.right"
		case .loops: "arrow.triangle.2.circlepath"
		case .objects: "square.stack.3d.up"
		case .search: "magnifyingglass"
		}
	}
}
