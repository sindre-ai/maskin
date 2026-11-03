import Foundation
import Testing

@testable import MaskinCore

/// Records every save and can be told to fail or to hold a save open.
private final class PinRemote: FilesRemote, @unchecked Sendable {
	struct Save: Equatable {
		var annotations: [FileAnnotation]
		var key: String
	}
	private let lock = NSLock()
	private var _saves: [Save] = []
	var fail: FileError?
	var gate: (@Sendable () async -> Void)?
	var file: FileDetail

	init(file: FileDetail) { self.file = file }

	var saves: [Save] { lock.withLock { _saves } }

	func file(id: String) async throws -> FileDetail { file }

	func saveAnnotations(fileId: String, annotations: [FileAnnotation], idempotencyKey: String) async throws
		-> [FileAnnotation]
	{
		lock.withLock { _saves.append(Save(annotations: annotations, key: idempotencyKey)) }
		if let gate { await gate() }
		if let fail { throw fail }
		return annotations
	}
}

private func page(annotations: [FileAnnotation] = [], mime: String = "text/html") -> FileDetail {
	FileDetail(
		id: "f1", name: "page.html", mimeType: mime, sizeBytes: 10, data: Data("<p>hi</p>".utf8),
		annotations: annotations)
}

private let origin = FilePoint(x: 0.4, y: 0.5)

@MainActor
@Suite("FileStore pins")
struct FilePinsTests {
	@Test("placing a pin makes a numbered draft that is not saved until it has a comment")
	func draftIsLocal() async {
		let remote = PinRemote(file: page())
		let store = FileStore(fileId: "f1", remote: remote, preload: page())
		#expect(store.beginPin(at: origin, selector: "#hero", bounds: FileBounds(x: 0.1, y: 0.1, w: 0.5, h: 0.2)))
		#expect(store.draft?.pinNumber == 1)
		#expect(store.draft?.selector == "#hero")
		#expect(store.annotations.isEmpty)
		#expect(remote.saves.isEmpty)
		store.cancelDraft()
		#expect(store.draft == nil)
		#expect(remote.saves.isEmpty)
	}

	@Test("committing a draft appends the pin and saves the whole list with an idempotency key")
	func commit() async {
		let existing = FileAnnotation(
			id: "a", pinNumber: 4, comment: "old", selector: ".card", bounds: FileBounds(x: 0.2, y: 0.2, w: 0.3, h: 0.3),
			position: FilePoint(x: 0.3, y: 0.3))
		let remote = PinRemote(file: page(annotations: [existing]))
		let store = FileStore(fileId: "f1", remote: remote, preload: page(annotations: [existing]))
		store.beginPin(at: origin)
		#expect(store.draft?.pinNumber == 5)
		await store.commitDraft(comment: "  Tighten this  ")
		#expect(store.draft == nil)
		#expect(store.annotations.map(\.comment) == ["old", "Tighten this"])
		let save = remote.saves.first
		#expect(save?.annotations.count == 2)
		// Fields written by the web survive the round trip, or the next save would erase them.
		#expect(save?.annotations.first == existing)
		#expect(save?.key.isEmpty == false)
		#expect(store.saveError == nil)
	}

	@Test("a blank comment saves nothing")
	func blank() async {
		let remote = PinRemote(file: page())
		let store = FileStore(fileId: "f1", remote: remote, preload: page())
		store.beginPin(at: origin)
		await store.commitDraft(comment: "   ")
		#expect(remote.saves.isEmpty)
		#expect(store.draft != nil)
	}

	@Test("a failed save rolls the list back and reports the error")
	func rollback() async {
		let remote = PinRemote(file: page())
		remote.fail = FileError("offline", isOffline: true)
		let store = FileStore(fileId: "f1", remote: remote, preload: page())
		store.beginPin(at: origin)
		await store.commitDraft(comment: "Nope")
		#expect(store.annotations.isEmpty)
		#expect(store.saveError == "offline")
		remote.fail = nil
		store.beginPin(at: origin)
		await store.commitDraft(comment: "Yes")
		#expect(store.annotations.count == 1)
		#expect(store.saveError == nil)
	}

