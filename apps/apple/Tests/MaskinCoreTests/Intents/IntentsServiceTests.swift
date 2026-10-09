import Foundation
import Testing

@testable import MaskinCore

// MARK: - Stubs

final class StubIntentsBackend: IntentsBackend, @unchecked Sendable {
	private let lock = NSLock()
	var agentRows: [IntentAgent] = []
	var conversationRows: [ConversationSummary] = []
	var error: (any Error)?
	/// Fails only the conversation listing, so a test can prove nothing falls back to creating.
	var listError: (any Error)?
	var started: [(agent: String, title: String, message: String, key: String)] = []
	var runs: [(agent: String, prompt: String?)] = []

	func agents() async throws -> [IntentAgent] {
		try lock.withLock {
			if let error { throw error }
			return agentRows
		}
	}
	func conversations(offset: Int) async throws -> [ConversationSummary] {
		try lock.withLock {
			if let error { throw error }
			if let listError { throw listError }
			return Array(conversationRows.dropFirst(offset).prefix(ChatLimits.maxConversationsPage))
		}
	}
	func startConversation(agentID: String, title: String, message: String, idempotencyKey: String)
		async throws -> ConversationSummary
	{
		try lock.withLock {
			if let error { throw error }
			started.append((agentID, title, message, idempotencyKey))
			return ConversationSummary(
				id: "new-convo", title: title,
				participants: [
					ChatParticipant(id: "me", name: "Me", kind: .human),
					ChatParticipant(id: agentID, name: title, kind: .agent),
				])
		}
	}
	func run(agentID: String, prompt: String?, idempotencyKey: String) async throws {
		try lock.withLock {
			if let error { throw error }
			runs.append((agentID, prompt))
		}
	}
}

final class StubIntentsQueue: IntentsMessageQueueing, @unchecked Sendable {
	private let lock = NSLock()
	var sent: [(conversation: String, content: String)] = []
	var fails = false
	func enqueue(conversationID: String, content: String) async throws {
		try lock.withLock {
			if fails { throw ChatsError("disk full") }
			sent.append((conversationID, content))
		}
	}
}

final class StubIntentsMemory: IntentsMemoryStoring, @unchecked Sendable {
	private let lock = NSLock()
	var stored: [IntentScope: IntentsMemory] = [:]
	var cleared = 0
	func load(_ scope: IntentScope) -> IntentsMemory { lock.withLock { stored[scope] ?? IntentsMemory() } }
	func save(_ memory: IntentsMemory, for scope: IntentScope) { lock.withLock { stored[scope] = memory } }
	func clear() { lock.withLock { stored = [:]; cleared += 1 } }
}

final class StubIntentsIndex: IntentsIndexing, @unchecked Sendable {
	private let lock = NSLock()
	var indexed: [[String]] = []
	var removed = 0
	func replaceAll(with agents: [IntentAgent], workspaceId: String) async {
		lock.withLock { indexed.append(agents.map(\.name)) }
	}
	func removeAll() async { lock.withLock { removed += 1 } }
}

private let relay = IntentAgent(id: "relay", name: "Relay", role: "Triage")
private let scribe = IntentAgent(id: "scribe", name: "Scribe")
private let me = StoredSession(apiKey: "ank_x", actorId: "me", name: "Me", workspaceId: "ws1")
private let scope = IntentScope(actorId: "me", workspaceId: "ws1")

private struct Rig {
	var backend = StubIntentsBackend()
	var queue = StubIntentsQueue()
	var memory = StubIntentsMemory()
	var index = StubIntentsIndex()
	var session: StoredSession? = me
	var needs: WidgetState = .signedOut

	func service() -> IntentsService {
		let session = session
		let backend = backend
		let needs = needs
		return IntentsService(
			session: { session }, backend: { _ in backend }, queue: queue, memory: memory, index: index,
			needs: { needs }, makeKey: { "key-1" })
	}
}

private func direct(_ id: String, with agent: String, archived: Bool = false) -> ConversationSummary {
	ConversationSummary(
		id: id, title: agent, archived: archived,
		participants: [
			ChatParticipant(id: "me", name: "Me", kind: .human),
			ChatParticipant(id: agent, name: agent, kind: .agent),
		])
}

// MARK: - What needs me

@Suite struct NeedsMeSummaryTests {
	private func snapshot(count: Int, decisions: [WidgetSnapshot.Decision]) -> WidgetState {
		.content(
			WidgetSnapshot(
				actorId: "me", workspaceId: "ws1", needsCount: count, decisions: decisions, unreadCount: 0,
				updatedAt: Date()))
	}

