import Foundation
import Testing

@testable import MaskinCore

@Suite("SearchRanking")
struct SearchRankingTests {
	// The "Magnus" search: a chat titled with the name, a chat he is only in, a chat that only
	// mentions him in its last message. The server hands them over in the order the phone showed.
	private let previewOnly = chat("prev", "Roadmap", people: "Sigrid Larsen", snippet: "Magnus will review it")
	private let participantOnly = chat("part", "Weekly sync", people: "Magnus Eide, Sigrid Larsen", snippet: "ok")
	private let titled = chat("title", "Magnus 1:1", people: "Sebastian")

	@Test("a whole-word match ranks above the start of a word, above inside a word, above a preview hit")
	func tiers() {
		let start = chat("start", "Magnusson plan", people: "Sebastian")
		let inside = chat("inside", "Unmagnused", people: "Sebastian")
		let ordered = SearchRanking.ordered([previewOnly, inside, start, participantOnly, titled], query: "magnus")
		// Whole word in the title or in a name ties, so the one with no date keeps its input order.
		#expect(ordered.map(\.entityId) == ["part", "title", "start", "inside", "prev"])
	}

	@Test("tier is read from the title and the chat's people together, then anything else")
	func tierOf() {
		#expect(SearchRanking.tier(of: titled, query: "Magnus") == 0)
		#expect(SearchRanking.tier(of: participantOnly, query: "Magnus") == 0)
		#expect(SearchRanking.tier(of: previewOnly, query: "Magnus") == 3)
		#expect(SearchRanking.tier(of: titled, query: "  ") == 0, "no words: everything ranks alike")
	}

	@Test("a chat on the placeholder title is not found or ranked by those words")
	func placeholderTitle() {
		let placeholder = SearchResult(
			kind: .chat, entityId: "new", title: "New chat", subtitle: "Me, Sam", hasPlaceholderTitle: true)
		let named = chat("named", "Chat redesign", people: "Me, Sam")
		#expect(SearchRanking.tier(of: placeholder, query: "chat") == 3)
		#expect(SearchRanking.tier(of: named, query: "chat") == 0)
		#expect(SearchStore.filter([placeholder, named], "chat").map(\.entityId) == ["named"])
		#expect(SearchRanking.tier(of: placeholder, query: "sam") == 0, "its people still find it")
	}

	@Test("a status or file type in the subtitle is not a participant match")
	func subtitleOfOtherKinds() {
		let task = SearchResult(kind: .object, entityId: "o", title: "Plan", subtitle: "active", detail: "task")
		#expect(SearchRanking.tier(of: task, query: "active") == 3)
	}

	@Test("inside a tier an unread chat comes before a read one, whatever the dates")
	func unreadFirst() {
		var unread = chat("unread", "Magnus old", at: Date(timeIntervalSince1970: 100))
		unread.isUnread = true
		let read = chat("read", "Magnus new", at: Date(timeIntervalSince1970: 900))
		#expect(SearchRanking.ordered([read, unread], query: "magnus").map(\.entityId) == ["unread", "read"])
	}

	@Test("inside a tier chats and flows go newest first")
	func recency() {
		let old = chat("old", "Magnus notes", at: Date(timeIntervalSince1970: 100))
		let new = chat("new", "Magnus plan", at: Date(timeIntervalSince1970: 900))
		let none = chat("none", "Magnus misc")
		let ordered = SearchRanking.ordered([old, none, new], query: "magnus")
		#expect(ordered.map(\.entityId) == ["new", "old", "none"])
	}

	@Test("objects keep the order their source gave, even when dates differ")
	func sourceOrderKept() {
		var a = object("a", "Launch A")
		a.updatedAt = Date(timeIntervalSince1970: 100)
		var b = object("b", "Launch B")
		b.updatedAt = Date(timeIntervalSince1970: 900)
		let ordered = SearchRanking.ordered([a, b], query: "launch")
		#expect(ordered.map(\.entityId) == ["a", "b"])
	}

	@Test("groups keep their display order and tiers apply inside each group")
	func groupsKeepOrder() {
		let mixed = [
			object("o2", "Plan"), object("o1", "Launch plan"), agent("a1", "Launch bot"),
			chat("c2", "Zed", snippet: "launch"), chat("c1", "Launch chat"),
		]
		let ordered = SearchRanking.ordered(mixed, query: "launch")
		#expect(ordered.map(\.id) == ["chat:c1", "chat:c2", "agent:a1", "object:o1", "object:o2"])
	}

	@Test("inside a tier a result opened before comes first, even when another is newer")
	func opensBoostInsideTier() {
		let old = chat("old", "Plan alpha", at: Date(timeIntervalSince1970: 100))
		let new = chat("new", "Plan bravo", at: Date(timeIntervalSince1970: 900))
		#expect(SearchRanking.ordered([new, old], query: "plan").map(\.entityId) == ["new", "old"])
		let boosted = SearchRanking.ordered([new, old], query: "plan", bonuses: ["old": 100])
		#expect(boosted.map(\.entityId) == ["old", "new"])
		let twice = SearchRanking.ordered([new, old], query: "plan", bonuses: ["old": 50, "new": 100])
		#expect(twice.map(\.entityId) == ["new", "old"], "the bigger bonus leads")
	}

	@Test("a bonus never lifts a result over a better match tier")
	func opensNeverBeatTier() {
		let titled = chat("title", "Plan room")
		let previewOnly = chat("prev", "Roadmap", snippet: "plan")
		let ordered = SearchRanking.ordered([previewOnly, titled], query: "plan", bonuses: ["prev": 150])
		#expect(ordered.map(\.entityId) == ["title", "prev"])
	}
}