	@Test("editing and deleting save the new list")
	func editDelete() async {
		let a = FileAnnotation(id: "a", pinNumber: 1, comment: "one", position: FilePoint(x: 0.1, y: 0.1))
		let b = FileAnnotation(id: "b", pinNumber: 2, comment: "two", position: FilePoint(x: 0.9, y: 0.9))
		let remote = PinRemote(file: page(annotations: [a, b]))
		let store = FileStore(fileId: "f1", remote: remote, preload: page(annotations: [a, b]))
		await store.updateComment(id: "a", comment: "uno")
		#expect(remote.saves.last?.annotations.map(\.comment) == ["uno", "two"])
		await store.remove(id: "b")
		#expect(remote.saves.last?.annotations.map(\.id) == ["a"])
		await store.updateComment(id: "a", comment: "uno")
		#expect(remote.saves.count == 2)  // unchanged comment: no request
	}

	@Test("edits made while a save is in flight are sent afterwards, in order, one request at a time")
	func coalesces() async {
		let a = FileAnnotation(id: "a", pinNumber: 1, comment: "one", position: FilePoint(x: 0.1, y: 0.1))
		let remote = PinRemote(file: page(annotations: [a]))
		remote.gate = { try? await Task.sleep(for: .milliseconds(60)) }
		let store = FileStore(fileId: "f1", remote: remote, preload: page(annotations: [a]))
		let first = Task { await store.updateComment(id: "a", comment: "first") }
		await Task.yield()
		let second = Task { await store.updateComment(id: "a", comment: "second") }
		await first.value
		await second.value
		#expect(remote.saves.map { $0.annotations.first?.comment } == ["first", "second"])
		#expect(store.annotations.first?.comment == "second")
	}

	@Test("pins only go on HTML pages, and never past the server's limit")
	func limits() {
		let text = FileStore(fileId: "f1", remote: PinRemote(file: page()), preload: page(mime: "text/plain"))
		#expect(!text.beginPin(at: origin))
		let many = (0..<FileAnnotationRules.maxCount).map {
			FileAnnotation(id: "p\($0)", pinNumber: $0 + 1, comment: "c", position: origin)
		}
		let full = FileStore(fileId: "f1", remote: PinRemote(file: page()), preload: page(annotations: many))
		#expect(!full.beginPin(at: origin))
	}

	@Test("loading numbers and positions pins another client left blank")
	func hydratesOnLoad() async {
		let bare = FileAnnotation(id: "a", comment: "from agent", bounds: FileBounds(x: 0.2, y: 0.4, w: 0.2, h: 0.2))
		let store = FileStore(fileId: "f1", remote: PinRemote(file: page(annotations: [bare])))
		await store.load()
		#expect(store.annotations.first?.pinNumber == 1)
		let position = store.annotations.first?.position
		#expect(abs((position?.x ?? 0) - 0.3) < 0.0001)
		#expect(abs((position?.y ?? 0) - 0.5) < 0.0001)
	}
}

@Suite("FileAnnotationRules")
struct FileAnnotationRulesTests {
	@Test("comments are trimmed and cut to 500 characters")
	func sanitize() {
		#expect(FileAnnotationRules.sanitized("  hi \n") == "hi")
		#expect(FileAnnotationRules.sanitized(String(repeating: "x", count: 900)).count == 500)
	}

	@Test("the next pin number follows the highest in use")
	func nextNumber() {
		#expect(FileAnnotationRules.nextPinNumber(in: []) == 1)
		let pins = [FileAnnotation(id: "a", pinNumber: 7, comment: ""), FileAnnotation(id: "b", pinNumber: 2, comment: "")]
		#expect(FileAnnotationRules.nextPinNumber(in: pins) == 8)
	}

	@Test("a tap near a pin finds it, a tap far away does not")
	func hit() {
		let pins = [FileAnnotation(id: "a", pinNumber: 1, comment: "", position: FilePoint(x: 0.5, y: 0.5))]
		#expect(FileAnnotationRules.pin(near: FilePoint(x: 0.51, y: 0.5), in: pins)?.id == "a")
		#expect(FileAnnotationRules.pin(near: FilePoint(x: 0.7, y: 0.5), in: pins) == nil)
	}

	@Test("points clamp into the page")
	func clamp() {
		#expect(FilePoint(x: -0.2, y: 1.4).clamped == FilePoint(x: 0, y: 1))
	}

