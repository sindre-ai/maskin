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

	/// A fake server: with people picked it answers only the chats all of them are in, the way the
	/// server search does; otherwise chats and the one item whose title holds the words.
	private func seeded() async -> FakeSearchRemote {
		let remote = FakeSearchRemote()
		await remote.setPeople([marketing, sigrid, me])
		let chats: [(result: SearchResult, people: [String])] = [
			(chat("c1", "Launch plan", people: "Product Marketing, Sigrid Larsen"), ["a-pm", "h-sig", "me"]),
			(chat("c2", "Copy review", people: "Product Marketing"), ["a-pm", "me"]),
			(chat("c3", "Standup", people: "Sigrid Larsen"), ["h-sig", "me"]),
		]
		let item = object("o1", "Product marketing brief")
		await remote.setServerAnswer { query, picked in
			let words = query.lowercased()
			func hits(_ title: String) -> Bool { words.isEmpty || title.lowercased().contains(words) }
			let found = chats.filter { chat in
				picked.allSatisfy { chat.people.contains($0) } && hits(chat.result.title)
			}.map(\.result)
			return SearchAnswer(results: found + (picked.isEmpty && hits(item.title) ? [item] : []))
		}
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
		store.pick(marketing)
		await store.settle()
		#expect(store.participants == [marketing])
		#expect(store.query == "")
		#expect(store.phase == .results)
		#expect(store.allResults.map(\.id) == ["chat:c1", "chat:c2"])
		#expect(store.mentionSuggestions.isEmpty)
		#expect(await remote.serverParticipants.last == ["a-pm"], "the picked ids go to the server search")
	}

	@Test("several people narrow to chats containing all of them")
	func pickTwo() async {
		let remote = await seeded()
		let store = make(remote)
		store.setQuery("@")
		await untilMenu(store)
		store.pick(marketing)
		store.setQuery("@sig")
		await untilMenu(store)
		store.pick(sigrid)
		await store.settle()
		#expect(store.participants == [marketing, sigrid])
		#expect(await remote.serverParticipants.last == ["a-pm", "h-sig"])
		#expect(store.allResults.map(\.id) == ["chat:c1"])
	}

	@Test("words typed with a pill are sent with it")
	func pillWithWords() async {
		let remote = await seeded()
		let store = make(remote)
		store.setQuery("@product marketing")
		await untilMenu(store)
		store.pick(marketing)
		store.setQuery("copy")
		await store.settle()
		#expect(store.allResults.map(\.id) == ["chat:c2"])
		#expect(await remote.serverQueries.last == "copy")
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
		let askedBeforePick = await remote.serverQueries.count  // the typed text is searched while the menu is open
		store.pick(marketing)
		store.setQuery("brief")
		await store.settle()
		store.removeParticipant(marketing)
		await store.settle()
		#expect(await remote.serverQueries.dropFirst(askedBeforePick) == ["brief", "brief"])
		#expect(await remote.serverParticipants.last == [], "the pill is gone, so everything is searched")
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
		#expect(await remote.serverQueries == ["@zzz"])
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
}
