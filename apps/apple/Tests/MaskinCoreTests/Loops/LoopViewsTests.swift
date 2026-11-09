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
}
