import Foundation

/// Direct port of `apps/web/src/lib/foryou-card-kind.ts`. Which buttons a For You / Chats
/// card shows is 100% client-side classification — there's no backend "decision" field
/// (see plan Context) — so this must stay bit-for-bit in sync with the web version.
enum CardKind: String {
	case decision, signOff, proposedBet, thread
}

struct CardAction: Identifiable {
	let id: String
	let label: String
	let isPrimary: Bool
}

enum CardClassifier {
	private static let proposedBetStatuses: Set<String> = ["signal", "proposed", "define", "clustered"]
	private static let reviewTaskStatuses: Set<String> = ["in_review"]

	static func classify(_ item: UnreadItem) -> CardKind {
		guard let object = item.object else { return .thread }
		let type = object.type
		let status = object.status
		if type == "task", reviewTaskStatuses.contains(status) {
			return hasDecisionType(object) ? .decision : .signOff
		}
		if type == "bet", proposedBetStatuses.contains(status) {
			return .proposedBet
		}
		return .thread
	}

	private static func hasDecisionType(_ object: MaskinObject) -> Bool {
		guard let value = object.decisionType else { return false }
		return !value.isEmpty
	}

	static func actions(for kind: CardKind) -> [CardAction] {
		switch kind {
		case .decision:
			return [
				CardAction(id: "approve", label: "Approve", isPrimary: true),
				CardAction(id: "send_back", label: "Send back", isPrimary: false),
			]
		case .signOff:
			return [
				CardAction(id: "sign_off", label: "Sign off", isPrimary: true),
				CardAction(id: "send_back", label: "Send back", isPrimary: false),
				CardAction(id: "snooze_24h", label: "Snooze 24h", isPrimary: false),
			]
		case .proposedBet:
			return [
				CardAction(id: "open_bet", label: "Open bet", isPrimary: true),
				CardAction(id: "refine", label: "Refine first", isPrimary: false),
				CardAction(id: "dismiss", label: "Dismiss", isPrimary: false),
			]
		case .thread:
			return quickReplyChips
		}
	}

	/// Fallback chips for plain threads — matches `QUICK_REPLY_CHIPS`.
	static let quickReplyChips: [CardAction] = [
		CardAction(id: "on_it", label: "On it", isPrimary: false),
		CardAction(id: "approved", label: "Approved", isPrimary: false),
		CardAction(id: "looks_good", label: "Looks good", isPrimary: false),
		CardAction(id: "need_context", label: "Need more context", isPrimary: false),
	]
}