	@Test func saysNothingNeedsYouWhenTheFeedIsEmpty() {
		let summary = NeedsMeSummary(state: snapshot(count: 0, decisions: []))
		#expect(summary.spoken == "Nothing needs you right now.")
		#expect(summary.count == 0)
	}

	@Test func namesTheTopDecisionAndItsAgent() {
		let top = WidgetSnapshot.Decision(objectId: "o1", title: "Ship the beta?", agentName: "Relay")
		let summary = NeedsMeSummary(state: snapshot(count: 1, decisions: [top]))
		#expect(summary.spoken == "One thing needs you. Relay asks: Ship the beta?")
		#expect(summary.link?.absoluteString == "maskin://ws1/objects/o1")
	}

	@Test func countsDecisionsBeyondTheOnesListed() {
		let rows = (1...3).map { WidgetSnapshot.Decision(objectId: "o\($0)", title: "Q\($0)") }
		let summary = NeedsMeSummary(state: snapshot(count: 5, decisions: rows))
		#expect(summary.spoken.hasPrefix("5 things need you. First up: Q1"))
		#expect(summary.detail.contains("…and 2 more."))
	}

	@Test func neverPrintsAnIdWhenTheAgentNameIsUnknown() {
		let top = WidgetSnapshot.Decision(objectId: "o-secret-id", title: "Pick one", agentName: nil)
		let summary = NeedsMeSummary(state: snapshot(count: 1, decisions: [top]))
		#expect(!summary.spoken.contains("o-secret-id"))
		#expect(!summary.detail.contains("o-secret-id"))
	}

	@Test func signedOutAndUnavailableGiveActionableText() {
		#expect(NeedsMeSummary(state: .signedOut).spoken.contains("sign in"))
		#expect(NeedsMeSummary(state: .unavailable).spoken.contains("couldn't reach"))
	}

	@Test func serviceDegradesAStaleSnapshotToUnavailable() async {
		let old = WidgetSnapshot(
			actorId: "me", workspaceId: "ws1", needsCount: 2, decisions: [], unreadCount: 0,
			updatedAt: Date(timeIntervalSinceNow: -30 * 86_400))
		var rig = Rig()
		rig.needs = .content(old)
		let summary = await rig.service().whatNeedsMe()
		#expect(summary.spoken.contains("couldn't reach"))
	}
}

// MARK: - Agents

@Suite struct IntentsAgentsTests {
	@Test func refreshCachesSortsAndIndexesAgents() async {
		let rig = Rig()
		rig.backend.agentRows = [scribe, relay]
		let agents = await rig.service().agents()
		#expect(agents.map(\.name) == ["Relay", "Scribe"])
		#expect(rig.memory.load(scope).agents.count == 2)
		#expect(rig.index.indexed == [["Relay", "Scribe"]])
	}

	@Test func offlineFallsBackToTheCachedList() async {
		let rig = Rig()
		rig.memory.save(IntentsMemory(agents: [relay]), for: scope)
		rig.backend.error = URLError(.notConnectedToInternet)
		let agents = await rig.service().agents()
		#expect(agents == [relay])
		#expect(rig.index.indexed.isEmpty)
	}

	@Test func lookupByIdUsesTheCacheOnly() async {
		let rig = Rig()
		rig.memory.save(IntentsMemory(agents: [relay, scribe]), for: scope)
		rig.backend.error = URLError(.notConnectedToInternet)
		let found = await rig.service().agents(ids: ["scribe", "gone"])
		#expect(found == [scribe])
	}

	@Test func searchMatchesNamesIgnoringCase() async {
		let rig = Rig()
		rig.backend.agentRows = [relay, scribe]
		let found = await rig.service().agents(matching: "  rel ")
		#expect(found == [relay])
	}

	@Test func signedOutWipesTheCacheAndTheIndex() async {
		var rig = Rig()
		rig.session = nil
		rig.memory.save(IntentsMemory(agents: [relay]), for: scope)
		let agents = await rig.service().agents()
		#expect(agents.isEmpty)
		#expect(rig.memory.cleared == 1)
		#expect(rig.index.removed == 1)
	}

	@Test func refreshDropsThreadLinksToDeletedAgents() async {
		let rig = Rig()
		rig.memory.save(IntentsMemory(agents: [relay, scribe], threads: ["relay": "c1", "gone": "c2"]), for: scope)
		rig.backend.agentRows = [relay]
		_ = await rig.service().agents()
		#expect(rig.memory.load(scope).threads == ["relay": "c1"])
	}
}

// MARK: - Ask

