import Foundation

/// The call an agent is waiting on for one object, as the Objects list shows it: "Strategist:
/// Post text only…". Read from the same For You feed the decision cards come from, so the list,
/// the feed and the object page always agree on what needs the person.
public struct ObjectAsk: Sendable, Equatable, Identifiable {
	public var id: String { objectId }
	public var objectId: String
	/// Who asked, resolved to a name. Nil when it can't be resolved (the row then shows the ask alone).
	public var by: String?
	public var text: String
	public var card: ForYouCard

	public init(objectId: String, by: String?, text: String, card: ForYouCard) {
		self.objectId = objectId
		self.by = by
		self.text = text
		self.card = card
	}

	/// The agent's recommended option.
	public var recommended: DecisionOption? { card.decision?.recommended }

	/// Swipe-to-approve takes the recommendation, but never one that can't be undone: those keep
	/// their confirmation on the decision card.
	public var swipeApprove: DecisionOption? {
		guard let option = recommended, !option.destructive else { return nil }
		return option
	}

	/// The agent's own "Hold" option, when it authored one.
	public var holdOption: DecisionOption? {
		card.decision?.options.first { HoldReason.isHold($0.label) }
	}

	/// "Strategist: Post text only…" split for styling (name bold, then the ask).
	public var line: String { by.map { "\($0): \(text)" } ?? text }

	/// Open decisions keyed by object id. Only asks still waiting on the reader count: ones already
	/// answered (a receipt in the feed) are no longer asks.
	public static func map(
		from entries: [FeedEntry], senderName: (ForYouCard) -> String?
	) -> [String: ObjectAsk] {
		var out: [String: ObjectAsk] = [:]
		for entry in entries where entry.bucket == .needs && entry.record == nil {
			guard let decision = entry.card.decision else { continue }
			let text = decision.ask.trimmingCharacters(in: .whitespacesAndNewlines)
			guard !text.isEmpty else { continue }
			out[entry.id] = ObjectAsk(
				objectId: entry.id, by: senderName(entry.card), text: text, card: entry.card)
		}
		return out
	}
}
