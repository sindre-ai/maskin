import Foundation

/// What a loop card shows beyond the summary: the stage the loop is in, the latest thing an
/// agent said (one sentence) and whether that asks the viewer to decide. Derived from the same
/// overview the loop page uses; pure, so the rules are tested without a server.
public struct LoopDigest: Equatable, Sendable {
	public var stage: String?
	public var latestAuthorID: String?
	public var latestSentence: String?
	public var hasDecision: Bool

	public init(
		stage: String? = nil, latestAuthorID: String? = nil, latestSentence: String? = nil,
		hasDecision: Bool = false
	) {
		self.stage = stage
		self.latestAuthorID = latestAuthorID
		self.latestSentence = latestSentence
		self.hasDecision = hasDecision
	}

	public static let maxSentenceLength = 130

	public static func build(from overview: LoopOverview) -> LoopDigest {
		let latest = overview.posts.first
		return LoopDigest(
			stage: stage(members: overview.members, statusOrder: overview.statusOrder),
			latestAuthorID: latest?.actorID,
			latestSentence: latest.map { firstSentence(of: $0.text) },
			hasDecision: overview.posts.contains { $0.isDecision })
	}

	/// The furthest configured status that still holds members, ignoring the workflow's last
	/// status (that is "done", not a stage); the last one when nothing else is occupied.
	static func stage(members: [LoopMember], statusOrder: [String]) -> String? {
		let phases = LoopPhases.build(members: members, steps: [], statusOrder: statusOrder)
		guard let last = phases.last else { return nil }
		let open = phases.filter { $0.status != statusOrder.last }
		return (open.last ?? last).status
	}

	/// The post's first sentence with markdown noise removed, cut at a word near
	/// `maxSentenceLength` with an ellipsis.
	public static func firstSentence(of text: String) -> String {
		var plain = text.replacingOccurrences(of: "\n", with: " ")
		for noise in ["**", "__", "`", "#", ">"] { plain = plain.replacingOccurrences(of: noise, with: "") }
		plain = plain.split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
		var sentence = plain
		if let end = plain.firstIndex(where: { ".!?".contains($0) }) {
			let after = plain.index(after: end)
			if after == plain.endIndex || plain[after] == " " { sentence = String(plain[...end]) }
		}
		guard sentence.count > maxSentenceLength else { return sentence }
		let cut = sentence.prefix(maxSentenceLength)
		let trimmed = cut.lastIndex(of: " ").map { String(cut[..<$0]) } ?? String(cut)
		return trimmed.trimmingCharacters(in: CharacterSet(charactersIn: " ,;:-")) + "…"
	}
}

extension LoopSummary {
	/// The progress ring's fill: the share of the loop's work that has closed.
	public var progress: Double {
		let total = inProgressCount + closedCount
		return total == 0 ? 0 : Double(closedCount) / Double(total)
	}

	/// "Cycle 3": the cycle now running, one past those already closed.
	public var cycleLabel: String { "Cycle \(closedCount + 1)" }
}