@Suite struct IntentsAskTests {
	@Test func queuesIntoAKnownThreadWithoutTouchingTheNetwork() async throws {
		let rig = Rig()
		rig.memory.save(IntentsMemory(agents: [relay], threads: ["relay": "c1"]), for: scope)
		rig.backend.error = URLError(.notConnectedToInternet)
		let outcome = try await rig.service().ask(agentID: "relay", message: "  status?  ")
		#expect(outcome == .queued(conversationID: "c1"))
		#expect(rig.queue.sent.count == 1)
		#expect(rig.queue.sent.first?.content == "status?")
	}

	@Test func findsTheDirectThreadAndRemembersIt() async throws {
		let rig = Rig()
		rig.memory.save(IntentsMemory(agents: [relay]), for: scope)
		rig.backend.conversationRows = [
			ConversationSummary(
				id: "group", title: "Team",
				participants: [
					ChatParticipant(id: "me", name: "Me", kind: .human),
					ChatParticipant(id: "relay", name: "Relay", kind: .agent),
					ChatParticipant(id: "sam", name: "Sam", kind: .human),
				]),
			direct("old", with: "relay", archived: true),
			direct("c9", with: "relay"),
		]
		let outcome = try await rig.service().ask(agentID: "relay", message: "hi")
		#expect(outcome == .queued(conversationID: "c9"))
		#expect(rig.memory.load(scope).threads["relay"] == "c9")
	}

	@Test func pagesPastTheFirstPageToFindTheThread() async throws {
		let rig = Rig()
		rig.memory.save(IntentsMemory(agents: [relay]), for: scope)
		let filler = (0..<ChatLimits.maxConversationsPage).map { direct("f\($0)", with: "other\($0)") }
		rig.backend.conversationRows = filler + [direct("deep", with: "relay")]
		let outcome = try await rig.service().ask(agentID: "relay", message: "hi")
		#expect(outcome == .queued(conversationID: "deep"))
		#expect(rig.backend.started.isEmpty)
	}

	@Test func aFailedThreadLookupNeverCreatesADuplicateConversation() async {
		let rig = Rig()
		rig.memory.save(IntentsMemory(agents: [relay]), for: scope)
		rig.backend.listError = URLError(.timedOut)
		await #expect(throws: IntentsError.self) {
			try await rig.service().ask(agentID: "relay", message: "hello")
		}
		#expect(rig.backend.started.isEmpty)
		#expect(rig.queue.sent.isEmpty)
	}

	@Test func startsAConversationWhenThereIsNoThread() async throws {
		let rig = Rig()
		rig.memory.save(IntentsMemory(agents: [relay]), for: scope)
		let outcome = try await rig.service().ask(agentID: "relay", message: "hello")
		#expect(outcome == .started(conversationID: "new-convo"))
		#expect(rig.backend.started.first?.message == "hello")
		#expect(rig.backend.started.first?.title == "Relay")
		#expect(rig.backend.started.first?.key == "key-1")
		#expect(rig.queue.sent.isEmpty)
		#expect(rig.memory.load(scope).threads["relay"] == "new-convo")
	}

	@Test func aFirstMessageOfflineExplainsItNeedsAConnection() async {
		let rig = Rig()
		rig.memory.save(IntentsMemory(agents: [relay]), for: scope)
		rig.backend.error = URLError(.notConnectedToInternet)
		await #expect(throws: IntentsError.self) {
			try await rig.service().ask(agentID: "relay", message: "hello")
		}
		do { _ = try await rig.service().ask(agentID: "relay", message: "hello") } catch let error as IntentsError {
			#expect(error.message.contains("needs a connection"))
			#expect(error.message.contains("Relay"))
		} catch {}
	}

	@Test func rejectsEmptyAndOversizedMessages() async {
		let rig = Rig()
		rig.memory.save(IntentsMemory(agents: [relay], threads: ["relay": "c1"]), for: scope)
		await #expect(throws: IntentsError.emptyMessage) {
			try await rig.service().ask(agentID: "relay", message: " \n ")
		}
		let long = String(repeating: "x", count: ChatLimits.maxMessageLength + 1)
		await #expect(throws: IntentsError.messageTooLong) {
			try await rig.service().ask(agentID: "relay", message: long)
		}
		#expect(rig.queue.sent.isEmpty)
	}

	@Test func signedOutAndUnknownAgentAreDistinctErrors() async {
		var rig = Rig()
		rig.memory.save(IntentsMemory(agents: [relay]), for: scope)
		await #expect(throws: IntentsError.unknownAgent) {
			try await rig.service().ask(agentID: "nobody", message: "hi")
		}
		rig.session = nil
		await #expect(throws: IntentsError.notSignedIn) {
			try await rig.service().ask(agentID: "relay", message: "hi")
		}
	}

	@Test func aQueueFailureIsReportedNotSwallowed() async {
		let rig = Rig()
		rig.queue.fails = true
		rig.memory.save(IntentsMemory(agents: [relay], threads: ["relay": "c1"]), for: scope)
		await #expect(throws: IntentsError.self) {
			try await rig.service().ask(agentID: "relay", message: "hi")
		}
	}

	@Test func threadLinkIsTheChatDeepLink() async {
		let rig = Rig()
		rig.memory.save(IntentsMemory(agents: [relay], threads: ["relay": "c1"]), for: scope)
		let link = try? await rig.service().threadLink(agentID: "relay")
		#expect(link?.url.absoluteString == "maskin://ws1/chats/c1")
		let none = try? await rig.service().threadLink(agentID: "scribe")
		#expect(none == .some(nil))
	}

	@Test func forYouLinkOpensTheWorkspaceHomeAndIsNilSignedOut() async {
		var rig = Rig()
		#expect(rig.service().forYouLink()?.url.absoluteString == "maskin://ws1")
		rig.session = nil
		#expect(rig.service().forYouLink() == nil)
	}

	@Test func threadLinkSurfacesALookupFailureInsteadOfSayingThereIsNoThread() async {
		let rig = Rig()
		rig.memory.save(IntentsMemory(agents: [relay]), for: scope)
		rig.backend.listError = URLError(.notConnectedToInternet)
		await #expect(throws: IntentsError.self) {
			_ = try await rig.service().threadLink(agentID: "relay")
		}
	}

	@Test func wipeClearsTheCacheAndTheIndexWithoutASession() async {
		var rig = Rig()
		rig.session = nil
		await rig.service().wipe()
		#expect(rig.memory.cleared == 1)
		#expect(rig.index.removed == 1)
	}
}

