import Foundation

/// The answer to "What needs me?": one line to speak and the same thing in a little more detail
/// to show. Built from the widget snapshot, so it agrees with the For You tab and the widgets.
public struct NeedsMeSummary: Equatable, Sendable {
	public var spoken: String
	public var detail: String
	public var count: Int
	/// Where tapping the answer should go (the top decision, else the inbox).
	public var link: URL?

	public init(state: WidgetState) {
		switch state {
		case .signedOut:
			spoken = "Open Maskin and sign in to see what needs you."
			detail = spoken
			count = 0
			link = nil
		case .unavailable:
			spoken = "I couldn't reach Maskin just now. Try again in a moment."
			detail = spoken
			count = 0
			link = nil
		case .content(let snapshot):
			count = snapshot.needsCount
			link = snapshot.tapURL
			if snapshot.isEmpty {
				spoken = "Nothing needs you right now."
				detail = spoken
			} else {
				let lead =
					snapshot.needsCount == 1 ? "One thing needs you." : "\(snapshot.needsCount) things need you."
				spoken = [lead, Self.sentence(for: snapshot.top)].compactMap { $0 }.joined(separator: " ")
				let lines = snapshot.decisions.map { "• " + Self.line(for: $0) }
				let more = snapshot.needsCount - snapshot.decisions.count
				detail = ([lead] + lines + (more > 0 ? ["…and \(more) more."] : [])).joined(separator: "\n")
			}
		}
	}

	private static func sentence(for decision: WidgetSnapshot.Decision?) -> String? {
		guard let decision else { return nil }
		let title = decision.title.trimmingCharacters(in: .whitespacesAndNewlines)
		guard !title.isEmpty else { return nil }
		if let who = decision.agentName, !who.isEmpty { return "\(who) asks: \(title)" }
		return "First up: \(title)"
	}

	private static func line(for decision: WidgetSnapshot.Decision) -> String {
		if let who = decision.agentName, !who.isEmpty { return "\(decision.title) (\(who))" }
		return decision.title
	}
}
