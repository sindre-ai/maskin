import Foundation
import Testing

@testable import MaskinCore

@Suite("SearchMention")
struct SearchMentionTests {
	private let marketing = SearchPerson(id: "a-pm", name: "Product Marketing", isAgent: true)
	private let sigrid = SearchPerson(id: "h-sig", name: "Sigrid Larsen")
	private let sebastian = SearchPerson(id: "h-seb", name: "Sebastian")

	@Test("the fragment is what follows an @ at the start or after a space")
	func fragment() {
		#expect(SearchMention.fragment(in: "@product marketing") == "product marketing")
		#expect(SearchMention.fragment(in: "launch @prod") == "prod")
		#expect(SearchMention.fragment(in: "@") == "")
		#expect(SearchMention.fragment(in: "mail@example.com") == nil)
		#expect(SearchMention.fragment(in: "no at sign") == nil)
	}

	@Test("suggestions match the name anywhere, case and accent blind, in name order")
	func suggestions() {
		let all = [sigrid, marketing, sebastian]
		#expect(SearchMention.suggestions(for: "@product marketing", in: all, excluding: []) == [marketing])
		#expect(SearchMention.suggestions(for: "@MARK", in: all, excluding: []) == [marketing])
		#expect(SearchMention.suggestions(for: "@", in: all, excluding: []) == [marketing, sebastian, sigrid])
	}

	@Test("a leading @ that matches nobody gives no suggestions, so it stays plain text")
	func noMatch() {
		#expect(SearchMention.suggestions(for: "@zzz", in: [marketing, sigrid], excluding: []).isEmpty)
		#expect(SearchMention.suggestions(for: "plain words", in: [marketing], excluding: []).isEmpty)
	}

	@Test("people already picked are not offered again")
	func excludesPicked() {
		let list = SearchMention.suggestions(for: "@s", in: [sigrid, sebastian], excluding: [sigrid])
		#expect(list == [sebastian])
	}

	@Test("the menu is capped")
	func capped() {
		let many = (0..<20).map { SearchPerson(id: "p\($0)", name: "Person \($0)") }
		#expect(SearchMention.suggestions(for: "@", in: many, excluding: []).count == SearchMention.menuLimit)
	}

	@Test("picking removes the @ word and keeps the words before it")
	func removing() {
		#expect(SearchMention.removingFragment(from: "@product marketing") == "")
		#expect(SearchMention.removingFragment(from: "launch @prod") == "launch")
		#expect(SearchMention.removingFragment(from: "launch") == "launch")
	}
}

@MainActor
@Suite("SearchStore @ filter")
struct SearchStoreMentionTests {
	private let marketing = SearchPerson(id: "a-pm", name: "Product Marketing", isAgent: true)
	private let sigrid = SearchPerson(id: "h-sig", name: "Sigrid Larsen")
	private let me = SearchPerson(id: "me", name: "Sebastian")

	private func make(_ remote: FakeSearchRemote) -> SearchStore {
		let defaults = UserDefaults(suiteName: "search-mention-\(UUID().uuidString)")!
		return SearchStore(
			remote: remote, recents: SearchRecents(defaults: defaults), workspaceId: { "ws-1" },
			debounce: .milliseconds(10), currentActorId: { "me" })
	}

	private func seeded() async -> FakeSearchRemote {
		let remote = FakeSearchRemote()
		await remote.setPeople([marketing, sigrid, me])
		await remote.setChats(
			.success([
				chat("c1", "Launch plan", people: "Product Marketing, Sigrid Larsen", ids: ["a-pm", "h-sig", "me"]),
				chat("c2", "Copy review", people: "Product Marketing", ids: ["a-pm", "me"]),
				chat("c3", "Standup", people: "Sigrid Larsen", ids: ["h-sig", "me"]),
			]))
		await remote.setObjects { _ in [object("o1", "Product marketing brief")] }
		return remote
	}

	/// The @ menu fills once the people list has loaded.
	private func untilMenu(_ store: SearchStore) async {
		for _ in 0..<200 where store.mentionSuggestions.isEmpty {
			try? await Task.sleep(for: .milliseconds(10))
		}
	}