// MARK: - Run

@Suite struct IntentsRunTests {
	@Test func runsWithATrimmedPromptOrNone() async throws {
		let rig = Rig()
		try await rig.service().run(agentID: "relay", prompt: "  triage inbox ")
		try await rig.service().run(agentID: "relay", prompt: "   ")
		#expect(rig.backend.runs.map(\.prompt) == ["triage inbox", nil])
	}

	@Test func offlineSaysSoByName() async {
		let rig = Rig()
		rig.memory.save(IntentsMemory(agents: [relay]), for: scope)
		rig.backend.error = URLError(.notConnectedToInternet)
		do {
			try await rig.service().run(agentID: "relay", prompt: nil)
			Issue.record("expected an error")
		} catch let error as IntentsError {
			#expect(error.message == "You're offline. Running Relay needs a connection.")
		} catch { Issue.record("wrong error \(error)") }
	}

	@Test func anAgentRefusalKeepsItsOwnReason() async {
		let rig = Rig()
		rig.backend.error = AgentsError("This agent can't run right now.")
		do {
			try await rig.service().run(agentID: "relay", prompt: nil)
			Issue.record("expected an error")
		} catch let error as IntentsError {
			#expect(error.message == "This agent can't run right now.")
		} catch { Issue.record("wrong error \(error)") }
	}
}

// MARK: - Spotlight + memory

@Suite struct SpotlightAgentLinkTests {
	@Test func roundTripsAnAgentId() {
		let id = SpotlightAgentLink.identifier(agentID: "agent_1")
		#expect(SpotlightAgentLink.agentID(fromIdentifier: id) == "agent_1")
	}

	@Test func rejectsForeignAndHostileIdentifiers() {
		#expect(SpotlightAgentLink.agentID(fromIdentifier: "note:1") == nil)
		#expect(SpotlightAgentLink.agentID(fromIdentifier: "agent:../x") == nil)
		#expect(SpotlightAgentLink.agentID(fromIdentifier: "agent:") == nil)
	}
}

@Suite struct FileIntentsMemoryTests {
	private func temp() -> URL {
		FileManager.default.temporaryDirectory.appendingPathComponent("intents-\(UUID().uuidString).json")
	}

	@Test func isolatesScopesAndSurvivesReload() {
		let url = temp()
		defer { try? FileManager.default.removeItem(at: url) }
		let store = FileIntentsMemory(fileURL: url)
		store.save(IntentsMemory(agents: [relay], threads: ["relay": "c1"]), for: scope)
		let reopened = FileIntentsMemory(fileURL: url)
		#expect(reopened.load(scope).threads["relay"] == "c1")
		#expect(reopened.load(IntentScope(actorId: "other", workspaceId: "ws1")) == IntentsMemory())
		#expect(reopened.load(IntentScope(actorId: "me", workspaceId: "ws2")) == IntentsMemory())
	}

	@Test func clearForgetsEverything() {
		let url = temp()
		let store = FileIntentsMemory(fileURL: url)
		store.save(IntentsMemory(agents: [relay]), for: scope)
		store.clear()
		#expect(store.load(scope) == IntentsMemory())
	}
}
