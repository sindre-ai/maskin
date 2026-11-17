import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("SearchStore row menu changes")
struct SearchStoreRowMenuTests {
	@Test("a removed chat leaves the results and stays gone when the words change")
	func removedChatStaysGone() async {
		let remote = FakeSearchRemote()
		await remote.setChats(.success([chat("c1", "Launch plan"), chat("c2", "Launch notes")]))
		let store = makeStore(remote)
		store.setQuery("launch")
		await store.settle()
		#expect(Set(store.allResults.map(\.entityId)) == ["c1", "c2"])
		store.remove(chat("c1", "Launch plan"))
		#expect(store.allResults.map(\.entityId) == ["c2"])
		store.setQuery("launch p")
		store.setQuery("launch")
		await store.settle()
		#expect(store.allResults.map(\.entityId) == ["c2"], "the cached chat list no longer holds it")
		#expect(await remote.conversationCalls == 1, "removing does not refetch the chat list")
	}

	@Test("an object's new status shows on its row, other rows are left alone")
	func statusShowsOnRow() async {
		let remote = FakeSearchRemote()
		await remote.setObjects { _ in [object("o1", "Plan the launch"), object("o2", "Launch party")] }
		let store = makeStore(remote)
		store.setQuery("launch")
		await store.settle()
		store.setStatus("in_review", ofObject: "o1")
		#expect(store.allResults.first { $0.entityId == "o1" }?.subtitle == "in review")
		#expect(store.allResults.first { $0.entityId == "o2" }?.subtitle == "active")
	}
}
