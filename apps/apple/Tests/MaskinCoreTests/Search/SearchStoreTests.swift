import Foundation
import Testing

@testable import MaskinCore

actor FakeSearchRemote: SearchRemote {
	var objectsHandler: @Sendable (String) async throws -> [SearchResult] = { _ in [] }
	var filesHandler: @Sendable (String) async throws -> [SearchResult] = { _ in [] }
	var chats: Result<[SearchResult], SearchError> = .success([])
	var agentList: Result<[SearchResult], SearchError> = .success([])
	private(set) var objectQueries: [String] = []
	private(set) var conversationCalls = 0

	func setObjects(_ h: @escaping @Sendable (String) async throws -> [SearchResult]) { objectsHandler = h }
	func setFiles(_ h: @escaping @Sendable (String) async throws -> [SearchResult]) { filesHandler = h }
	func setChats(_ r: Result<[SearchResult], SearchError>) { chats = r }
	func setAgents(_ r: Result<[SearchResult], SearchError>) { agentList = r }

	func searchObjects(query: String, limit: Int) async throws -> [SearchResult] {
		objectQueries.append(query)
		#expect(limit <= ServerLimits.maxPageSize)
		return try await objectsHandler(query)
	}
	func searchFiles(query: String, limit: Int) async throws -> [SearchResult] {
		#expect(limit <= ServerLimits.maxPageSize)
		return try await filesHandler(query)
	}
	func conversations() async throws -> [SearchResult] {
		conversationCalls += 1
		return try chats.get()
	}
	func agents() async throws -> [SearchResult] { try agentList.get() }
}

func object(_ id: String, _ title: String) -> SearchResult {
	SearchResult(kind: .object, entityId: id, title: title, subtitle: "active", detail: "task")
}
func chat(_ id: String, _ title: String, people: String = "") -> SearchResult {
	SearchResult(kind: .chat, entityId: id, title: title, subtitle: people)
}
func agent(_ id: String, _ name: String) -> SearchResult {
	SearchResult(kind: .agent, entityId: id, title: name)
}
func file(_ id: String, _ name: String) -> SearchResult {
	SearchResult(kind: .file, entityId: id, title: name, subtitle: "Markdown", detail: "text/markdown")
}

@MainActor
func makeStore(
	_ remote: FakeSearchRemote, workspace: String? = "ws-1", debounce: Duration = .milliseconds(10)
) -> SearchStore {
	let defaults = UserDefaults(suiteName: "search-tests-\(UUID().uuidString)")!
	return SearchStore(
		remote: remote, recents: SearchRecents(defaults: defaults), workspaceId: { workspace },
		debounce: debounce)
}

@MainActor
@Suite("SearchStore")
struct SearchStoreTests {
	@Test("rapid typing fires one request for the final query")
	func debounces() async {
		let remote = FakeSearchRemote()
		let store = makeStore(remote, debounce: .milliseconds(60))
		store.setQuery("a")
		store.setQuery("ab")
		store.setQuery("abc")
		await store.settle()
		#expect(await remote.objectQueries == ["abc"])
		#expect(store.phase == .results)
	}

	@Test("a slow response for an old query never overwrites the newer one")
	func staleResponsesAreDropped() async {
		let remote = FakeSearchRemote()
		await remote.setObjects { q in
			if q == "slow" {
				try await Task.sleep(for: .milliseconds(300))
				return [object("old", "Slow result")]
			}
			return [object("new", "Fast result")]
		}
		let store = makeStore(remote)
		store.setQuery("slow")
		try? await Task.sleep(for: .milliseconds(60))  // slow request is now in flight
		store.setQuery("fast")
		await store.settle()
		try? await Task.sleep(for: .milliseconds(400))  // let the stale one finish
		#expect(store.allResults.map(\.entityId) == ["new"])
		#expect(store.query == "fast")
	}

	@Test("clearing the query returns to idle and drops results")
	func clearing() async {
		let remote = FakeSearchRemote()
		await remote.setObjects { _ in [object("1", "Hit")] }
		let store = makeStore(remote)
		store.setQuery("hit")
		await store.settle()
		#expect(!store.allResults.isEmpty)
		store.setQuery("  ")
		#expect(store.phase == .idle)
		#expect(store.allResults.isEmpty)
	}

