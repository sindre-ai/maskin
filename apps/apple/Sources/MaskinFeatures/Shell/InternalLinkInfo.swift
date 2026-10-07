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
		case .chat:
			return MarkdownLinkInfo(symbol: "bubble.left", kindLabel: "Chat")
		case .notifications:
			return MarkdownLinkInfo(symbol: "sparkles", kindLabel: "For you")
		}
	}

	/// "bet" → "Bet", "customer_note" → "Customer note".
	static func label(forType type: String) -> String {
		let words = type.replacingOccurrences(of: "_", with: " ").trimmingCharacters(in: .whitespaces)
		return words.isEmpty ? "Object" : words.prefix(1).uppercased() + words.dropFirst()
	}
}
