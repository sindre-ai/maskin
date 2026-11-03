import Foundation

/// The answer to "What needs me?": one line to speak and the same thing in a little more detail
/// to show. Built from the widget snapshot, so it agrees with the For You tab and the widgets.
public struct NeedsMeSummary: Equatable, Sendable {
	public var spoken: String
	public var detail: String
	public var count: Int
	/// Where tapping the answer should go (the top decision, else the inbox).
	public var link: URL?
	/// The titles of the decisions the snapshot carries (at most `maxTitles`), in order, for the
	/// Siri snippet's rows. Empty when nothing needs you or the state is not content.
	public var titles: [String]

	public static let maxTitles = 3

	public init(state: WidgetState) {
		switch state {
		case .signedOut:
			spoken = "Open Maskin and sign in to see what needs you."
			detail = spoken
			count = 0
			link = nil
			titles = []
		case .unavailable:
			spoken = "I couldn't reach Maskin just now. Try again in a moment."
			detail = spoken
			count = 0
			link = nil
			titles = []
		case .content(let snapshot):
			count = snapshot.needsCount
			link = snapshot.tapURL
			titles = snapshot.decisions.prefix(Self.maxTitles).map(\.title)
				.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
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

	/// The snippet's title: "3 decisions need you". Only for a real count; otherwise the spoken line.
	public var snippetTitle: String {
		guard count > 0 else { return spoken }
		return count == 1 ? "1 decision needs you" : "\(count) decisions need you"
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