	@Test("chats and agents are filtered on the client, case-insensitively")
	func clientSideFilter() async {
		let remote = FakeSearchRemote()
		await remote.setChats(.success([chat("c1", "Launch plan", people: "Sigrid"), chat("c2", "Standup")]))
		await remote.setAgents(.success([agent("a1", "Forge"), agent("a2", "Scout")]))
		let store = makeStore(remote)
		store.setQuery("LAUNCH")
		await store.settle()
		#expect(store.allResults.map(\.id) == ["chat:c1"])
		store.setQuery("sigrid")  // matches the participant list, not the title
		await store.settle()
		#expect(store.allResults.map(\.id) == ["chat:c1"])
		store.setQuery("for")
		await store.settle()
		#expect(store.allResults.map(\.id) == ["agent:a1"])
		#expect(await remote.conversationCalls == 1, "the chat list is fetched once, then cached")
	}

	@Test("scope narrows the visible sections without refetching")
	func scopes() async {
		let remote = FakeSearchRemote()
		await remote.setObjects { _ in [object("o1", "Plan the launch")] }
		await remote.setFiles { _ in [file("f1", "launch.md")] }
		await remote.setChats(.success([chat("c1", "Launch chat")]))
		let store = makeStore(remote)
		store.setQuery("launch")
		await store.settle()
		#expect(store.sections.map(\.group) == [.team, .objects, .files])
		#expect(store.visibleCount == 3)
		store.scope = .team
		#expect(store.sections.map(\.group) == [.team])
		store.scope = .objects
		#expect(store.sections.map(\.group) == [.objects])
		store.scope = .agents
		#expect(store.sections.isEmpty)
		#expect(await remote.objectQueries.count == 1)
	}

	@Test("type sub-chips narrow Objects by type, most frequent first, flows excluded")
	func typeChips() async {
		let remote = FakeSearchRemote()
		await remote.setObjects { _ in
			[
				SearchResult(kind: .object, entityId: "b1", title: "Launch bet", detail: "bet"),
				SearchResult(kind: .object, entityId: "t1", title: "Launch task", detail: "task"),
				SearchResult(kind: .object, entityId: "t2", title: "Launch task 2", detail: "task"),
				SearchResult(kind: .object, entityId: "l1", title: "Launch loop", detail: "loop"),
			]
		}
		let store = makeStore(remote)
		store.setQuery("launch")
		await store.settle()
		#expect(store.objectTypes == ["task", "bet"])
		store.scope = .objects
		#expect(store.visibleCount == 3)
		store.objectType = "bet"
		#expect(store.sections.flatMap(\.results).map(\.entityId) == ["b1"])
		store.scope = .flows
		#expect(store.objectType == nil, "changing scope clears the type")
		#expect(store.sections.flatMap(\.results).map(\.entityId) == ["l1"])
		#expect(store.count(in: .all) == 4)
	}

	@Test("flows come from the flow list, filtered by name, and replace the server's duplicate")
	func flowsList() async {
		struct Remote: SearchRemote {
			func searchObjects(query: String, limit: Int) async throws -> [SearchResult] {
				[SearchResult(kind: .object, entityId: "l1", title: "Weekly report", detail: "loop")]
			}
			func searchFiles(query: String, limit: Int) async throws -> [SearchResult] { [] }
			func conversations() async throws -> [SearchResult] { [] }
			func agents() async throws -> [SearchResult] { [] }
			func flows() async throws -> [SearchResult] {
				[
					SearchResult(kind: .object, entityId: "l1", title: "Weekly report", subtitle: "Supervised", detail: "loop"),
					SearchResult(kind: .object, entityId: "l2", title: "Onboarding", detail: "loop"),
				]
			}
		}
		let defaults = UserDefaults(suiteName: "search-tests-\(UUID().uuidString)")!
		let store = SearchStore(
			remote: Remote(), recents: SearchRecents(defaults: defaults), workspaceId: { "ws-1" },
			debounce: .milliseconds(10))
		store.setQuery("weekly")
		await store.settle()
		#expect(store.allResults.map(\.entityId) == ["l1"])
		#expect(store.allResults.first?.subtitle == "Supervised")
		#expect(store.allResults.first?.isFlow == true)
		store.scope = .flows
		#expect(store.sections.map(\.group) == [.flows])
	}

