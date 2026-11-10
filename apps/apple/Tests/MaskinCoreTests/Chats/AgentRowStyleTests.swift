import Foundation
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
				== .init(bubble: false, header: false, nameLabel: false, time: true))
		#expect(
			AgentRowStyle.row(author: .human, showsAuthor: true, namesAgent: true)
				== .init(bubble: true, header: true, nameLabel: false, time: false))
		#expect(
			AgentRowStyle.row(author: .human, showsAuthor: false, namesAgent: false)
				== .init(bubble: true, header: false, nameLabel: false, time: false))
	}

	@Test("an agent's time sits under the last message of a run, never on the others or on a person's")
	func timeUnderRunEnd() {
		#expect(AgentRowStyle.row(author: .agent, showsAuthor: true, namesAgent: false, endsRun: true).time)
		#expect(!AgentRowStyle.row(author: .agent, showsAuthor: true, namesAgent: false, endsRun: false).time)
		#expect(!AgentRowStyle.row(author: .human, showsAuthor: true, namesAgent: false, endsRun: true).time)
	}

	@Test("the name label is on the first message of a run, and only where agents are named")
	func nameLabel() {
		#expect(AgentRowStyle.row(author: .agent, showsAuthor: true, namesAgent: true).nameLabel)
		#expect(!AgentRowStyle.row(author: .agent, showsAuthor: false, namesAgent: true).nameLabel)
		#expect(!AgentRowStyle.row(author: .agent, showsAuthor: true, namesAgent: false).nameLabel)
	}

	@Test("a streaming reply matches the message it becomes everywhere above the words")
	func streamingMatchesFinished() {
		for names in [false, true] {
			let streaming = AgentRowStyle.streamingRow(namesAgent: names)
			let finished = AgentRowStyle.row(author: .agent, showsAuthor: true, namesAgent: names, endsRun: true)
			#expect(streaming.bubble == finished.bubble)
			#expect(streaming.header == finished.header)
			#expect(streaming.nameLabel == finished.nameLabel)
			// Only the time, below the words, is added once the message lands.
			#expect(!streaming.time && finished.time)
		}
	}

	@Test("VoiceOver hears who wrote an agent's words and when, in one label")
	func spokenSender() {
		let noon = Date(timeIntervalSince1970: 1_794_228_300)  // 9 Nov 2026, 12:45 UTC
		let said = AgentRowStyle.spokenSender(
			name: "Relay", date: noon, locale: Locale(identifier: "en_GB"), timeZone: TimeZone(identifier: "UTC")!)
		#expect(said.hasPrefix("Relay, "))
		#expect(said.contains("12:45"))
		#expect(AgentRowStyle.spokenSender(name: "Relay", date: nil) == "Relay")
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
