import Foundation
import Testing

@testable import MaskinCore

actor FakeSearchRemote: SearchRemote {
	var serverHandler: @Sendable (String, [String]) async throws -> SearchAnswer = { _, _ in SearchAnswer(results: []) }
	var filesHandler: @Sendable (String) async throws -> [SearchResult] = { _ in [] }
	var peopleList: [SearchPerson] = []
	private(set) var serverQueries: [String] = []
	private(set) var serverParticipants: [[String]] = []

	/// What the server search answers for the words, in the order it answers.
	func setServer(_ h: @escaping @Sendable (String) async throws -> [SearchResult]) {
		serverHandler = { query, _ in SearchAnswer(results: try await h(query)) }
	}
	/// The server search with the picked people's ids and the whole answer, partial flag included.
	func setServerAnswer(_ h: @escaping @Sendable (String, [String]) async throws -> SearchAnswer) { serverHandler = h }
	func setFiles(_ h: @escaping @Sendable (String) async throws -> [SearchResult]) { filesHandler = h }
	func setPeople(_ list: [SearchPerson]) { peopleList = list }

	func search(query: String, participants: [String], limit: Int) async throws -> SearchAnswer {
		serverQueries.append(query)
		serverParticipants.append(participants)
		#expect(limit <= 150)
		return try await serverHandler(query, participants)
	}
	func searchFiles(query: String, limit: Int) async throws -> [SearchResult] {
		#expect(limit <= ServerLimits.maxPageSize)
		return try await filesHandler(query)
	}
	func people() async throws -> [SearchPerson] { peopleList }
}

