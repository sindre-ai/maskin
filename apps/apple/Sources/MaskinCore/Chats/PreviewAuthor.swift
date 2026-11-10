import Foundation

/// How two names are compared when deciding whether a preview would only repeat the row title.
/// The web twin is `sameName` in `apps/web/src/lib/conversation-snippet.ts`. Both do the same
/// steps in the same order and share their test cases: trim, decompose (NFD), drop combining
/// marks, upper-case then lower-case (so ß meets "SS" and İ meets "i").
public enum NameMatch {
	public static func folded(_ name: String) -> String {
		let decomposed = name.trimmingCharacters(in: .whitespacesAndNewlines).decomposedStringWithCanonicalMapping
		var bare = String.UnicodeScalarView()
		for scalar in decomposed.unicodeScalars {
			switch scalar.properties.generalCategory {
			case .nonspacingMark, .spacingMark, .enclosingMark: continue
			default: bare.append(scalar)
			}
		}
		return String(bare).uppercased().lowercased()
	}

	public static func same(_ a: String, _ b: String) -> Bool { folded(a) == folded(b) }
}

extension ConversationSummary {
	/// The "Name: " (or "You: ") that leads a preview line, or nil when the row should not say who
	/// wrote it. The one place this is decided: every iOS preview calls it, with the title *that
	/// row displays* (a team-list row shows the other person's name, a sub-row shows `title`).
	///
	/// The name is dropped only when it would repeat the displayed title, and only when the chat
	/// is provably a direct one: exactly two participants, you among them. Without your id, or
	/// with a participant list that leaves you out or runs short, the name stays. Attribution is
	/// the harmless side to err on.
	public func snippetAuthorLead(displayedTitle: String, me: String?) -> String? {
		if let me, let author = snippetActorID, author == me { return "You: " }
		guard let who = snippetActorName?.trimmingCharacters(in: .whitespacesAndNewlines), !who.isEmpty else {
			return nil
		}
		let isDirect = me.map { me in participants.count == 2 && participants.contains { $0.id == me } } ?? false
		return isDirect && NameMatch.same(who, displayedTitle) ? nil : "\(who): "
	}
}
