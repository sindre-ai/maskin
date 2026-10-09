import Foundation
import Testing

@testable import MaskinCore

private func message(_ id: Int, kind: String = "message") -> ChatMessage {
	ChatMessage(
		id: "m\(id)", serverID: id, conversationID: "c", actorID: "a", actorName: "Forge",
		author: .agent, kind: kind, content: "text \(id)")
}

private func convo(
	_ id: String, unread: Int = 0, archived: Bool = false, minutesAgo: Double
) -> ConversationSummary {
	ConversationSummary(
		id: id, title: id, lastMessageAt: Date(timeIntervalSinceNow: -minutesAgo * 60),
		archived: archived, unreadCount: unread)
}

@Suite("WatchChat")
struct WatchChatTests {
	@Test("recent keeps the newest messages, oldest first")
	func recentKeepsNewest() {
		let all = (1...10).map { message($0) }
		#expect(WatchChat.recent(all, limit: 3).map(\.serverID) == [8, 9, 10])
	}

	@Test("recent drops system dividers before it cuts")
	func recentDropsDividers() {
		let all = [message(1), message(2), message(3, kind: "system"), message(4, kind: "system")]
		#expect(WatchChat.recent(all, limit: 2).map(\.serverID) == [1, 2])
	}

	@Test("recent with a zero or negative limit is empty, not a crash")
	func recentEmpty() {
		#expect(WatchChat.recent([message(1)], limit: 0).isEmpty)
		#expect(WatchChat.recent([message(1)], limit: -3).isEmpty)
	}

	@Test("glance puts unread first, then recency, and never archived")
	func glanceOrdering() {
		let list = [
			convo("old-read", minutesAgo: 600), convo("new-read", minutesAgo: 5),
			convo("old-unread", unread: 2, minutesAgo: 300), convo("gone", archived: true, minutesAgo: 1),
			convo("new-unread", unread: 1, minutesAgo: 10),
		]
		#expect(
			WatchChat.glance(list).map(\.id) == ["new-unread", "old-unread", "new-read", "old-read"])
	}

	@Test("glance is capped")
	func glanceCap() {
		let list = (0..<30).map { convo("c\($0)", minutesAgo: Double($0)) }
		#expect(WatchChat.glance(list, limit: 12).count == 12)
	}

	@Test("every quick reply is short enough for a wrist button")
	func quickRepliesAreShort() {
		#expect(WatchChat.quickReplies.allSatisfy { !$0.isEmpty && $0.count <= 12 })
	}
}
