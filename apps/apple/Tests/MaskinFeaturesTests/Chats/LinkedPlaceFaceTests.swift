import Foundation
import MaskinCore
import Testing

@testable import MaskinFeatures

@Suite("Linked agent and chat faces")
struct LinkedPlaceFaceTests {
	private let agentTarget = LinkedTarget(kind: .agent, uuid: "11111111-2222-3333-4444-555555555555")
	private let chatTarget = LinkedTarget(kind: .chat, uuid: "33333333-2222-3333-4444-555555555555")

	@Test("an agent that is running reads Working now with a pulsing dot; one that is not reads Idle")
	func workingAgainstIdle() {
		let working = LinkedPlaceFace(agent: LinkedAgent(target: agentTarget, name: "Developer", isWorking: true, skillCount: 3))
		#expect(working.badge?.text == "Working now" && working.badge?.pulses == true)
		#expect(working.accessibilityName == "Agent, Working now: Developer")
		let idle = LinkedPlaceFace(agent: LinkedAgent(target: agentTarget, name: "Developer", isWorking: false))
		#expect(idle.badge?.text == "Idle" && idle.badge?.pulses == false)
	}

	@Test("an agent whose sessions could not be read has no badge and no last-active fact, never a guess")
	func unknownState() {
		let face = LinkedPlaceFace(agent: LinkedAgent(target: agentTarget, name: "Developer", isWorking: nil, skillCount: 2))
		#expect(face.badge == nil)
		#expect(face.facts.map(\.label) == ["Skills"])
		#expect(face.accessibilityName == "Agent: Developer")
	}

	@Test("an agent shows last active and skills, and the agent itself in the footer")
	func agentFacts() {
		let date = Date(timeIntervalSince1970: 1_790_000_000)
		let face = LinkedPlaceFace(
			agent: LinkedAgent(target: agentTarget, name: "Developer", isWorking: false, lastActive: date, skillCount: 7))
		#expect(face.facts.map(\.label) == ["Last active", "Skills"])
		#expect(face.facts[0].date == date && face.facts[1].text == "7")
		#expect(face.personName == "Developer" && face.personIsAgent && face.updatedAt == nil)
	}

	@Test("a chat shows its badge, people, the last author in the footer and when it was updated")
	func chatFace() {
		let date = Date(timeIntervalSince1970: 1_790_000_000)
		let chat = LinkedChat(
			target: chatTarget, title: "Launch plan", isPinned: true, lastAuthorID: "a1", lastAuthorName: "Relay",
			lastAuthorIsAgent: true, lastText: "Friday.", people: ["Sam", "Relay"], updatedAt: date)
		let face = LinkedPlaceFace(chat: chat)
		#expect(face.badge?.text == "Pinned" && face.badge?.pulses == false)
		#expect(face.summary == "Relay: Friday.")
		#expect(face.facts.map(\.label) == ["People"] && face.facts[0].text == "Sam, Relay")
		#expect(face.personName == "Relay" && face.updatedAt == date)
		#expect(face.accessibilityName == "Chat, Pinned: Launch plan")
		let plain = LinkedPlaceFace(chat: LinkedChat(target: chatTarget, title: "Launch plan"))
		#expect(plain.badge == nil && plain.accessibilityName == "Chat: Launch plan")
	}
}
