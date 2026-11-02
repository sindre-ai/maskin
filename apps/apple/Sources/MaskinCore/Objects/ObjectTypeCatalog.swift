import Foundation

/// Pure type-ordering and labelling rules for object types (handoff `specs/8-Objects.md` →
/// Object types). Types themselves come from the workspace schema; this only says how to order
/// and pluralise them. `MaskinUI.MaskinObjectType` carries the same rules for views (MaskinUI
/// cannot be imported here); keep the two in step.
public enum ObjectTypeCatalog {
	/// Prototype order when present; anything else follows alphabetically by label.
	public static let order: [String] = [
		"bet", "insight", "task", "knowledge", "doc", "person", "company", "article", "meeting",
	]

	/// Older data says "account" where the product now says "company".
	public static func canonical(_ type: String) -> String {
		type == "account" ? "company" : type
	}

	/// "Bets", "People", "Knowledge"; a custom type uses its display name with a plain "s".
	public static func pluralLabel(for type: String, displayName: String? = nil) -> String {
		switch canonical(type) {
		case "bet": return "Bets"
		case "insight": return "Insights"
		case "task": return "Tasks"
		case "knowledge": return "Knowledge"
		case "doc", "file", "document": return "Docs"
		case "person": return "People"
		case "company": return "Companies"
		case "article": return "Articles"
		case "meeting": return "Meetings"
		default:
			let base = displayName ?? type.replacingOccurrences(of: "_", with: " ").capitalized
			return base.hasSuffix("s") ? base : base + "s"
		}
	}

	/// Product order first, then the rest alphabetically by plural label.
	public static func sorted(_ types: [String], displayName: (String) -> String? = { _ in nil })
		-> [String]
	{
		types.sorted { a, b in
			let ia = order.firstIndex(of: canonical(a))
			let ib = order.firstIndex(of: canonical(b))
			switch (ia, ib) {
			case let (x?, y?): return x < y
			case (.some, .none): return true
			case (.none, .some): return false
			case (.none, .none):
				return pluralLabel(for: a, displayName: displayName(a))
					.localizedCaseInsensitiveCompare(pluralLabel(for: b, displayName: displayName(b)))
					== .orderedAscending
			}
		}
	}
}

/// Where the Objects tab is: the large title and the active type tab both read from this.
public enum ObjectsScope: Hashable, Sendable, Codable {
	/// Objects that want the reader (an open ask, a review, something unread).
	case needsYou
	/// Every type.
	case all
	/// Starred by the reader.
	case favourites
	/// One type from the workspace schema.
	case type(String)
	/// A locally saved view (`SavedView.id`).
	case saved(String)

	/// The large title: "Objects", "Insights", "Needs you"…
	public func title(schema: ObjectsSchema, savedViewName: (String) -> String? = { _ in nil }) -> String {
		switch self {
		case .needsYou: "Needs you"
		case .all: "Objects"
		case .favourites: "Favourites"
		case .type(let type):
			ObjectTypeCatalog.pluralLabel(for: type, displayName: schema.displayName(for: type))
		case .saved(let id): savedViewName(id) ?? "Saved view"
		}
	}

	/// The server-side type filter this scope implies.
	public var typeFilter: String? {
		if case .type(let type) = self { return type }
		return nil
	}
}

/// One type's row in the tabs and the Go to grid.
public struct ObjectTypeSummary: Identifiable, Sendable, Equatable {
	/// The schema key.
	public var id: String
	public var label: String
	/// Objects of this type in the inventory.
	public var count: Int
	/// Of those, how many need the reader.
	public var needsYou: Int
	/// The inventory hit the server cap, so `count` is a floor ("100+").
	public var isCapped: Bool

	public init(id: String, label: String, count: Int, needsYou: Int, isCapped: Bool = false) {
		self.id = id
		self.label = label
		self.count = count
		self.needsYou = needsYou
		self.isCapped = isCapped
	}

	/// "12", or "100+" when the inventory was capped.
	public var countLabel: String { isCapped ? "\(count)+" : "\(count)" }
}

/// An agent's open ask on an object, as the For You feed knows it. The list shows it as the
/// row's second line and answers it through the same `DecisionService` as the feed.
public struct ObjectAsk: Sendable, Equatable, Identifiable {
	public var objectId: String
	/// Who asked (resolved name; `nil` when it could not be resolved, never an id).
	public var askedBy: String?
	/// The ask, one line: the decision's title, else the opening of the mention.
	public var text: String
	public var parentEventId: Int?
	public var latestEventId: Int?
	/// The agent's own options, when it authored a decision.
	public var options: [DecisionOption]

	public var id: String { objectId }

	public init(
		objectId: String, askedBy: String?, text: String, parentEventId: Int? = nil,
		latestEventId: Int? = nil, options: [DecisionOption] = []
	) {
		self.objectId = objectId
		self.askedBy = askedBy
		self.text = text
		self.parentEventId = parentEventId
		self.latestEventId = latestEventId
		self.options = options
	}

	/// The feed card that put this object in "Needs you", or `nil` for a plain FYI mention.
	public init?(_ entry: FeedEntry, senderName: String?) {
		guard entry.bucket == .needs else { return nil }
		let card = entry.card
		self.init(
			objectId: card.id, askedBy: senderName, text: card.headline,
			parentEventId: card.mention?.eventId, latestEventId: card.latestEventId,
			options: card.decision?.options ?? [])
	}

	/// The option the reader takes to approve: the agent's recommendation, else the first option
	/// that is not destructive. `nil` means "answer with a plain reply".
	public var approveOption: DecisionOption? {
		options.first(where: \.recommended) ?? options.first { !$0.destructive }
	}

	/// The option that means "hold", if the agent offered one.
	public var holdOption: DecisionOption? {
		options.first { option in
			let l = option.label.lowercased()
			return l.contains("hold") || l.contains("wait") || l.contains("not yet") || l.contains("later")
		}
	}

	/// "Strategist: Post text only…" (the row's second line). Without a name, just the ask.
	public var line: String {
		guard let askedBy, !askedBy.isEmpty else { return text }
		return "\(askedBy): \(text)"
	}
}
