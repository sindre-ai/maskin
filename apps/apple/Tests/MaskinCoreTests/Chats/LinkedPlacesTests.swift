import Foundation
import Testing

@testable import MaskinCore

/// Scripted `LinkedPlacesRemote`: answers per id, counts calls.
final class FakePlaces: LinkedPlacesRemote, @unchecked Sendable {
	private let lock = NSLock()
	private var _agents: [String: LinkedAgent?] = [:]
	private var _chats: [String: LinkedChat?] = [:]
	private var _calls: [String] = []
	var fails = false

	func set(agent: LinkedAgent?, for id: String) { lock.withLock { _agents[id] = .some(agent) } }
	func set(chat: LinkedChat?, for id: String) { lock.withLock { _chats[id] = .some(chat) } }
	var calls: [String] { lock.withLock { _calls } }

	func agent(id: String) async throws -> LinkedAgent? {
		lock.withLock { _calls.append("agent:\(id)") }
		if fails { throw AgentsError("down") }
		return lock.withLock { _agents[id] ?? nil }
	}

	func chat(id: String) async throws -> LinkedChat? {
		lock.withLock { _calls.append("chat:\(id)") }
		if fails { throw ChatsError("down") }
		return lock.withLock { _chats[id] ?? nil }
	}
}

@MainActor
@Suite("Linked agents and chats")
struct LinkedPlacesTests {
	let agentID = "11111111-2222-3333-4444-555555555555"
	let personID = "22222222-2222-3333-4444-555555555555"
	let chatID = "33333333-2222-3333-4444-555555555555"
	let hiddenID = "44444444-2222-3333-4444-555555555555"

	private func make(_ places: FakePlaces) -> LinkedItemStore {
		LinkedItemStore(
			objects: FakeDraftsRemote(), files: FakeLinkedFiles(), places: places, workspaceID: { "ws-1" }, retryAfter: 0.01)
	}

	private func agent(working: Bool?) -> LinkedAgent {
		LinkedAgent(
			target: LinkedTarget(kind: .agent, uuid: agentID), name: "Developer", summary: "Writes and ships code.",
			isWorking: working, lastActive: Date(timeIntervalSince1970: 1_790_000_000), skillCount: 7)
	}

	private func chat(pinned: Bool = false, archived: Bool = false) -> LinkedChat {
		LinkedChat(
			target: LinkedTarget(kind: .chat, uuid: chatID), title: "Launch plan", isPinned: pinned, isArchived: archived,
			lastAuthorID: "a1", lastAuthorName: "Relay", lastAuthorIsAgent: true, lastText: "Shipping on Friday.",
			people: ["Sam", "Relay", "Ada", "Bo", "Cy"], updatedAt: Date(timeIntervalSince1970: 1_790_000_000))
	}

	@Test("an agent resolves to a card, looked up once however many views ask")
	func agentResolves() async {
		let places = FakePlaces()
		places.set(agent: agent(working: true), for: agentID)
		let store = make(places)
		let target = LinkedTarget(kind: .agent, uuid: agentID)
		await store.resolve([target, target])
		#expect(store.item(for: target) == .agent(agent(working: true)))
		#expect(store.isCard(target))
		#expect(places.calls == ["agent:\(agentID)"])
	}

	@Test("a person at an agent address stays a plain link: no card, and not asked again")
	func personStaysLink() async {
		let places = FakePlaces()
		places.set(agent: nil, for: personID)
		let store = make(places)
		let target = LinkedTarget(kind: .agent, uuid: personID)
		await store.resolve([target])
		#expect(store.state(for: target) == .unavailable)
		#expect(!store.showsCard(target))
		await store.resolve([target])
		#expect(places.calls.count == 1)
	}

	@Test("a chat you are in is a card; one you are not in, or a deleted one, reads the same")
	func chatAndNotAvailable() async {
		let places = FakePlaces()
		places.set(chat: chat(), for: chatID)
		places.set(chat: nil, for: hiddenID)
		let store = make(places)
		let open = LinkedTarget(kind: .chat, uuid: chatID)
		let hidden = LinkedTarget(kind: .chat, uuid: hiddenID)
		let missing = LinkedTarget(kind: .chat, uuid: "55555555-2222-3333-4444-555555555555")
		await store.resolve([open, hidden, missing])
		#expect(store.item(for: open) == .chat(chat()))
		#expect(store.item(for: hidden) == .chatUnavailable(hidden))
		#expect(store.item(for: missing) == .chatUnavailable(missing))
		#expect(store.isCard(hidden))
	}

	@Test("a lookup that fails leaves the link as text and is tried again later")
	func failureRetries() async {
		let places = FakePlaces()
		places.set(chat: chat(), for: chatID)
		places.fails = true
		let store = make(places)
		let target = LinkedTarget(kind: .chat, uuid: chatID)
		await store.resolve([target])
		#expect(store.state(for: target) == .unavailable)
		#expect(store.hasFailed([target]))
		places.fails = false
		try? await Task.sleep(for: .milliseconds(30))
		await store.resolve([target])
		#expect(store.item(for: target) == .chat(chat()))
	}

	@Test("without a places source an agent or chat link stays text")
	func noSource() async {
		let store = LinkedItemStore(objects: FakeDraftsRemote(), files: FakeLinkedFiles(), workspaceID: { "ws-1" })
		let target = LinkedTarget(kind: .chat, uuid: chatID)
		await store.resolve([target])
		#expect(store.state(for: target) == .unavailable)
	}

	@Test("a chat's summary is Author: words, its badge Pinned or Archived, its people the first three and a count")
	func chatWords() {
		#expect(chat().summary == "Relay: Shipping on Friday.")
		#expect(chat().badge == nil)
		#expect(chat(pinned: true).badge == "Pinned")
		#expect(chat(archived: true).badge == "Archived")
		#expect(chat(pinned: true, archived: true).badge == "Pinned")
		#expect(chat().peopleLine == "Sam, Relay, Ada +2")
		let empty = LinkedChat(target: LinkedTarget(kind: .chat, uuid: chatID), title: " ")
		#expect(empty.summary == nil && empty.peopleLine == nil && empty.displayTitle == "Untitled chat")
		#expect(LinkedChat.line(from: "**Done**\n\n- shipped [it](https://x.io)") == "Done shipped it")
	}
}
