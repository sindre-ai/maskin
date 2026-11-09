import Testing

@testable import MaskinCore

@Suite("AgentRowStyle")
struct AgentRowStyleTests {
	private let me = ChatParticipant(id: "me", name: "Sebastian", kind: .human)
	private let relay = ChatParticipant(id: "relay", name: "Relay", kind: .agent)
	private let forge = ChatParticipant(id: "forge", name: "Forge", kind: .agent)

	@Test("a one-to-one chat does not name the agent")
	func direct() {
		#expect(!AgentRowStyle.namesAgents(participants: [me, relay], currentActorID: "me"))
	}

	@Test("a chat with two agents names each one")
	func group() {
		#expect(AgentRowStyle.namesAgents(participants: [me, relay, forge], currentActorID: "me"))
	}

	@Test("you alone, or an unknown viewer with one other party, is not a group")
	func edges() {
		#expect(!AgentRowStyle.namesAgents(participants: [me], currentActorID: "me"))
		#expect(!AgentRowStyle.namesAgents(participants: [relay], currentActorID: nil))
	}
}
