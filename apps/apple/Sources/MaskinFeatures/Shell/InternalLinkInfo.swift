import MaskinCore
import MaskinUI
import SwiftUI

extension InternalLinkDirectory {
	/// What an in-app link should look like: an icon and kind now, the thing's own name once the
	/// directory has fetched it. Nil for anything that isn't a link into Maskin.
	func info(for url: URL) -> MarkdownLinkInfo? {
		guard let link = DeepLink(url: url) else { return nil }
		switch link {
		case .object(_, let id):
			let found = object(id)
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
