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

	// The vectors below mirror packages/shared/src/__tests__/starter-prompts.test.ts. Swift's own
	// trim and case folding differ from JavaScript's, so each is pinned to the JavaScript result.

	@Test("trims what JavaScript trims: U+FEFF, no-break space, line separators")
	func trimsLikeJavaScript() {
		#expect(StarterPrompts.normalize(["\u{FEFF}Hi\u{FEFF}"]) == ["Hi"])
		#expect(StarterPrompts.normalize(["\u{00A0}Hi\u{00A0}"]) == ["Hi"])
		#expect(StarterPrompts.normalize(["\u{2028}Hi\u{2029}"]) == ["Hi"])
		#expect(StarterPrompts.normalize(["\u{3000}Hi\u{3000}"]) == ["Hi"])
	}

	@Test("U+0085 is a control character: not trimmed, the entry is dropped")
	func nextLineIsDropped() {
		#expect(StarterPrompts.normalize(["\u{0085}Hi", "Ok"]) == ["Ok"])
		#expect(StarterPrompts.normalize(["one\u{2028}two", "fine"]) == ["fine"])
	}

	@Test("a repeat is found the way JavaScript finds it, final sigma and dotted capital I included")
	func foldsLikeJavaScript() {
		#expect(StarterPrompts.normalize(["ΑΣ", "ας", "Other"]) == ["ΑΣ", "Other"])
		#expect(StarterPrompts.normalize(["İstanbul", "i\u{307}stanbul"]) == ["İstanbul"])
		#expect(StarterPrompts.normalize(["Straße", "STRASSE"]) == ["Straße", "STRASSE"])
	}

	@Test("length is in UTF-16 units, so an emoji counts as two")
	func lengthInUTF16() {
		let thirty = String(repeating: "😀", count: 30)
		#expect(StarterPrompts.normalize([thirty]) == [thirty])
		#expect(StarterPrompts.normalize([String(repeating: "😀", count: 31)]).isEmpty)
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
		// Nothing is offered before the workspace actors are loaded: the chips are read from that
		// list, so they cannot appear ahead of it (the empty thread also waits for the server).
		#expect(h.store.workspaceActors.isEmpty)
		#expect(h.store.starterPrompts.isEmpty)
		await h.store.start()
		await h.store.refreshAgentStates()
		#expect(h.store.workspaceActors.count == 1)
		#expect(h.store.starterPrompts == ["What needs me today?", "Summarise the open decisions"])
	}

	@Test("a starter goes after what is typed, one space between, and an empty box takes it")
	func insertingKeepsTheDraft() {
		#expect(StarterPrompts.inserting("What needs me today?", into: "") == "What needs me today?")
		#expect(StarterPrompts.inserting("What needs me today?", into: "   ") == "What needs me today?")
		#expect(
			StarterPrompts.inserting("What needs me today?", into: "Quick one:")
				== "Quick one: What needs me today?")
		#expect(
			StarterPrompts.inserting("What needs me today?", into: "Quick one:   \n")
				== "Quick one: What needs me today?")
	}

	@Test("tapping a starter in the composer keeps the typed text and asks for focus")
	func composerKeepsTheDraft() {
		let model = ChatComposerModel(uploader: nil, selfActorID: "me")
		model.text = "Quick one:"
		let before = model.focusRequest
		model.addStarter("What needs me today?")
		#expect(model.text == "Quick one: What needs me today?")
		#expect(model.focusRequest == before + 1)
	}

	@Test("tapping a starter in an empty composer fills it and asks for focus")
	func composerTakesTheStarter() {
		let model = ChatComposerModel(uploader: nil, selfActorID: "me")
		let before = model.focusRequest
		model.addStarter("What needs me today?")
		#expect(model.text == "What needs me today?")
		#expect(model.focusRequest == before + 1)
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
