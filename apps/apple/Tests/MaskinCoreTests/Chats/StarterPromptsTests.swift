import Foundation
import Testing

@testable import MaskinCore

/// An agent's own openers: read the way the web reads them (`normalizeStarterPrompts`), offered
/// only in a chat with that one agent, never from a stand-in list.
@Suite("StarterPrompts")
@MainActor
struct StarterPromptsTests {
	private let relayWithStarters = ChatActor(
		participant: chatRelay, starterPrompts: ["What needs me today?", "Summarise the open decisions"])

	@Test("reads trimmed, de-duplicated case-insensitively with the first spelling, capped at four")
	func normalizes() {
		#expect(StarterPrompts.normalize(["  Hello  ", "hello", "World"]) == ["Hello", "World"])
		#expect(StarterPrompts.normalize(["a", "b", "c", "d", "e"]) == ["a", "b", "c", "d"])
	}

	@Test("drops what could not be sent as written")
	func dropsUnsendable() {
		let tooLong = String(repeating: "x", count: StarterPrompts.maxLength + 1)
		#expect(StarterPrompts.normalize(["ok", "", "   ", "two\nlines", "tab\there", tooLong]) == ["ok"])
		let exactly = String(repeating: "x", count: StarterPrompts.maxLength)
		#expect(StarterPrompts.normalize([exactly]) == [exactly])
	}

	@Test("a missing or empty list is no prompts")
	func none() {
		#expect(StarterPrompts.normalize(nil).isEmpty)
		#expect(StarterPrompts.normalize([]).isEmpty)
	}

	@Test("a chat with just one agent offers that agent's prompts")
	func oneAgent() {
		#expect(
			StarterPrompts.forChat(others: [chatRelay], actors: [relayWithStarters])
				== ["What needs me today?", "Summarise the open decisions"])
	}

	@Test("an agent that set none offers none, with no stand-in list")
	func agentWithNone() {
		#expect(StarterPrompts.forChat(others: [chatRelay], actors: [ChatActor(participant: chatRelay)]).isEmpty)
		#expect(StarterPrompts.forChat(others: [chatRelay], actors: []).isEmpty)
	}

	@Test("nobody's openers fit a person, a group, or an empty chat")
	func notOneAgent() {
		#expect(StarterPrompts.forChat(others: [chatSam], actors: [relayWithStarters]).isEmpty)
		#expect(StarterPrompts.forChat(others: [chatRelay, chatSam], actors: [relayWithStarters]).isEmpty)
		#expect(StarterPrompts.forChat(others: [], actors: [relayWithStarters]).isEmpty)
	}

	@Test("an open thread offers the one agent's prompts once the workspace actors are loaded")
	func threadStore() async {
		let h = ChatHarness(detail: chatConvo("c1", participants: [chatMe, chatRelay]))
		await h.api.setActors([relayWithStarters])
		await h.store.start()
		await h.store.refreshAgentStates()
		#expect(h.store.starterPrompts == ["What needs me today?", "Summarise the open decisions"])
	}

	@Test("an open group thread offers none")
	func threadStoreGroup() async {
		let h = ChatHarness(detail: chatConvo("c1", participants: [chatMe, chatRelay, chatSam]))
		await h.api.setActors([relayWithStarters])
		await h.store.start()
		await h.store.refreshAgentStates()
		#expect(h.store.starterPrompts.isEmpty)
	}
}
