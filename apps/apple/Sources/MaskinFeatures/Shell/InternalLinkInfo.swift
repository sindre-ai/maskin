import MaskinCore
import MaskinUI
import SwiftUI

extension InternalLinkDirectory {
	/// What an in-app link should look like: an icon and kind now, the thing's own name once the
	/// directory has fetched it. A GitHub pull request or issue is described from its address alone,
	/// and marked as leaving the app. Nil for anything else.
	func info(for url: URL) -> MarkdownLinkInfo? {
		if let github = GitHubLink(url: url) {
			return MarkdownLinkInfo(
				symbol: github.symbol, kindLabel: github.kindLabel, title: github.title, leavesApp: true)
		}
		guard let link = DeepLink(url: url) else { return nil }
		switch link {
		case .object(let workspace, let id):
			switch lookup(id, workspace: workspace) {
			case .object(let found):
				return MarkdownLinkInfo(
					symbol: MaskinObjectType.symbol(for: found.type) ?? "doc.text", kindLabel: Self.label(forType: found.type),
					title: found.title, objectType: found.type, status: found.status)
			case .loading:
				return MarkdownLinkInfo(symbol: "doc.text", kindLabel: "Object", phase: .loading)
			case .deleted:
				return MarkdownLinkInfo(symbol: "trash", kindLabel: "Object", phase: .deleted)
			case .unreadable:
				return MarkdownLinkInfo(symbol: "doc.text", kindLabel: "Object")
			}
		case .chat, .thread:
			return MarkdownLinkInfo(symbol: "bubble.left", kindLabel: "Chat")
		case .file:
			return MarkdownLinkInfo(symbol: "doc", kindLabel: "File")
		case .notifications:
			return MarkdownLinkInfo(symbol: "sparkles", kindLabel: "For you")
		case .agents:
			return MarkdownLinkInfo(symbol: "person.2", kindLabel: "Agents")
		case .agent:
			return MarkdownLinkInfo(symbol: "person", kindLabel: "Agent")
		case .loop(_, let id):
			return namedInfo(.loop, id: id, symbol: LinkedKindSymbol.loop, kindLabel: "Loop")
		case .trigger(_, let id):
			// A trigger that is not in the loaded list stays the kind word alone.
			return namedInfo(.trigger, id: id, symbol: "bolt", kindLabel: "Trigger")
		}
	}

	/// A loop's or trigger's chip: its name, "Deleted loop" if it is gone, else the kind word.
	private func namedInfo(_ kind: LinkedTarget.Kind, id: String, symbol: String, kindLabel: String) -> MarkdownLinkInfo {
		var title: String?
		if let found = named(kind, id: id) {
			title = found.isDeleted ? "Deleted \(kindLabel.lowercased())" : found.title
		}
		return MarkdownLinkInfo(symbol: symbol, kindLabel: kindLabel, title: title)
	}

	/// "bet" → "Bet", "customer_note" → "Customer note".
	static func label(forType type: String) -> String {
		let words = type.replacingOccurrences(of: "_", with: " ").trimmingCharacters(in: .whitespaces)
		return words.isEmpty ? "Object" : words.prefix(1).uppercased() + words.dropFirst()
	}
}
