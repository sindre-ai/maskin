import Foundation
import Testing

@testable import MaskinCore

@Suite("Loop custom views")
struct LoopViewsTests {
	private func metadata(_ json: String) throws -> JSONValue {
		try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
	}

	@Test("views read in tab order")
	func list() throws {
		let meta = try metadata(
			#"{"views":[{"name":"Results","file_id":"f1"},{"name":"Pipeline health","file_id":"f2"}]}"#)
		#expect(
			LoopViews.read(metadata: meta) == [
				LoopView(name: "Results", fileID: "f1"), LoopView(name: "Pipeline health", fileID: "f2"),
			])
	}

	@Test("a loop with only the old file id shows one view named Custom view")
	func legacy() throws {
		let meta = try metadata(#"{"view_file_id":"f9"}"#)
		#expect(LoopViews.read(metadata: meta) == [LoopView(name: "Custom view", fileID: "f9")])
	}

	@Test("once views is a list it wins, even when empty")
	func listWins() throws {
		#expect(try LoopViews.read(metadata: metadata(#"{"views":[],"view_file_id":"f9"}"#)).isEmpty)
		#expect(
			try LoopViews.read(metadata: metadata(#"{"views":[{"name":"A","file_id":"f1"}],"view_file_id":"f9"}"#))
				== [LoopView(name: "A", fileID: "f1")])
	}

	@Test("rows without a name or file are dropped, and no metadata gives no views")
	func tolerant() throws {
		let meta = try metadata(#"{"views":[{"name":"A"},{"file_id":"f2"},{"name":"B","file_id":"f3"},7]}"#)
		#expect(LoopViews.read(metadata: meta) == [LoopView(name: "B", fileID: "f3")])
		#expect(LoopViews.read(metadata: nil).isEmpty)
		#expect(LoopViews.read(metadata: .object([:])).isEmpty)
	}

	@MainActor
	@Test("the loop screen keeps its views when a later read fails")
	func store() async {
		let row = loopRow("l1")
		let api = FakeLoopsAPI([row])
		await api.setViews([LoopView(name: "Results", fileID: "f1")])
		let store = LoopDetailStore(loop: row, api: api, events: nil)
		await store.start()
		#expect(store.views == [LoopView(name: "Results", fileID: "f1")])
		await api.setFailViews(true)
		await store.refresh()
		#expect(store.views == [LoopView(name: "Results", fileID: "f1")])
		await api.setFailViews(false)
		await api.setViews([])
		await store.refresh()
		#expect(store.views.isEmpty)
	}

	@Test("the live loop object reads as its views: Product Discovery and Content Marketing")
	func liveShape() throws {
		// The metadata of these two flows as read from the live workspace on 17 Nov 2026 (other fields
		// trimmed to one of each kind). Decoded here with the same JSONValue the by-id read uses.
		let discovery = try metadata(
			#"""
			{"tags":["Product"],"views":[
			{"name":"Radar","file_id":"d8b5e848-14b8-4b1d-8070-cd6347177ac8"},
			{"name":"Opportunities","file_id":"1ff2c333-f081-48c8-8f6c-14e4ef8f75ea"},
			{"name":"Pipeline","file_id":"ad29b26b-e8ea-47e2-9eab-a03d29c207fa"},
			{"name":"Briefing","file_id":"bb54bdd0-4c58-4794-8738-8587ee68c732"}],
			"targets":[{"label":"x","actual":0,"target":15,"ownerActorId":"a"}],
			"trigger_ids":["t1"],"view_file_id":null,"closed_statuses":{"bet":["opportunity"]}}
			"""#)
		#expect(LoopViews.read(metadata: discovery).map(\.name) == ["Radar", "Opportunities", "Pipeline", "Briefing"])
		let marketing = try metadata(
			#"""
			{"tags":["Marketing"],"views":[
			{"name":"Calendar","file_id":"00116211-e525-48c9-b79e-9808a5f49e74"},
			{"name":"Candidates","file_id":"69d07a1e-fe4e-4453-b33b-56a00e5c69f4"}],
			"view_file_id":null}
			"""#)
		#expect(
			LoopViews.read(metadata: marketing) == [
				LoopView(name: "Calendar", fileID: "00116211-e525-48c9-b79e-9808a5f49e74"),
				LoopView(name: "Candidates", fileID: "69d07a1e-fe4e-4453-b33b-56a00e5c69f4"),
			])
	}

	@MainActor
	@Test("a failed views read says so, keeps the other blocks, and Try again clears it")
	func failedRead() async {
		let row = loopRow("l1")
		let api = FakeLoopsAPI([row])
		await api.setViews([LoopView(name: "Results", fileID: "f1")])
		await api.setFailViews(true)
		let store = LoopDetailStore(loop: row, api: api, events: nil)
		await store.start()
		#expect(store.failedBlocks == [.views])
		#expect(store.views.isEmpty)
		// The rest of the screen still loads: a views failure is not a whole-page error.
		#expect(store.phase == .loaded)

		await api.setFailViews(false)
		await store.retry()
		#expect(store.failedBlocks.isEmpty)
		#expect(store.views == [LoopView(name: "Results", fileID: "f1")])
	}

	@MainActor
	@Test("a flow with no views says nothing")
	func noViewsNoNote() async {
		let row = loopRow("l1")
		let store = LoopDetailStore(loop: row, api: FakeLoopsAPI([row]), events: nil)
		await store.start()
		#expect(store.views.isEmpty)
		#expect(!store.failed(.views))
	}

	@Test("the views message is plain")
	func message() {
		#expect(LoopDetailStore.Block.views.message == "Couldn't load this flow's views. The server may be busy.")
	}
}
