import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("Loop authoring")
struct LoopAuthoringTests {
	@Test("creating a loop adds it to the list and returns its id")
	func create() async {
		let api = FakeLoopsAPI([])
		let store = LoopsStore(api: api, events: nil)
		let id = await store.create(name: "  Inbox triage ", description: " Sort new mail ")
		#expect(id == "new-1")
		let calls = await api.createCalls
		#expect(calls.first?.0 == "Inbox triage")
		#expect(calls.first?.1 == "Sort new mail")
		#expect(store.loops.first { $0.id == "new-1" }?.displayName == "Inbox triage")
	}

	@Test("a blank name creates nothing")
	func blank() async {
		let api = FakeLoopsAPI([])
		let store = LoopsStore(api: api, events: nil)
		#expect(await store.create(name: "   ", description: "x") == nil)
		#expect(await api.createCalls.isEmpty)
	}

	@Test("a failed create explains and reuses the idempotency key on retry")
	func createRetry() async {
		let api = FakeLoopsAPI([])
		await api.setFailEdit(true)
		let store = LoopsStore(api: api, events: nil)
		#expect(await store.create(name: "A", description: "") == nil)
		#expect(store.notice?.contains("Couldn't create") == true)
		_ = await store.create(name: "A", description: "")
		let calls = await api.createCalls
		#expect(calls.count == 2)
		#expect(calls[0].2 == calls[1].2)
	}

	@Test("saving sends only the changed fields")
	func saveChanged() async {
		let api = FakeLoopsAPI([loopRow("a", name: "Old")])
		let store = LoopDetailStore(loop: loopRow("a", name: "Old"), api: api, events: nil)
		#expect(await store.save(name: "New", content: ""))
		let calls = await api.updateCalls
		#expect(calls.count == 1)
		#expect(calls[0].1 == "New")
		#expect(calls[0].2 == nil)
		#expect(store.loop.name == "New")
	}

	@Test("a refused save rolls the edit back")
	func saveRollback() async {
		let api = FakeLoopsAPI([loopRow("a", name: "Old")])
		await api.setFailEdit(true)
		let store = LoopDetailStore(loop: loopRow("a", name: "Old"), api: api, events: nil)
		#expect(await store.save(name: "New", content: "text") == false)
		#expect(store.loop.name == "Old")
		#expect(store.loop.content == nil)
		#expect(store.notice?.contains("Couldn't save") == true)
	}

	@Test("an empty name is rejected locally")
	func emptyName() async {
		let api = FakeLoopsAPI([])
		let store = LoopDetailStore(loop: loopRow("a"), api: api, events: nil)
		#expect(await store.save(name: " ", content: "") == false)
		#expect(await api.updateCalls.isEmpty)
	}

	@Test("deleting marks the loop gone and notifies the list")
	func delete() async {
		let api = FakeLoopsAPI([loopRow("a")])
		let store = LoopDetailStore(loop: loopRow("a"), api: api, events: nil)
		var deleted: String?
		store.onDeleted = { deleted = $0 }
		await store.delete()
		#expect(store.isGone)
		#expect(deleted == "a")
		#expect(await api.deleted == ["a"])
	}

	@Test("a failed delete keeps the loop")
	func deleteFails() async {
		let api = FakeLoopsAPI([loopRow("a")])
		await api.setFailEdit(true)
		let store = LoopDetailStore(loop: loopRow("a"), api: api, events: nil)
		await store.delete()
		#expect(!store.isGone)
		#expect(store.notice?.contains("Couldn't delete") == true)
	}
}