func object(_ id: String, _ title: String) -> SearchResult {
	SearchResult(kind: .object, entityId: id, title: title, subtitle: "active", detail: "task")
}
func chat(
	_ id: String, _ title: String, people: String = "", snippet: String = "", at updatedAt: Date? = nil
) -> SearchResult {
	SearchResult(
		kind: .chat, entityId: id, title: title, subtitle: people, snippet: snippet, updatedAt: updatedAt)
}
func agent(_ id: String, _ name: String) -> SearchResult {
	SearchResult(kind: .agent, entityId: id, title: name)
}
func flow(_ id: String, _ title: String) -> SearchResult {
	SearchResult(kind: .object, entityId: id, title: title, subtitle: "active", detail: "loop")
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
		#expect(await remote.serverQueries == ["abc"])
		#expect(store.phase == .results)
	}

	@Test("a slow response for an old query never overwrites the newer one")
	func staleResponsesAreDropped() async {
		let remote = FakeSearchRemote()
		await remote.setServer { q in
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
		await remote.setServer { _ in [object("1", "Hit")] }
		let store = makeStore(remote)
		store.setQuery("hit")
		await store.settle()
		#expect(!store.allResults.isEmpty)
		store.setQuery("  ")
		#expect(store.phase == .idle)
		#expect(store.allResults.isEmpty)
	}

	@Test("the server's order is shown as it comes, across groups, with files last")
	func serverOrderIsKept() async {
		let remote = FakeSearchRemote()
		// A perfect agent match first, then a flow, then chats and an item: not grouped, not re-sorted.
		await remote.setServer { _ in
			[
				agent("a1", "Forge"), chat("c1", "Forge sync", at: Date(timeIntervalSince1970: 100)),
				flow("l1", "Forge release"), chat("c2", "Forge notes", at: Date(timeIntervalSince1970: 900)),
				object("o1", "Forge plan"),
			]
		}
		await remote.setFiles { _ in [file("f1", "forge.md")] }
		let store = makeStore(remote)
		store.setQuery("forge")
		await store.settle()
		#expect(store.rows.map(\.id) == ["agent:a1", "chat:c1", "object:l1", "chat:c2", "object:o1", "file:f1"])
		#expect(store.visibleCount == 6)
	}

	@Test("a chat is shown only because the server returned it, nothing is filtered on the phone")
	func noPhoneFiltering() async {
		let remote = FakeSearchRemote()
		// The words appear nowhere in this row (the server matched a message or a typo): it still shows.
		await remote.setServer { _ in [chat("c1", "Roadmap", people: "Sigrid")] }
		let store = makeStore(remote)
		store.setQuery("roadmpa")
		await store.settle()
		#expect(store.allResults.map(\.id) == ["chat:c1"])
		#expect(await remote.serverQueries == ["roadmpa"])
	}

	@Test("scope narrows the visible rows without asking again")
	func scopes() async {
		let remote = FakeSearchRemote()
		await remote.setServer { _ in [chat("c1", "Launch chat"), object("o1", "Plan the launch")] }
		await remote.setFiles { _ in [file("f1", "launch.md")] }
		let store = makeStore(remote)
		store.setQuery("launch")
		await store.settle()
		#expect(store.sections.map(\.group) == [.team, .objects, .files])
		#expect(store.rows.map(\.id) == ["chat:c1", "object:o1", "file:f1"])
		#expect(store.visibleCount == 3)
		store.scope = .team
		#expect(store.rows.map(\.id) == ["chat:c1"])
		store.scope = .objects
		#expect(store.rows.map(\.id) == ["object:o1"])
		store.scope = .agents
		#expect(store.rows.isEmpty)
		store.scope = .files
		#expect(store.rows.map(\.id) == ["file:f1"])
		#expect(await remote.serverQueries.count == 1)
	}

	@Test("type sub-chips narrow Objects by type, most frequent first, flows excluded")
	func typeChips() async {
		let remote = FakeSearchRemote()
		await remote.setServer { _ in
			[
				SearchResult(kind: .object, entityId: "b1", title: "Launch bet", detail: "bet"),
				SearchResult(kind: .object, entityId: "t1", title: "Launch task", detail: "task"),
				SearchResult(kind: .object, entityId: "t2", title: "Launch task 2", detail: "task"),
				flow("l1", "Launch loop"),
			]
		}
		let store = makeStore(remote)
		store.setQuery("launch")
		await store.settle()
		#expect(store.objectTypes == ["task", "bet"])
		store.scope = .objects
		#expect(store.visibleCount == 3)
		store.objectType = "bet"
		#expect(store.rows.map(\.entityId) == ["b1"])
		store.scope = .flows
		#expect(store.objectType == nil, "changing scope clears the type")
		#expect(store.rows.map(\.entityId) == ["l1"])
		#expect(store.count(in: .all) == 4)
	}

	@Test("the search tab offers All, Team, Objects, Flows and Agents")
	func chipOrder() {
		#expect(SearchScope.chips.map(\.title) == ["All", "Items", "Chats", "Flows", "Files"])
	}

	@Test("a failing files search still yields the server's results and flags the list as partial")
	func partialFailure() async {
		let remote = FakeSearchRemote()
		await remote.setServer { _ in [object("o1", "Launch")] }
		await remote.setFiles { _ in throw SearchError("boom") }
		let store = makeStore(remote)
		store.setQuery("launch")
		await store.settle()
		#expect(store.phase == .results)
		#expect(store.isPartial)
		#expect(store.allResults.count == 1)
	}

	@Test("sources the server could not search flag the list as partial")
	func serverPartial() async {
		let remote = FakeSearchRemote()
		await remote.setServerAnswer { _, _ in SearchAnswer(results: [object("o1", "Launch")], isPartial: true) }
		let store = makeStore(remote)
		store.setQuery("launch")
		await store.settle()
		#expect(store.phase == .results)
		#expect(store.isPartial)
	}

	@Test("a failing server search still shows the files")
	func serverFailsFilesStay() async {
		let remote = FakeSearchRemote()
		await remote.setServer { _ in throw SearchError("boom") }
		await remote.setFiles { _ in [file("f1", "launch.md")] }
		let store = makeStore(remote)
		store.setQuery("launch")
		await store.settle()
		#expect(store.phase == .results)
		#expect(store.isPartial)
		#expect(store.allResults.map(\.id) == ["file:f1"])
	}

	@Test("every source failing is a failed phase, and retry recovers")
	func totalFailure() async {
		let remote = FakeSearchRemote()
		let offline = SearchError("You're offline.", isOffline: true)
		await remote.setServer { _ in throw offline }
		await remote.setFiles { _ in throw offline }
		let store = makeStore(remote)
		store.setQuery("x")
		await store.settle()
		#expect(store.phase == .failed("You're offline."))
		#expect(store.isOffline)
		await remote.setServer { _ in [object("o1", "x marks")] }
		await remote.setFiles { _ in [] }
		await store.retry()
		#expect(store.phase == .results)
		#expect(!store.isOffline)
	}

	@Test("committing remembers the query and skips the debounce")
	func commit() async {
		let remote = FakeSearchRemote()
		await remote.setServer { _ in [object("o1", "Launch")] }
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
@Suite("SearchStore people list")
struct SearchPeopleCacheTests {
	private let sigrid = SearchPerson(id: "h-sig", name: "Sigrid Larsen")
	private let marketing = SearchPerson(id: "a-pm", name: "Product Marketing", isAgent: true)

	private func make(
		_ remote: FakeSearchRemote, workspace: WorkspaceBox, clock: Clock, ttl: TimeInterval = 60
	) -> SearchStore {
		let defaults = UserDefaults(suiteName: "search-cache-\(UUID().uuidString)")!
		return SearchStore(
			remote: remote, recents: SearchRecents(defaults: defaults), workspaceId: { workspace.id },
			debounce: .milliseconds(1), directoryTTL: ttl, now: { clock.date })
	}

	private func untilPeople(_ store: SearchStore, _ count: Int) async {
		for _ in 0..<200 where store.people.count != count { try? await Task.sleep(for: .milliseconds(10)) }
	}

	@Test("the people list is dropped once the TTL has passed and then loaded again")
	func ttlReloads() async {
		let remote = FakeSearchRemote()
		let clock = Clock()
		let store = make(remote, workspace: WorkspaceBox(), clock: clock)
		await remote.setPeople([sigrid])
		store.setQuery("@")
		await untilPeople(store, 1)
		#expect(store.people == [sigrid])
		clock.advance(61)
		store.expireStaleDirectories()
		#expect(store.people.isEmpty)
		await remote.setPeople([sigrid, marketing])
		store.setQuery("@s")
		await untilPeople(store, 2)
		#expect(store.people.count == 2)
	}

	@Test("a workspace switch never shows the previous workspace's people")
	func switchDropsPeople() async {
		let remote = FakeSearchRemote()
		let box = WorkspaceBox()
		let store = make(remote, workspace: box, clock: Clock())
		await remote.setPeople([sigrid])
		store.setQuery("@")
		await untilPeople(store, 1)
		#expect(store.people == [sigrid])
		box.id = "ws-2"
		store.expireStaleDirectories()
		#expect(store.people.isEmpty)
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
