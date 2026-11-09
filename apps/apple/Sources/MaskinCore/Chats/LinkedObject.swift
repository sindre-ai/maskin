import Foundation

/// What the card for a linked object shows, read from the object's full record.
public struct LinkedObject: Equatable, Sendable {
	public var target: LinkedTarget
	/// The workspace's key for the type: "task", "bet".
	public var type: String
	/// "Task", "Bet": the type in words.
	public var kindLabel: String
	/// Nil when the object has no title.
	public var title: String?
	/// The first lines of the text, without markdown marks. Nil when the object has no text.
	public var summary: String?
	public var status: String
	/// The one fact the card shows until the type's field list can be read (see the native spec).
	public var priority: String?
	public var ownerID: String?
	public var updatedAt: Date?

	public init(
		target: LinkedTarget, type: String, kindLabel: String, title: String?, summary: String? = nil, status: String,
		priority: String? = nil, ownerID: String? = nil, updatedAt: Date? = nil
	) {
		self.target = target
		self.type = type
		self.kindLabel = kindLabel
		self.title = title
		self.summary = summary
		self.status = status
		self.priority = priority
		self.ownerID = ownerID
		self.updatedAt = updatedAt
	}

	public init(object: WorkObject, kindLabel: String) {
		let title = object.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		let priority = object.metadata["priority"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		self.init(
			target: LinkedTarget(kind: .object, uuid: object.id), type: object.type, kindLabel: kindLabel,
			title: title.isEmpty ? nil : title, summary: Self.summary(from: object.content),
			status: object.status, priority: priority.isEmpty ? nil : priority, ownerID: object.driverId,
			updatedAt: object.updatedAt)
	}

	/// The title, or "Untitled".
	public var displayTitle: String { title ?? "Untitled" }

	/// How many characters of the text are kept; the card shows two lines of it.
	static let summaryCharacters = 240

	private static let lineMarks = try! NSRegularExpression(pattern: #"^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d{1,9}[.)]\s+)"#)
	private static let linkMarks = try! NSRegularExpression(pattern: #"\[([^\]]*)\]\([^)]*\)"#)
	private static let inlineMarks = try! NSRegularExpression(pattern: #"\*+|`+|~~|__"#)

	/// The first lines of a markdown text as plain words, or nil when there are none.
	public static func summary(from content: String?) -> String? {
		guard let content else { return nil }
		var words: [String] = []
		for raw in content.components(separatedBy: .newlines) {
			var line = raw.trimmingCharacters(in: .whitespaces)
			if line.isEmpty || line.hasPrefix("```") || line.hasPrefix("---") { continue }
			line = strip(lineMarks, from: line, with: "")
			line = strip(linkMarks, from: line, with: "$1")
			line = strip(inlineMarks, from: line, with: "").trimmingCharacters(in: .whitespaces)
			if line.isEmpty { continue }
			words.append(line)
			if words.joined(separator: " ").count >= summaryCharacters || words.count == 3 { break }
		}
		let joined = words.joined(separator: " ")
		return joined.isEmpty ? nil : String(joined.prefix(summaryCharacters))
	}

	private static func strip(_ expression: NSRegularExpression, from text: String, with template: String) -> String {
		expression.stringByReplacingMatches(
			in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
	}
}