	@Test("the search tab offers All, Team, Objects, Flows and Agents")
	func chipOrder() {
		#expect(SearchScope.chips.map(\.title) == ["All", "Team", "Objects", "Flows", "Agents"])
	}

	@Test("one failing source still yields results and flags the list as partial")
	func partialFailure() async {
		let remote = FakeSearchRemote()
		await remote.setObjects { _ in [object("o1", "Launch")] }
		await remote.setFiles { _ in throw SearchError("boom") }
		let store = makeStore(remote)
		store.setQuery("launch")
		await store.settle()
		#expect(store.phase == .results)
		#expect(store.isPartial)
		#expect(store.allResults.count == 1)
	}

	@Test("every source failing is a failed phase, and retry recovers")
	func totalFailure() async {
		let remote = FakeSearchRemote()
		let offline = SearchError("You're offline.", isOffline: true)
		await remote.setObjects { _ in throw offline }
		await remote.setFiles { _ in throw offline }
		await remote.setChats(.failure(offline))
		await remote.setAgents(.failure(offline))
		let store = makeStore(remote)
		store.setQuery("x")
		await store.settle()
		#expect(store.phase == .failed("You're offline."))
		#expect(store.isOffline)
		await remote.setObjects { _ in [object("o1", "x marks")] }
		await store.retry()
		#expect(store.phase == .results)
		#expect(!store.isOffline)
	}

	@Test("committing remembers the query and skips the debounce")
	func commit() async {
		let remote = FakeSearchRemote()
		await remote.setObjects { _ in [object("o1", "Launch")] }
		let store = makeStore(remote, debounce: .seconds(30))
		store.setQuery("launch")
		await store.commit()
		#expect(store.phase == .results)
		#expect(store.recents == ["launch"])
	}
}

@Suite("SearchRecents")
struct SearchRecentsTests {
	private func recents() -> SearchRecents {
		SearchRecents(defaults: UserDefaults(suiteName: "recents-\(UUID().uuidString)")!)
	}

	@Test("recents are kept per workspace")
	func perWorkspace() {
		let r = recents()
		r.push("alpha", workspaceId: "ws-1")
		r.push("beta", workspaceId: "ws-2")
		#expect(r.load(workspaceId: "ws-1") == ["alpha"])
		#expect(r.load(workspaceId: "ws-2") == ["beta"])
	}

	@Test("newest first, deduplicated case-insensitively, capped")
	func orderingAndCap() {
		let r = recents()
		for q in ["a", "b", "A"] { r.push(q, workspaceId: "w") }
		#expect(r.load(workspaceId: "w") == ["A", "b"])
		for i in 0..<20 { r.push("q\(i)", workspaceId: "w") }
		#expect(r.load(workspaceId: "w").count == SearchRecents.limit)
		#expect(r.load(workspaceId: "w").first == "q19")
	}

	@Test("blank queries are ignored; remove and clear work")
	func removeAndClear() {
		let r = recents()
		r.push("   ", workspaceId: "w")
		#expect(r.load(workspaceId: "w").isEmpty)
		r.push("x", workspaceId: "w")
		r.push("y", workspaceId: "w")
		#expect(r.remove("x", workspaceId: "w") == ["y"])
		r.clear(workspaceId: "w")
		#expect(r.load(workspaceId: "w").isEmpty)
	}
}

@Suite("SearchHighlight")
struct SearchHighlightTests {
	@Test("finds every occurrence ignoring case and diacritics")
	func ranges() {
		let text = "Café cafe CAFÉ"
		#expect(SearchHighlight.ranges(of: "cafe", in: text).count == 3)
		#expect(SearchHighlight.ranges(of: "  ", in: text).isEmpty)
	}

