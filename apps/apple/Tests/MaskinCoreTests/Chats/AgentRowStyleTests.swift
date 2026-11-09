import Testing

@testable import MaskinCore

@Suite("AgentRowStyle")
struct AgentRowStyleTests {
	private let me = ChatParticipant(id: "me", name: "Sebastian", kind: .human)
	private let relay = ChatParticipant(id: "relay", name: "Relay", kind: .agent)
	private let forge = ChatParticipant(id: "forge", name: "Forge", kind: .agent)

	@Test("a one-to-one chat does not name the agent")
	func direct() {
		#expect(!AgentRowStyle.namesAgents(participants: [me, relay], currentActorID: "me", agentAuthorIDs: ["relay"]))
	}

	@Test("an agent's row has no bubble and no avatar header; a person's keeps both")
	func rowShape() {
		#expect(
			AgentRowStyle.row(author: .agent, showsAuthor: true, namesAgent: false)
				== .init(bubble: false, header: false, nameLabel: false))
		#expect(
			AgentRowStyle.row(author: .human, showsAuthor: true, namesAgent: true)
				== .init(bubble: true, header: true, nameLabel: false))
		#expect(
			AgentRowStyle.row(author: .human, showsAuthor: false, namesAgent: false)
				== .init(bubble: true, header: false, nameLabel: false))
	}

	@Test("the name label is on the first message of a run, and only where agents are named")
	func nameLabel() {
		#expect(AgentRowStyle.row(author: .agent, showsAuthor: true, namesAgent: true).nameLabel)
		#expect(!AgentRowStyle.row(author: .agent, showsAuthor: false, namesAgent: true).nameLabel)
		#expect(!AgentRowStyle.row(author: .agent, showsAuthor: true, namesAgent: false).nameLabel)
	}

	@Test("a streaming reply is the same shape as the message it becomes")
	func streamingMatchesFinished() {
		for names in [false, true] {
			#expect(
				AgentRowStyle.streamingRow(namesAgent: names)
					== AgentRowStyle.row(author: .agent, showsAuthor: true, namesAgent: names))
		}
	}

	@Test("a chat with two agents names each one")
	func group() {
		#expect(AgentRowStyle.namesAgents(participants: [me, relay, forge], currentActorID: "me"))
	}

	@Test("names stay until the participants have loaded")
	func notLoaded() {
		#expect(AgentRowStyle.namesAgents(participants: [], currentActorID: "me"))
		#expect(AgentRowStyle.namesAgents(participants: [], currentActorID: "me", agentAuthorIDs: ["relay"]))
	}

	@Test("an agent that spoke and then left keeps the names of a group")
	func removedAgent() {
		#expect(AgentRowStyle.namesAgents(participants: [me, relay], currentActorID: "me", agentAuthorIDs: ["relay", "forge"]))
	}

	@Test("you alone has no one to name, so names stay")
	func alone() {
		#expect(AgentRowStyle.namesAgents(participants: [me], currentActorID: "me"))
	}
}
