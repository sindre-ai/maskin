import Foundation

/// The "Deciding now" queue in the live-call dock: the reader's open For You decisions that a
/// single tap can answer, in the order the dock walks through them.
///
/// Pure: it takes the feed's open entries (already in the Chief of Staff's ranked order) and
/// returns the ones to show. The dock answers through `ForYouStore.choose`, the same path the
/// For You card uses, so nothing here writes.
public enum LiveDecisionQueue {
	/// What makes a card "related to this thread". Plain ids, so it is testable without a chat.
	public struct Thread: Sendable, Equatable {
		/// Everyone in the conversation, the call's lead included.
		public var participantIDs: Set<String>
		/// Objects the thread has talked about (the call's mentioned-object chips).
		public var objectIDs: Set<String>

		public init(participantIDs: Set<String> = [], objectIDs: Set<String> = []) {
			self.participantIDs = participantIDs
			self.objectIDs = objectIDs
		}
	}

	/// A card is related to the thread when it is about an object the thread has mentioned, or the
	/// agent who asked is in the conversation. A call that made its own thread has only the lead
	/// and the person in it, so this stays a small, honest signal rather than a guess.
	public static func isRelated(_ card: ForYouCard, to thread: Thread) -> Bool {
		if thread.objectIDs.contains(card.id) { return true }
		if let asker = card.mention?.actorId, thread.participantIDs.contains(asker) { return true }
		return false
	}

	/// The options a tap may take. Destructive ones are left to the For You card, where they ask
	/// for a confirmation the dock has no room for.
	public static func answerableOptions(of card: ForYouCard) -> [DecisionOption] {
		guard let decision = card.decision, decision.draft == nil, decision.drafts.isEmpty else {
			return []
		}
		return decision.options.filter { !$0.destructive }
	}

	/// Open decisions the dock can show: a decision card in the feed's "needs you" bucket (an answered one has left it; one whose answer
	/// failed is back), with
	/// at least one short option and nothing to read first (a draft to approve, free text). Related
	/// cards come first, then the rest, each group keeping the feed's ranked order.
	public static func queue(from entries: [FeedEntry], thread: Thread) -> [ForYouCard] {
		let open = entries.filter { $0.bucket == .needs }.map(\.card)
			.filter { !answerableOptions(of: $0).isEmpty }
		return open.filter { isRelated($0, to: thread) } + open.filter { !isRelated($0, to: thread) }
	}

	/// The question the card puts to the person: the agent's ask, else the decision's title.
	public static func question(of card: ForYouCard) -> String {
		let ask = card.decision?.ask.trimmed ?? ""
		return ask.isEmpty ? card.headline : ask
	}

	/// What the agent on the call is told after a tap, in plain words.
	public static func chosenText(label: String, question: String) -> String {
		"I chose: \(label) on: \(question)"
	}

	/// The option to lead with: the agent's recommendation when a tap may take it, else the first.
	public static func primary(of card: ForYouCard) -> DecisionOption? {
		let options = answerableOptions(of: card)
		return options.first(where: \.recommended) ?? options.first
	}

	public static func alternates(of card: ForYouCard) -> [DecisionOption] {
		let lead = primary(of: card)
		return answerableOptions(of: card).filter { $0 != lead }
	}
}
