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

	@Test("title matches come first, then participants, then preview text")
	func tiers() {
		let ordered = SearchRanking.ordered([previewOnly, participantOnly, titled], query: "magnus")
		#expect(ordered.map(\.entityId) == ["title", "part", "prev"])
	}

	@Test("tier is read from the title, then the chat's participants, then anything else")
	func tierOf() {
		#expect(SearchRanking.tier(of: titled, query: "Magnus") == .title)
		#expect(SearchRanking.tier(of: participantOnly, query: "Magnus") == .participants)
		#expect(SearchRanking.tier(of: previewOnly, query: "Magnus") == .preview)
		#expect(SearchRanking.tier(of: titled, query: "  ") == .title, "no words: everything ranks alike")
	}

	@Test("a status or file type in the subtitle is not a participant match")
	func subtitleOfOtherKinds() {
		let task = SearchResult(kind: .object, entityId: "o", title: "Plan", subtitle: "active", detail: "task")
		#expect(SearchRanking.tier(of: task, query: "active") == .preview)
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
}
