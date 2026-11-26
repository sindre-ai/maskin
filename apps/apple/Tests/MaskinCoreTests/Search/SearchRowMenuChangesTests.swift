import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("SearchStore row menu changes")
struct SearchStoreRowMenuTests {
	@Test("a removed chat leaves the results and stays gone when the server stops returning it")
	func removedChatStaysGone() async {
		let remote = FakeSearchRemote()
		await remote.setServer { _ in [chat("c1", "Launch plan"), chat("c2", "Launch notes")] }
		let store = makeStore(remote)
		store.setQuery("launch")
		await store.settle()
		#expect(Set(store.allResults.map(\.entityId)) == ["c1", "c2"])
		store.remove(chat("c1", "Launch plan"))
		#expect(store.allResults.map(\.entityId) == ["c2"])
		await remote.setServer { _ in [chat("c2", "Launch notes")] }  // the server's answer once c1 is archived
		await store.retry()
		#expect(store.allResults.map(\.entityId) == ["c2"])
	}

	@Test("an object's new status shows on its row, other rows are left alone")
	func statusShowsOnRow() async {
		let remote = FakeSearchRemote()
		await remote.setServer { _ in [object("o1", "Plan the launch"), object("o2", "Launch party")] }
		let store = makeStore(remote)
		store.setQuery("launch")
		await store.settle()
		store.setStatus("in_review", ofObject: "o1")
		#expect(store.allResults.first { $0.entityId == "o1" }?.subtitle == "in review")
		#expect(store.allResults.first { $0.entityId == "o2" }?.subtitle == "active")
	}
}
