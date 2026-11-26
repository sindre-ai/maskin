import Foundation
import Testing

@testable import MaskinCore

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
