import Foundation

/// Finds an in-progress `/query` at the end of the text: a `/` at the start or after whitespace,
/// followed by non-space characters. It lists recent items to reference and the types to create.
public enum SlashTrigger {
	public struct Match: Equatable {
		public var range: Range<String.Index>
		public var query: String
	}

	public static func find(in text: String) -> Match? {
		guard let slash = text.lastIndex(of: "/") else { return nil }
		if slash > text.startIndex, !text[text.index(before: slash)].isWhitespace { return nil }
		let query = text[text.index(after: slash)...]
		if query.contains(where: \.isWhitespace) { return nil }
		return Match(range: slash..<text.endIndex, query: String(query))
	}
}

/// An item the slash picker offers to reference.
public struct SlashItem: Identifiable, Equatable, Sendable {
	public var id: String
	public var title: String
	/// The type's name for people ("Task"), never the raw type key.
	public var typeLabel: String

	public init(id: String, title: String, typeLabel: String) {
		self.id = id
		self.title = title
		self.typeLabel = typeLabel
	}

	/// "Task · recent" while nothing is typed, "Task" for a match.
	public func subtitle(isRecent: Bool) -> String { isRecent ? "\(typeLabel) · recent" : typeLabel }
}

/// The three types the picker can create, in the order the design lists them.
public enum SlashCreateType: String, CaseIterable, Identifiable, Sendable {
	case task, bet, insight

	public var id: String { rawValue }
	public var label: String { rawValue.capitalized }
	public var summary: String {
		switch self {
		case .task: "A piece of work to track through to done"
		case .bet: "A shaped, time-boxed outcome"
		case .insight: "A signal from the world worth capturing"
		}
	}
	public var symbol: String {
		switch self {
		case .task: "checkmark.circle"
		case .bet: "scope"
		case .insight: "lightbulb"
		}
	}
	/// What a new one is called when nothing was typed after the slash.
	public var untitled: String { "New \(rawValue)" }
}

public enum SlashReference {
	/// The link a picked item leaves in the message. Messages already show a link to an item as its
	/// card, so nothing beyond the text is sent.
	public static func markdown(title: String, workspaceID: String, objectID: String) -> String {
		let safe = title.replacingOccurrences(of: "[", with: "(").replacingOccurrences(of: "]", with: ")")
		let url = DeepLink.object(workspaceId: workspaceID, id: objectID).universalURL().absoluteString
		return "[\(safe)](\(url))"
	}

	/// Items matching `query` by title, keeping their order; at most `limit`.
	public static func matches(_ items: [SlashItem], query: String, limit: Int = 5) -> [SlashItem] {
		let trimmed = query.trimmingCharacters(in: .whitespaces)
		let found = trimmed.isEmpty ? items : items.filter { $0.title.localizedCaseInsensitiveContains(trimmed) }
		return Array(found.prefix(limit))
	}
}

extension ChatComposerModel {
	/// Replace the `/query` being typed with the link to an item.
	public func pickSlash(markdown: String) {
		guard let trigger = SlashTrigger.find(in: text) else {
			insert(markdown + " ")
			return
		}
		var new = text
		new.replaceSubrange(trigger.range, with: markdown + " ")
		let end = new.count
		setText(new, selecting: end..<end)
	}
}
