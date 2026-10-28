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
			let found = object(id, workspace: workspace)
			return MarkdownLinkInfo(
				symbol: found.flatMap { MaskinObjectType.symbol(for: $0.type) } ?? "doc.text",
				kindLabel: found.map { Self.label(forType: $0.type) } ?? "Object", title: found?.title)
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
		}
	}

	/// "bet" → "Bet", "customer_note" → "Customer note".
	static func label(forType type: String) -> String {
		let words = type.replacingOccurrences(of: "_", with: " ").trimmingCharacters(in: .whitespaces)
		return words.isEmpty ? "Object" : words.prefix(1).uppercased() + words.dropFirst()
	}
}
