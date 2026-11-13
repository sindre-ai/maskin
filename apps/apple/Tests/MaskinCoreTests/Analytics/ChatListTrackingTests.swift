import Foundation
import Testing

@testable import MaskinCore

private let cal: Calendar = {
	var c = Calendar(identifier: .gregorian)
	c.timeZone = TimeZone(secondsFromGMT: 0)!
	return c
}()

/// Noon UTC on a fixed day.
private let now = Date(timeIntervalSince1970: Double(1_790_000_000 - 1_790_000_000 % 86_400 + 12 * 3600))

private func ago(hours: Double) -> Date { now.addingTimeInterval(-hours * 3600) }

private func layout(_ conversations: [ConversationSummary], query: String = "") -> TeamLayout {
	TeamLayout.build(
		TeamLayout.Input(conversations: conversations, query: query, currentActorID: "me", now: now, calendar: cal))
}

@MainActor
private final class RecordingSink: AnalyticsSink {
	var events: [(name: String, properties: AnalyticsProperties)] = []
	func start() {}
	func identify(_ distinctId: String) {}
	func group(type: String, key: String) {}
	func capture(_ event: String, properties: AnalyticsProperties) {
		events.append((event, properties))
	}
	func reset() {}
	func stop() {}
}

@Suite("ChatListTracking")
struct ChatListTrackingTests {
	@Test("a pinned tile, an unread row and a dated row read as pinned, unread and recent")
	func sections() {
		let list = layout([
			chatConvo("pin", last: ago(hours: 1), pinned: true, unread: 2),
			chatConvo("un", last: ago(hours: 2), unread: 1),
			chatConvo("read", last: ago(hours: 3)),
		])
		#expect(
			list.chatListPlace(of: "pin", searching: false) == ChatListTracking.Place(source: .list, section: .pinned, position: 1))
		#expect(
			list.chatListPlace(of: "un", searching: false) == ChatListTracking.Place(source: .list, section: .unread, position: 2))
		#expect(
			list.chatListPlace(of: "read", searching: false) == ChatListTracking.Place(source: .list, section: .recent, position: 3))
		#expect(list.chatListPlace(of: "missing", searching: false) == nil)
	}

	@Test("while a search is on, any row opened is a search open")
	func searching() {
		let list = layout([chatConvo("a", last: ago(hours: 1)), chatConvo("b", last: ago(hours: 2))], query: "chat")
		let place = list.chatListPlace(of: "b", searching: true)
		#expect(place?.source == .search)
		#expect(place?.section == .search)
		#expect(place.map { [1, 2].contains($0.position) } == true)
	}

	@Test("a hit of the server search is a search open at its place among the hits, loaded or not")
	func serverSearchHit() {
		let hits = [ChatSearchHit(id: "old", title: "Old"), ChatSearchHit(id: "new", title: "New", archived: true)]
		#expect(
			ChatListTracking.searchPlace(of: "new", among: hits)
				== ChatListTracking.Place(source: .search, section: .search, position: 2))
		#expect(ChatListTracking.searchPlace(of: "gone", among: hits) == nil)
	}

	@Test("positions and result counts fall into buckets at their edges")
	func buckets() {
		#expect([1, 2, 3, 4, 10, 11, 25, 26].map(ChatListTracking.positionBucket) == [
			"1", "2_3", "2_3", "4_10", "4_10", "11_25", "11_25", "26_plus",
		])
		#expect([0, 1, 2, 5, 6, 20, 21].map(ChatListTracking.resultCountBucket) == [
			"0", "1", "2_5", "2_5", "6_20", "6_20", "21_plus",
		])
	}

	@MainActor
	@Test("the events carry categories only, in the chats feature area, and nothing without consent")
	func events() {
		let storage = InMemoryAnalyticsStorage()
		let sink = RecordingSink()
		let analytics = Analytics()
		analytics.configure(sink: sink, storage: storage)
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		analytics.chatOpenedFromList(.init(source: .list, section: .unread, position: 7))
		#expect(sink.events.isEmpty, "no consent yet")

		analytics.setConsent(true)
		sink.events.removeAll()
		analytics.chatOpenedFromList(.init(source: .list, section: .unread, position: 7))
		analytics.chatListSearchUsed(resultCount: 0)

		#expect(sink.events.map(\.name) == ["chat_opened_from_list", "chat_list_search_used"])
		let opened = sink.events[0].properties
		#expect(opened["source"] == "list")
		#expect(opened["section"] == "unread")
		#expect(opened["position_bucket"] == "4_10")
		#expect(opened["feature_area"] == "chats")
		#expect(opened["surface"] == "iphone")
		let searched = sink.events[1].properties
		#expect(searched["result_count_bucket"] == "0")
		#expect(searched["feature_area"] == "chats")
	}
}
