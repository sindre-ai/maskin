import Foundation
import Testing

@testable import MaskinCore

@Suite("ThreadSearch")
struct ThreadSearchTests {
	private let messages = [
		chatMsg(1, "Deploy the Café menu"),
		chatMsg(2, by: "relay", agent: true, "Deployed to staging"),
		chatMsg(3, "unrelated"),
	]

	@Test("matches case- and diacritic-insensitively, in order")
	func matching() {
		#expect(ThreadSearch.matches(in: messages, query: "deploy") == [messages[0].id, messages[1].id])
		#expect(ThreadSearch.matches(in: messages, query: "cafe") == [messages[0].id])
	}

	@Test("blank or unmatched queries find nothing")
	func none() {
		#expect(ThreadSearch.matches(in: messages, query: "  ").isEmpty)
		#expect(ThreadSearch.matches(in: messages, query: "zzz").isEmpty)
	}

	@Test("stepping wraps both ways and handles no matches")
	func stepping() {
		#expect(ThreadSearch.step(from: nil, by: 1, count: 3) == 0)
		#expect(ThreadSearch.step(from: nil, by: -1, count: 3) == 2)
		#expect(ThreadSearch.step(from: 2, by: 1, count: 3) == 0)
		#expect(ThreadSearch.step(from: 0, by: -1, count: 3) == 2)
		#expect(ThreadSearch.step(from: 0, by: 1, count: 0) == nil)
	}
}

@Suite("Agent filter")
@MainActor
struct AgentFilterTests {
	@Test("filters conversations by participant")
	func byAgent() {
		let other = ChatParticipant(id: "bolt", name: "Bolt", kind: .agent)
		let a = chatConvo("a", participants: [chatMe, chatRelay])
		let b = chatConvo("b", participants: [chatMe, other])
		#expect(ConversationGrouping.filter([a, b], agentID: "bolt").map(\.id) == ["b"])
		#expect(ConversationGrouping.filter([a, b], agentID: nil).count == 2)
	}
}
