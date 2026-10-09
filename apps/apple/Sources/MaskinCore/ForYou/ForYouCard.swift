import Foundation

/// An option an agent attached to its ask. Rendered as a tappable row; `consequences` are the
/// agent's own lines, one clause each, including the downside.
public struct DecisionOption: Sendable, Equatable, Identifiable, Codable {
	public var label: String
	public var consequences: [String]
	public var recommended: Bool
	/// Cannot be undone or reaches real people: the UI asks for a confirmation before sending it.
	public var destructive: Bool
	public var id: String { label }

	public init(
		label: String, consequences: [String] = [], recommended: Bool = false,
		destructive: Bool = false
	) {
		self.label = label
		self.consequences = consequences
		self.recommended = recommended
		self.destructive = destructive
	}

	// Hand-written so caches written before `destructive` existed still decode.
	public init(from decoder: any Decoder) throws {
		let c = try decoder.container(keyedBy: CodingKeys.self)
		label = try c.decode(String.self, forKey: .label)
		consequences = try c.decode([String].self, forKey: .consequences)
		recommended = try c.decode(Bool.self, forKey: .recommended)
		destructive = try c.decodeIfPresent(Bool.self, forKey: .destructive) ?? false
	}
}

/// The call an agent cannot make alone (`decision` on the comment that put a card in the feed).
public struct DecisionPrompt: Sendable, Equatable, Codable {
	public var title: String
	/// State of the world and what is already done.
	public var summary: String
	/// The single call that belongs to the human, first person.
	public var ask: String
	public var options: [DecisionOption]

	public init(title: String, summary: String, ask: String, options: [DecisionOption]) {
		self.title = title
		self.summary = summary
		self.ask = ask
		self.options = options
	}

	public var recommended: DecisionOption? { options.first(where: \.recommended) }
}

/// The latest comment that @-mentioned the reader: why the card exists.
public struct ForYouMention: Sendable, Equatable, Codable {
	public var eventId: Int
	public var actorId: String?
	public var createdAt: Date?
	public var content: String
	public var attention: Int?
	public var decision: DecisionPrompt?

	public init(
		eventId: Int, actorId: String? = nil, createdAt: Date? = nil, content: String,
		attention: Int? = nil, decision: DecisionPrompt? = nil
	) {
		self.eventId = eventId
		self.actorId = actorId
		self.createdAt = createdAt
		self.content = content
		self.attention = attention
		self.decision = decision
	}
}

/// One entry of the For You feed: an object with unread activity that mentions the reader.
/// Mirrors the web's `UnreadItem` without any generated-client types.
public struct ForYouCard: Sendable, Equatable, Identifiable, Codable {
	/// The object id (what the feed, comments and read marks all key on).
	public var id: String
	public var entityType: String
	public var objectTitle: String?
	/// `insight`, `bet`, `task`, `onboarding_session`… (open set)
	public var objectType: String?
	public var status: String?
	public var unreadCount: Int
	public var maxAttention: Int?
	/// High-water mark for mark-read. `nil` when the thread has none, in which case answering it
	/// cannot move it out of the feed.
	public var latestEventId: Int?
	public var latestActivityAt: Date?
	public var mention: ForYouMention?

	public init(
		id: String, entityType: String = "object", objectTitle: String? = nil,
		objectType: String? = nil, status: String? = nil, unreadCount: Int = 1,
		maxAttention: Int? = nil, latestEventId: Int? = nil, latestActivityAt: Date? = nil,
		mention: ForYouMention? = nil
	) {
		self.id = id
		self.entityType = entityType
		self.objectTitle = objectTitle
		self.objectType = objectType
		self.status = status
		self.unreadCount = unreadCount
		self.maxAttention = maxAttention
		self.latestEventId = latestEventId
		self.latestActivityAt = latestActivityAt
		self.mention = mention
	}

	public enum Kind: Sendable, Equatable {
		/// The agent asked for a call and authored the options.
		case decision
		/// A plain mention: read it, optionally answer.
		case thread
	}

	public var decision: DecisionPrompt? { mention?.decision }
	public var kind: Kind { decision == nil ? .thread : .decision }

	/// What the card leads with: the decision's title, else the opening of the comment, else the
	/// object's own name (identical across mentions, so a last resort).
	public var headline: String {
		if let title = decision?.title.trimmed, !title.isEmpty { return title }
		let parts = MentionText.parts(of: mention?.content)
		if !parts.headline.isEmpty { return parts.headline }
		return objectTitle?.trimmed.nonEmpty ?? "Untitled"
	}

	/// Under the headline for a plain mention: whatever the headline did not already use.
	public var body: String {
		decision == nil ? MentionText.parts(of: mention?.content).body : ""
	}

	/// The object's name as context, hidden when the headline already fell back to it.
	public var contextTitle: String? {
		guard let t = objectTitle?.trimmed.nonEmpty, t != headline else { return nil }
		return t
	}
}

// MARK: - Mention text

/// Port of the web's `mentionParts`: a headline is a sentence, not a paragraph.
enum MentionText {
	static let headlineMaxWords = 9

	static func parts(of content: String?) -> (headline: String, body: String) {
		guard let content else { return ("", "") }
		let lines = content.components(separatedBy: "\n")
		guard let leadIndex = lines.firstIndex(where: { !stripMarkdownLead($0).isEmpty }) else {
			return ("", "")
		}
		let lead = stripMarkdownLead(lines[leadIndex])
		let (sentence, rest) = firstSentence(of: lead)
		let headline = capWords(sentence)
		// A capped headline is an excerpt, so the body keeps the whole sentence.
		let under = headline == sentence ? rest : lead
		let body = ([under] + lines[(leadIndex + 1)...])
			.joined(separator: "\n").trimmed
		return (headline, body)
	}

	static func stripMarkdownLead(_ raw: String) -> String {
		var s = Substring(raw.trimmed)
		// "## ", "> ", "- ", "* ", "1. "
		let markers: Set<Character> = ["#", ">", "*", "-"]
		if let first = s.first, markers.contains(first) {
			s = s.drop(while: { markers.contains($0) })
		} else if let dot = s.firstIndex(of: "."), s[s.startIndex..<dot].allSatisfy(\.isNumber),
			dot != s.startIndex
		{
			s = s[s.index(after: dot)...]
		}
		return String(s).trimmed
	}

	static func firstSentence(of line: String) -> (String, String) {
		var index = line.startIndex
		while index < line.endIndex {
			let ch = line[index]
			if ".!?".contains(ch) {
				let next = line.index(after: index)
				if next == line.endIndex || line[next].isWhitespace {
					return (String(line[...index]).trimmed, String(line[next...]).trimmed)
				}
			}
			index = line.index(after: index)
		}
		return (line, "")
	}

	static func capWords(_ value: String) -> String {
		let words = value.split(whereSeparator: \.isWhitespace)
		guard words.count > headlineMaxWords else { return value }
		return words.prefix(headlineMaxWords).joined(separator: " ") + "…"
	}
}

extension String {
	var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
	var nonEmpty: String? { isEmpty ? nil : self }
}

// MARK: - Formatting

public enum ForYouFormat {
	/// The "held 3d" note: how long a card that still needs a person has sat in the
	/// feed. Nothing is said until it has waited a full day.
	public static func heldNote(since date: Date?, now: Date = Date()) -> String? {
		guard let date else { return nil }
		let days = Int(now.timeIntervalSince(date) / 86_400)
		if days < 1 { return nil }
		if days >= 7 { return "held 7d+" }
		return "held \(days)d"
	}
}
