import Foundation
import Testing

@testable import MaskinCore

private struct StubFiles: FilesRemote {
	var rows: [FileSummary]
	func file(id: String) async throws -> FileDetail { throw FileError("unused") }
	func summaries(ids: [String]) async throws -> [FileSummary] { rows.filter { ids.contains($0.id) } }
}

private func attached(_ id: String, _ title: String) -> ObjectLink {
	ObjectLink(
		id: "edge-\(id)", relation: "attached", isOutgoing: true, otherId: id, otherType: "file",
		otherTitle: title)
}

@MainActor
@Suite("Object outcomes")
struct ObjectOutcomesTests {
	private func makeStore(rows: [FileSummary]) -> ObjectDetailStore {
		let remote = FakeObjectsRemote(objects: Fixtures.objects)
		let object = Fixtures.objects.first { $0.id == "t1" }!
		var graph = Fixtures.graph(for: object)
		graph.links += [
			attached("page", "brief.html"), attached("shot", "screenshot.png"), attached("pdf", "report.pdf"),
			attached("gone", "deleted.html"),
		]
		remote.setGraph(graph)
		return ObjectDetailStore(
			objectId: "t1", remote: remote, directory: ObjectsDirectory(remote: remote, actors: Fixtures.actors),
			currentActorId: "me", files: StubFiles(rows: rows))
	}

	private let rows = [
		FileSummary(id: "page", name: "Weekly brief", mimeType: "text/html", sizeBytes: 1),
		FileSummary(id: "shot", name: "screenshot.png", mimeType: "image/png", sizeBytes: 1),
		FileSummary(id: "pdf", name: "Report", mimeType: "application/pdf", sizeBytes: 1),
	]

	@Test("attached pages and PDFs become outcomes; screenshots and unresolvable files don't")
	func outcomes() async throws {
		let store = makeStore(rows: rows)
		await store.load()
		try await waitUntil { !store.outcomes.isEmpty }
		#expect(store.outcomes.map(\.id) == ["page", "pdf"])
		#expect(store.outcomes.first?.name == "Weekly brief")
	}

	@Test("nothing is shown before the files resolve, never an id")
	func unresolved() async {
		let store = makeStore(rows: [])
		await store.load()
		#expect(store.outcomes.isEmpty)
	}
}
