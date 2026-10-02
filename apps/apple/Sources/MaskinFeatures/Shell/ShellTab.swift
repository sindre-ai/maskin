import Foundation

/// The top-level destinations. Loops and Agents join here later.
enum ShellTab: String, CaseIterable, Hashable, Identifiable {
	case forYou, chats, objects

	var id: String { rawValue }

	var title: String {
		switch self {
		case .forYou: "For you"
		case .chats: "Chats"
		case .objects: "Objects"
		}
	}

	var systemImage: String {
		switch self {
		case .forYou: "sparkles"
		case .chats: "bubble.left.and.bubble.right"
		case .objects: "square.stack.3d.up"
		}
	}
}
