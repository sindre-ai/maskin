import Foundation
import Testing

@testable import MaskinCore

private func file(_ id: String, _ name: String, mime: String, updated: TimeInterval? = nil) -> FileSummary {
	FileSummary(
		id: id, name: name, mimeType: mime, sizeBytes: 10,
		updatedAt: updated.map { Date(timeIntervalSince1970: $0) })
}

private func out(_ id: String, _ name: String = "x", source: String? = nil) -> LoopOutput {
	LoopOutput(id: id, name: name, sourceTitle: source)
}

@Suite("Loop outcomes")
struct LoopOutcomesTests {
	@Test("only pages and PDFs are outcomes; screenshots, notes and scratch files are not")
	func filters() {
		let outputs = [out("shot"), out("notes"), out("log"), out("page"), out("pdf")]
		let result = LoopOverviewBuilder.outcomes(
			from: outputs,
			files: [
				"shot": file("shot", "screenshot.png", mime: "image/png"),
				"notes": file("notes", "notes.md", mime: "text/markdown"),
				"log": file("log", "run.txt", mime: "text/plain"),
				"page": file("page", "brief.html", mime: "text/html"),
				"pdf": file("pdf", "report.pdf", mime: "application/pdf"),
			])
		#expect(Set(result.map(\.id)) == ["page", "pdf"])
	}

	@Test("pages lead, then the newest first")
	func ordering() {
		let result = LoopOverviewBuilder.outcomes(
			from: [out("old"), out("pdf"), out("new"), out("page")],
			files: [
				"old": file("old", "a.html", mime: "text/html", updated: 100),
				"new": file("new", "b.html", mime: "text/html", updated: 300),
				"page": file("page", "c.html", mime: "text/html", updated: 200),
				"pdf": file("pdf", "d.pdf", mime: "application/pdf", updated: 900),
			])
		#expect(result.map(\.id) == ["new", "page", "old", "pdf"])
	}

	@Test("a file with no row is dropped, and the row's name, type and date win")
	func enriches() {
		let result = LoopOverviewBuilder.outcomes(
			from: [out("gone"), out("a", "graph-name")],
			files: ["a": file("a", "Real name", mime: "text/html", updated: 5)])
		#expect(result.map(\.id) == ["a"])
		#expect(result.first?.name == "Real name")
		#expect(result.first?.kind == .html)
		#expect(result.first?.updatedAt == Date(timeIntervalSince1970: 5))
	}

	@Test("when the lookup failed, the file names decide")
	func fallsBackToNames() {
		let result = LoopOverviewBuilder.outcomes(
			from: [out("1", "shot.png"), out("2", "dash.html"), out("3", "r.pdf"), out("4", "n.md")], files: nil)
		#expect(result.map(\.id) == ["2", "3"])
	}

	@Test("a produced file with a misleading name is judged by its real type")
	func realTypeWins() {
		let result = LoopOverviewBuilder.outcomes(
			from: [out("1", "report.html")], files: ["1": file("1", "report.html", mime: "image/png")])
		#expect(result.isEmpty)
	}
}
