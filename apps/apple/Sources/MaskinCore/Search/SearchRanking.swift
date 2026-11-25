import Foundation

/// The one rule that orders search hits: the match tier first, then (for chats) unread before
/// read, then newest first. Pure, so the phone and the TV list agree.
public enum SearchRanking {
	/// Lower is better. A chat is ranked like everywhere else (`ChatSearchOrder.tier`) over its title
	/// and the names of its people, the subtitle; a chat on the placeholder title passes no title.
	/// For other kinds 0 is a hit in the title and 3 anything else. An empty query (only people
	/// picked) ranks everything alike.
	public static func tier(of result: SearchResult, query: String) -> Int {
		let needle = query.trimmingCharacters(in: .whitespacesAndNewlines)
		if needle.isEmpty { return 0 }
		guard result.kind == .chat else { return SearchHighlight.matches(needle, in: result.title) ? 0 : 3 }
		let people = result.subtitle.components(separatedBy: ", ")
		return ChatSearchOrder.tier(names: (result.hasPlaceholderTitle ? [] : [result.title]) + people, query: needle)
	}

	/// Keeps the groups in display order and, inside each group, sorts by tier. Inside a tier, a
	/// result the person opened from search before comes first, the more and the more lately the
	/// higher (`bonuses` maps an entity id to the server's frecency points, the same capped bonus its
	/// own search adds, so name match tier stays first). Then unread chats come before read ones, then
	/// chats and flows (filtered on the device, from lists the server returns by recency) go newest
	/// first. The chat list holds no archived chats, so the archive rule has nothing to do here.
	/// Objects, files and agents keep the order their source gave them. The sort is stable and
	/// consistent across kinds, so mixed input cannot confuse it.
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
			if a.result.kind == .chat, a.result.isUnread != b.result.isUnread { return a.result.isUnread }
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
