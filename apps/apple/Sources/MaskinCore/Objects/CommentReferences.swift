import Foundation

/// An object linked from a comment with `/`. The comment carries only the id (`metadata.refs`);
/// the title and type are for the chip.
public struct CommentReference: Identifiable, Hashable, Sendable {
	public var id: String
	public var title: String
	public var type: String

	public init(id: String, title: String, type: String) {
		self.id = id
		self.title = title
		self.type = type
	}

	init(_ object: WorkObject) {
		self.init(id: object.id, title: object.displayTitle, type: object.type)
	}
}

/// Finds an in-progress `/query` at the end of the text: a `/` at the start or after whitespace,
/// followed by non-space characters up to the end. (A path like `a/b` or a URL never matches.)
public enum ReferenceTrigger {
	public static let maxReferences = 10

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

	/// The text with the in-progress `/query` removed (the reference rides as a chip, not as text).
	public static func removingTrigger(from text: String) -> String {
		guard let match = find(in: text) else { return text }
		var result = text
		result.replaceSubrange(match.range, with: "")
		return result
	}

	/// `metadata.refs` of a stored comment.
	static func ids(in metadata: JSONValue?) -> [String] {
		guard case .array(let values)? = metadata?["refs"] else { return [] }
		return values.compactMap(\.stringValue).filter { !$0.isEmpty }
	}
}
