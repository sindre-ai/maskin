import Foundation
import MaskinCore

/// What a For You card offers and what each tap does, so the card and the feed row only draw it
/// (the same split as `TeamRowActions` and `ObjectRowSwipe`).
enum DecisionCardActions {
	/// The suggested options: the full-width button.
	static func primaryOptions(of decision: DecisionPrompt) -> [DecisionOption] {
		decision.options.filter(\.recommended)
	}

	/// The rest, drawn as pills under it. For you has no Hold or Later: an agent-written one is
	/// not drawn as a pill.
	static func alternateOptions(of decision: DecisionPrompt) -> [DecisionOption] {
		decision.options.filter { !$0.recommended && !HoldReason.isHold($0.label) && !HoldReason.isLater($0.label) }
	}

	/// What tapping an option does: an option that cannot be undone asks first.
	enum Tap: Equatable {
		case choose, confirmFirst
	}

	static func tap(_ option: DecisionOption) -> Tap {
		option.destructive ? .confirmFirst : .choose
	}

	/// The option would send the saved text while the reader's edit has not gone out.
	static func isHeldBack(_ option: DecisionOption, unsentEditNote: String?) -> Bool {
		unsentEditNote != nil && ReviewDraft.sendsMessage(option)
	}

	/// The button a swipe right on a feed row shows.
	enum LeadingSwipe: Equatable {
		case take(DecisionOption), done
	}

	/// Swipe right takes the agent's recommendation. Options that can't be undone are never one
	/// swipe away, and neither is a send held back by an unsent edit. A plain mention has no
	/// options, so there the swipe is Done (mark read). Nothing once the card has an answer.
	static func leadingSwipe(
		for card: ForYouCard, answered: Bool, isHeldBack: (DecisionOption) -> Bool
	) -> LeadingSwipe? {
		if answered { return nil }
		if let option = card.decision?.recommended, !option.destructive, !isHeldBack(option) {
			return .take(option)
		}
		return card.kind == .thread ? .done : nil
	}
}

/// What the stacked messages of one card offer, and when the card is done with them.
struct DraftStackRules {
	let drafts: [DecisionDraft]

	/// The key a message is settled under: the agent's own id, else its position.
	func key(_ draft: DecisionDraft, _ index: Int) -> String { draft.id ?? String(index) }

	/// Something to send: a file card or a draft already approved or sent has no Send and Skip.
	func offersActions(_ draft: DecisionDraft) -> Bool {
		draft.file == nil && draft.preview?.delivery != .approved && draft.preview?.delivery != .sent
	}

	/// Who it goes to, else what kind of message it is.
	func name(_ draft: DecisionDraft) -> String {
		let to = draft.to?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		return to.isEmpty ? draft.label : to
	}

	/// The messages still open, with their positions: what Send all and Skip all act on.
	func pending(done: [String: DecisionService.DraftAction]) -> [(index: Int, draft: DecisionDraft)] {
		drafts.enumerated().compactMap { index, draft in
			offersActions(draft) && done[key(draft, index)] == nil ? (index, draft) : nil
		}
	}

	/// The one line a message folds down to once it has been dealt with.
	func receipt(_ draft: DecisionDraft, outcome: DecisionService.DraftAction) -> String {
		outcome == .send ? "Told the agent to send \u{00B7} \(name(draft))" : "Skipped \u{00B7} \(name(draft))"
	}

	/// Every message that offers Send and Skip has been dealt with: the card can settle.
	func allSettled(done: [String: DecisionService.DraftAction]) -> Bool {
		done.count == drafts.filter(offersActions).count
	}
}
