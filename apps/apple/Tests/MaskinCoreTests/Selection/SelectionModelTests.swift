import Testing

@testable import MaskinCore

@MainActor
@Suite("SelectionModel")
struct SelectionModelTests {
	@Test("entering with a row picks it; exiting clears everything")
	func enterExit() {
		let model = SelectionModel()
		#expect(!model.isActive)
		model.enter(selecting: "a")
		#expect(model.isActive)
		#expect(model.ids == ["a"])
		model.exit()
		#expect(!model.isActive)
		#expect(model.isEmpty)
	}

	@Test("toggle picks then unpicks, and unpicking the last row keeps the mode on")
	func toggle() {
		let model = SelectionModel()
		model.enter(selecting: "a")
		model.toggle("b")
		#expect(model.count == 2)
		model.toggle("a")
		model.toggle("b")
		#expect(model.isEmpty)
		#expect(model.isActive)
	}

	@Test("select all, all-selected and clear")
	func selectAll() {
		let model = SelectionModel()
		model.enter()
		#expect(!model.isAllSelected(of: []))
		model.selectAll(["a", "b"])
		#expect(model.isAllSelected(of: ["a", "b"]))
		#expect(!model.isAllSelected(of: ["a", "b", "c"]))
		model.clear()
		#expect(model.isEmpty)
	}

	@Test("prune drops ids that left the list; ordered follows list order")
	func pruneAndOrder() {
		let model = SelectionModel()
		model.enter()
		model.selectAll(["c", "a", "gone"])
		model.prune(toVisible: ["a", "b", "c"])
		#expect(model.ids == ["a", "c"])
		#expect(model.ordered(in: ["a", "b", "c"]) == ["a", "c"])
	}
}

@Suite("BulkResult")
struct BulkResultTests {
	@Test("no notice when everything landed")
	func clean() {
		#expect(BulkResult(succeeded: 3).failureNotice(action: "archive", past: "archived", noun: "chat") == nil)
	}

	@Test("total failure names the action and pluralises")
	func total() {
		#expect(
			BulkResult(failed: 1).failureNotice(action: "archive", past: "archived", noun: "chat")
				== "Couldn't archive 1 chat.")
		#expect(
			BulkResult(failed: 2).failureNotice(action: "delete", past: "deleted", noun: "object")
				== "Couldn't delete 2 objects.")
	}

	@Test("partial failure reports both counts")
	func partial() {
		#expect(
			BulkResult(succeeded: 2, failed: 1).failureNotice(action: "archive", past: "archived", noun: "chat")
				== "2 archived, 1 couldn't be. Try again for the rest.")
	}
}