	@Test("exported JSON matches the web shape and skips empty selectors")
	func export() throws {
		let pins = [
			FileAnnotation(id: "a", pinNumber: 1, comment: "hello", selector: "#x", bounds: FileBounds(x: 0, y: 0, w: 1, h: 1)),
			FileAnnotation(id: "b", pinNumber: 2, comment: "bye"),
		]
		let json = try #require(
			JSONSerialization.jsonObject(with: Data(FileAnnotationRules.exportJSON(pins).utf8)) as? [String: Any])
		let list = try #require(json["annotations"] as? [[String: Any]])
		#expect(list.count == 2)
		#expect(list[0]["selector"] as? String == "#x")
		#expect(list[1]["selector"] == nil)
		#expect(list[0]["pinNumber"] == nil)
	}
}

@Suite("MiniAppHTML")
struct MiniAppHTMLTests {
	@Test("injects the platform policy straight after <head>")
	func injects() {
		let out = MiniAppHTML.prepare("<html><head><title>x</title></head><body></body></html>")
		#expect(out.contains("<head><meta http-equiv=\"Content-Security-Policy\""))
		#expect(out.contains("connect-src 'none'"))
	}

	@Test("page-authored CSP and refresh metas are removed so the platform policy is the only one")
	func strips() {
		let html = """
			<!DOCTYPE html><meta HTTP-EQUIV='Content-Security-Policy' content="default-src *">\
			<meta http-equiv=refresh content="0;url=https://evil.example"><p>ok</p>
			"""
		let out = MiniAppHTML.prepare(html)
		#expect(!out.contains("default-src *"))
		#expect(!out.lowercased().contains("refresh"))
		#expect(out.contains("<p>ok</p>"))
		// After the doctype when there is no <head>, and before any content.
		#expect(out.hasPrefix("<!DOCTYPE html><meta http-equiv=\"Content-Security-Policy\""))
	}

	@Test("a fragment with no head or doctype gets the policy first")
	func fragment() {
		#expect(MiniAppHTML.prepare("<p>x</p>").hasPrefix("<meta http-equiv=\"Content-Security-Policy\""))
	}
}

@MainActor
@Suite("FilesListStore")
struct FilesListStoreTests {
	private final class ListRemote: FilesRemote, @unchecked Sendable {
		var rows: [FileSummary]
		var queries: [String] = []
		init(rows: [FileSummary]) { self.rows = rows }
		func file(id: String) async throws -> FileDetail { throw FileError("unused") }
		func list(query: String, limit: Int, offset: Int) async throws -> [FileSummary] {
			queries.append(query)
			let matching = rows.filter { query.isEmpty || $0.name.contains(query) }
			return Array(matching.dropFirst(offset).prefix(limit))
		}
	}

	private func rows(_ n: Int) -> [FileSummary] {
		(0..<n).map { FileSummary(id: "f\($0)", name: "file\($0).md", mimeType: "text/markdown", sizeBytes: 1) }
	}

	@Test("loads the first page and pages in more at the end")
	func paging() async {
		let store = FilesListStore(remote: ListRemote(rows: rows(70)))
		await store.load()
		#expect(store.files.count == FilesListStore.pageSize)
		#expect(store.hasMore)
		await store.loadMoreIfNeeded(current: store.files[0])
		#expect(store.files.count == FilesListStore.pageSize)  // not at the end yet
		await store.loadMoreIfNeeded(current: store.files.last!)
		#expect(store.files.count == 70)
		#expect(!store.hasMore)
	}

	@Test("searching reloads from the first page; an unchanged query does nothing")
	func search() async {
		let remote = ListRemote(rows: rows(12))
		let store = FilesListStore(remote: remote)
		await store.load()
		await store.setQuery(" file1 ")
		#expect(store.query == "file1")
		#expect(store.files.map(\.id) == ["f1", "f10", "f11"])
		await store.setQuery("file1")
		#expect(remote.queries == ["", "file1"])
	}

	@Test("a failed first load shows the message and the offline flag")
	func failures() async {
		struct Down: FilesRemote {
			func file(id: String) async throws -> FileDetail { throw FileError("x") }
			func list(query: String, limit: Int, offset: Int) async throws -> [FileSummary] {
				throw FileError("offline", isOffline: true)
			}
		}
		let failing = FilesListStore(remote: Down())
		await failing.load()
		#expect(failing.phase == .failed("offline"))
		#expect(failing.isOffline)
	}
}