	@Test("snippet centres on the first match and ellipsises the cut ends")
	func snippet() {
		let text = String(repeating: "lorem ", count: 40) + "needle " + String(repeating: "ipsum ", count: 40)
		let s = SearchHighlight.snippet(of: text, around: "needle", radius: 20)
		#expect(s.contains("needle"))
		#expect(s.hasPrefix("…") && s.hasSuffix("…"))
		#expect(SearchHighlight.snippet(of: "short\ntext", around: "zzz") == "short text")
	}
}

@MainActor
private final class Clock {
	var date = Date(timeIntervalSince1970: 1_000)
	func advance(_ seconds: TimeInterval) { date.addTimeInterval(seconds) }
}

@MainActor
private final class WorkspaceBox {
	var id: String? = "ws-1"
}

@MainActor
@Suite("SearchStore directory caches")
struct SearchDirectoryCacheTests {
	private func make(
		_ remote: FakeSearchRemote, workspace: WorkspaceBox, clock: Clock, ttl: TimeInterval = 60
	) -> SearchStore {
		let defaults = UserDefaults(suiteName: "search-cache-\(UUID().uuidString)")!
		return SearchStore(
			remote: remote, recents: SearchRecents(defaults: defaults), workspaceId: { workspace.id },
			debounce: .milliseconds(1), directoryTTL: ttl, now: { clock.date })
	}

	@Test("chats are re-fetched once the TTL has passed")
	func ttlRefetches() async {
		let remote = FakeSearchRemote()
		let clock = Clock()
		let store = make(remote, workspace: WorkspaceBox(), clock: clock)
		await remote.setChats(.success([chat("c1", "Roadmap")]))
		store.setQuery("road")
		await store.settle()
		store.setQuery("roadm")
		await store.settle()
		#expect(await remote.conversationCalls == 1)
		clock.advance(61)
		store.setQuery("roadma")
		await store.settle()
		#expect(await remote.conversationCalls == 2)
	}

	@Test("a workspace switch never shows the previous workspace's chats")
	func switchDropsCaches() async {
		let remote = FakeSearchRemote()
		let box = WorkspaceBox()
		let store = make(remote, workspace: box, clock: Clock())
		await remote.setChats(.success([chat("c1", "Roadmap A")]))
		store.setQuery("roadmap")
		await store.settle()
		#expect(store.allResults.contains { $0.entityId == "c1" })
		box.id = "ws-2"
		await remote.setChats(.success([chat("c2", "Roadmap B")]))
		store.setQuery("Roadmap")
		await store.settle()
		#expect(!store.allResults.contains { $0.entityId == "c1" })
		#expect(store.allResults.contains { $0.entityId == "c2" })
	}
}

@Suite("SearchRecents scoping")
struct SearchRecentsScopingTests {
	@Test("a second person in the same workspace does not see the first person's queries")
	func perActor() {
		let defaults = UserDefaults(suiteName: "recents-\(UUID().uuidString)")!
		SearchRecents(defaults: defaults, actorId: "alice").push("secret plan", workspaceId: "w")
		#expect(SearchRecents(defaults: defaults, actorId: "bob").load(workspaceId: "w").isEmpty)
		#expect(SearchRecents(defaults: defaults, actorId: "alice").load(workspaceId: "w") == ["secret plan"])
	}

	@Test("clearAll removes every person's and workspace's recents and nothing else")
	func clearAll() {
		let defaults = UserDefaults(suiteName: "recents-\(UUID().uuidString)")!
		SearchRecents(defaults: defaults, actorId: "alice").push("a", workspaceId: "w1")
		SearchRecents(defaults: defaults, actorId: "bob").push("b", workspaceId: "w2")
		defaults.set("keep", forKey: "unrelated")
		SearchRecents.clearAll(defaults: defaults)
		#expect(SearchRecents(defaults: defaults, actorId: "alice").load(workspaceId: "w1").isEmpty)
		#expect(SearchRecents(defaults: defaults, actorId: "bob").load(workspaceId: "w2").isEmpty)
		#expect(defaults.string(forKey: "unrelated") == "keep")
	}
}
