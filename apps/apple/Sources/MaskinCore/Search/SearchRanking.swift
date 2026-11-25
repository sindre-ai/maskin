import Foundation

/// The one rule that orders search hits: a title match first, then (for chats) a participant
/// match, then a match only in the preview text. Pure, so the phone and the TV list agree.
public enum SearchRanking {
	public enum Tier: Int, Sendable, Comparable {
		case title = 0
		case participants = 1
		case preview = 2

		public static func < (lhs: Tier, rhs: Tier) -> Bool { lhs.rawValue < rhs.rawValue }
	}

	/// Where `query` hits `result`. An empty query (only people picked) ranks everything alike.
	/// Only chats have participants in the subtitle; for other kinds the subtitle is a status or
	/// file type, so a hit there counts as a preview hit.
	public static func tier(of result: SearchResult, query: String) -> Tier {
		let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
		if needle.isEmpty { return .title }
		if SearchHighlight.matches(needle, in: result.title) { return .title }
		if result.kind == .chat, SearchHighlight.matches(needle, in: result.subtitle) { return .participants }
		return .preview
	}

	/// Keeps the groups in display order and, inside each group, sorts by tier. Inside a tier a
	/// result the person opened from search before comes first, the more and the more lately the
	/// higher (`bonuses` maps an entity id to the server's frecency points; the server's capped
	/// bonus is the same one its own search adds, so name match tier stays first). Then
	/// chats and flows (filtered on the device, from lists the server returns by recency) go newest
	/// first; objects, files and agents keep the order their source gave them. The sort is stable
	/// and consistent across kinds, so mixed input cannot confuse it.
	public static func ordered(
		_ results: [SearchResult], query: String, bonuses: [String: Int] = [:]
	) -> [SearchResult] {
		let keyed = results.enumerated().map {
			(
				offset: $0.offset, group: SearchGroup.displayOrder.firstIndex(of: $0.element.group) ?? 0,
				tier: tier(of: $0.element, query: query), result: $0.element
			)
		}
		return keyed.sorted { a, b in
			if a.group != b.group { return a.group < b.group }
			if a.tier != b.tier { return a.tier < b.tier }
			let boostA = bonuses[a.result.entityId] ?? 0
			let boostB = bonuses[b.result.entityId] ?? 0
			if boostA != boostB { return boostA > boostB }
			if ranksByRecency(a.result) {
				let da = a.result.updatedAt ?? .distantPast
				let db = b.result.updatedAt ?? .distantPast
				if da != db { return da > db }
			}
			return a.offset < b.offset
		}
		.map(\.result)
	}

	private static func ranksByRecency(_ result: SearchResult) -> Bool {
		result.kind == .chat || result.isFlow
	}
}