	@Test("typing @ offers people and agents, never yourself")
	func menu() async {
		let store = make(await seeded())
		store.setQuery("@")
		await untilMenu(store)
		#expect(store.mentionSuggestions == [marketing, sigrid])
		store.setQuery("@product marketing")
		#expect(store.mentionSuggestions == [marketing])
	}

	@Test("picking an agent adds a pill and lists only the chats it is in")
	func pickAgent() async {
		let remote = await seeded()
		let store = make(remote)
		store.setQuery("@product marketing")
		await untilMenu(store)
		await store.settle()
		let askedBeforePick = await remote.objectQueries.count  // the typed text is searched while the menu is open
		store.pick(marketing)
		await store.settle()
		#expect(store.participants == [marketing])
		#expect(store.query == "")
		#expect(store.phase == .results)
		#expect(store.allResults.map(\.id) == ["chat:c1", "chat:c2"])
		#expect(store.mentionSuggestions.isEmpty)
		#expect(
			await remote.objectQueries.count == askedBeforePick,
			"other sources are not asked while people are picked")
	}

	@Test("several people narrow to chats containing all of them")
	func pickTwo() async {
		let store = make(await seeded())
		store.setQuery("@")
		await untilMenu(store)
		store.pick(marketing)
		store.setQuery("@sig")
		await untilMenu(store)
		store.pick(sigrid)
		await store.settle()
		#expect(store.participants == [marketing, sigrid])
		#expect(store.allResults.map(\.id) == ["chat:c1"])
	}

	@Test("words typed with a pill still filter the chats")
	func pillWithWords() async {
		let store = make(await seeded())
		store.setQuery("@product marketing")
		await untilMenu(store)
		store.pick(marketing)
		store.setQuery("copy")
		await store.settle()
		#expect(store.allResults.map(\.id) == ["chat:c2"])
	}

	@Test("removing the last pill with no words goes back to the recents screen")
	func removePill() async {
		let store = make(await seeded())
		store.setQuery("@product marketing")
		await untilMenu(store)
		store.pick(marketing)
		await store.settle()
		store.removeParticipant(marketing)
		#expect(store.participants.isEmpty)
		#expect(store.phase == .idle)
		#expect(store.allResults.isEmpty)
	}

	@Test("removing a pill while words remain searches everything again")
	func removePillWithWords() async {
		let remote = await seeded()
		let store = make(remote)
		store.setQuery("@product marketing")
		await untilMenu(store)
		await store.settle()
		let askedBeforePick = await remote.objectQueries.count  // the typed text is searched while the menu is open
		store.pick(marketing)
		store.setQuery("brief")
		await store.settle()
		store.removeParticipant(marketing)
		await store.settle()
		#expect(await remote.objectQueries.dropFirst(askedBeforePick) == ["brief"])
		#expect(store.allResults.map(\.id) == ["object:o1"])
	}

	@Test("an @ word that matches nobody is searched as plain text")
	func plainText() async {
		let remote = await seeded()
		let store = make(remote)
		store.setQuery("@zzz")
		try? await Task.sleep(for: .milliseconds(100))  // let the people list load
		#expect(store.mentionSuggestions.isEmpty)
		await store.settle()
		#expect(store.participants.isEmpty)
		#expect(await remote.objectQueries == ["@zzz"])
	}

	@Test("the same person cannot be picked twice")
	func noDuplicates() async {
		let store = make(await seeded())
		store.setQuery("@product marketing")
		await untilMenu(store)
		store.pick(marketing)
		store.pick(marketing)
		#expect(store.participants == [marketing])
	}

	@Test("ranking applies to the store's results: title, then participants, then preview")
	func storeRanking() async {
		let remote = FakeSearchRemote()
		await remote.setChats(
			.success([
				chat("prev", "Roadmap", people: "Sigrid Larsen", snippet: "Magnus will review it"),
				chat("part", "Weekly sync", people: "Magnus Eide, Sigrid Larsen", snippet: "ok"),
				chat("title", "Magnus 1:1", people: "Sebastian"),
			]))
		let store = make(remote)
		store.setQuery("Magnus")
		await store.settle()
		#expect(store.allResults.map(\.id) == ["chat:title", "chat:part", "chat:prev"])
		#expect(store.sections.first?.results.map(\.id) == ["chat:title", "chat:part", "chat:prev"])
	}
}
