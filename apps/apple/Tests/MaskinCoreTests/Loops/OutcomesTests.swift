import Foundation
import Testing

@testable import MaskinCore

private func file(
	_ id: String, _ name: String, mime: String, updated: TimeInterval? = nil
) -> FileSummary {
	FileSummary(
		id: id, name: name, mimeType: mime, sizeBytes: 10,
		updatedAt: updated.map { Date(timeIntervalSince1970: $0) })
}

private func out(_ id: String, _ name: String = "x", source: String? = nil) -> LoopOutput {
	LoopOutput(id: id, name: name, sourceTitle: source)
}

@Suite("OutcomeBuilder")
struct OutcomeBuilderTests {
	let a = loopRow("a", name: "Market watch")
	let b = loopRow("b", name: "User insights")

	@Test("pages lead a loop's outcomes, then newest first")
	func ordering() {
		let groups = OutcomeBuilder.groups(
			entries: [(a, [out("doc"), out("page"), out("old")])],
			files: [
				"doc": file("doc", "brief.md", mime: "text/markdown", updated: 300),
				"page": file("page", "dash.html", mime: "text/html", updated: 100),
				"old": file("old", "notes.md", mime: "text/markdown", updated: 200),
			])
		#expect(groups.first?.outcomes.map(\.fileID) == ["page", "doc", "old"])
	}

	@Test("loops are ordered by their latest outcome and empty ones are hidden")
	func groupOrdering() {
		let groups = OutcomeBuilder.groups(
			entries: [(a, [out("1")]), (b, [out("2")]), (loopRow("c"), [])],
			files: [
				"1": file("1", "a.html", mime: "text/html", updated: 100),
				"2": file("2", "b.html", mime: "text/html", updated: 900),
			])
		#expect(groups.map(\.loopID) == ["b", "a"])
	}

	@Test("a file attached through two loops appears once, under the first")
	func dedupes() {
		let groups = OutcomeBuilder.groups(
			entries: [(a, [out("1")]), (b, [out("1")])],
			files: ["1": file("1", "a.html", mime: "text/html")])
		#expect(groups.map(\.loopID) == ["a"])
	}

	@Test("files with no metadata, and source or binary files, are not outcomes")
	func dropsUnpresentable() {
		let groups = OutcomeBuilder.groups(
			entries: [(a, [out("gone"), out("js"), out("zip"), out("ok")])],
			files: [
				"js": file("js", "x.js", mime: "text/javascript"),
				"zip": file("zip", "x.zip", mime: "application/zip"),
				"ok": file("ok", "x.pdf", mime: "application/pdf"),
			])
		#expect(groups.first?.outcomes.map(\.fileID) == ["ok"])
	}

	@Test("the kind comes from the file's real MIME type, not its name")
	func kindFromMime() {
		let groups = OutcomeBuilder.groups(
			entries: [(a, [out("1", "report")])],
			files: ["1": file("1", "report", mime: "text/html")])
		#expect(groups.first?.outcomes.first?.kind == .html)
	}
}

private struct PerLoopAPI: LoopsAPI {
	var rows: [LoopSummary]
	var outputs: [String: [LoopOutput]]
	var failLoops = false

	func loops() async throws -> [LoopSummary] {
		if failLoops { throw AutomationError("offline") }
		return rows
	}
	func steps(loopID: String) async throws -> [LoopStep] { [] }
	func activity(loopID: String) async throws -> [LoopActivityEntry] { [] }
	func actors() async throws -> [AutomationActor] { [] }
	func installs() async throws -> [LoopInstall] { [] }
	func setStatus(loopID: String, status: LoopPill, idempotencyKey: String) async throws {}
	func createLoop(name: String, content: String, idempotencyKey: String) async throws -> String { "" }
	func updateLoop(loopID: String, name: String?, content: String?, idempotencyKey: String)
		async throws {}
	func deleteLoop(loopID: String) async throws {}
	func overview(loopID: String) async throws -> LoopOverview {
		LoopOverview(members: [], posts: [], outputs: outputs[loopID] ?? [], statusOrder: [])
	}
}

private actor RecordingFiles: FilesRemote {
	var rows: [FileSummary]
	private(set) var requests: [[String]] = []
	var fails = false
	init(_ rows: [FileSummary]) { self.rows = rows }
	func setFails(_ value: Bool) { fails = value }

	func file(id: String) async throws -> FileDetail { throw FileError("unused") }
	func summaries(ids: [String]) async throws -> [FileSummary] {
		requests.append(ids)
		if fails { throw FileError("offline", isOffline: true) }
		return rows.filter { ids.contains($0.id) }
	}
}

@MainActor
@Suite("OutcomesStore")
struct OutcomesStoreTests {
	@Test("loads every loop's outputs with one batched file lookup")
	func loads() async {
		let api = PerLoopAPI(
			rows: [loopRow("a", name: "Market watch"), loopRow("b", name: "User insights")],
			outputs: ["a": [out("1"), out("2")], "b": [out("3")]])
		let files = RecordingFiles([
			file("1", "m.html", mime: "text/html", updated: 10),
			file("2", "m.md", mime: "text/markdown", updated: 20),
			file("3", "u.html", mime: "text/html", updated: 30),
		])
		let store = OutcomesStore(loops: api, files: files, events: nil)
		#expect(store.phase == .idle)
		await store.refresh()
		#expect(store.phase == .loaded)
		#expect(store.groups.map(\.loopName) == ["User insights", "Market watch"])
		#expect(store.outcomeCount == 3)
		let requests = await files.requests
		#expect(requests.count == 1)
		#expect(Set(requests[0]) == ["1", "2", "3"])
	}

	@Test("loops that produced nothing don't call the file endpoint")
	func empty() async {
		let store = OutcomesStore(
			loops: PerLoopAPI(rows: [loopRow("a")], outputs: [:]), files: RecordingFiles([]), events: nil)
		await store.refresh()
		#expect(store.phase == .loaded)
		#expect(store.groups.isEmpty)
	}

	@Test("a failed first load is reported")
	func failsFirst() async {
		let store = OutcomesStore(
			loops: PerLoopAPI(rows: [], outputs: [:], failLoops: true), files: RecordingFiles([]), events: nil)
		await store.refresh()
		#expect(store.phase == .failed("Something went wrong. Check your connection."))
	}

	@Test("a failed refresh keeps what is already on screen")
	func keepsOnFailure() async {
		let api = PerLoopAPI(rows: [loopRow("a")], outputs: ["a": [out("1")]])
		let files = RecordingFiles([file("1", "m.html", mime: "text/html")])
		let store = OutcomesStore(loops: api, files: files, events: nil)
		await store.refresh()
		await files.setFails(true)
		await store.refresh()
		#expect(store.phase == .loaded)
		#expect(store.outcomeCount == 1)
	}

	@Test("only object, file and relationship events matter")
	func relevantEvents() {
		#expect(OutcomesStore.affectsOutcomes(.file))
		#expect(OutcomesStore.affectsOutcomes(.relationship))
		#expect(OutcomesStore.affectsOutcomes(.object))
		#expect(!OutcomesStore.affectsOutcomes(.notification))
	}
}
