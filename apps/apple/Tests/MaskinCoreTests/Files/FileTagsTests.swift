import Foundation
import HTTPTypes
import MaskinAPI
import OpenAPIRuntime
import Testing

@testable import MaskinCore

@Suite("FileTagRules")
struct FileTagRulesTests {
	@Test("trims and lowercases, so B-roll and b-roll are one tag")
	func spelling() {
		#expect(FileTagRules.normalized("  B-Roll ") == "b-roll")
		#expect(FileTagRules.normalized("Clip_Type:B_Roll") == "clip_type:b_roll")
	}

	@Test("refuses what the server would refuse", arguments: ["", "   ", "a,b", String(repeating: "x", count: 61)])
	func refused(raw: String) {
		#expect(FileTagRules.normalized(raw) == nil)
	}

	@Test("keeps a 60 character tag")
	func longest() {
		let tag = String(repeating: "x", count: FileTagRules.maxLength)
		#expect(FileTagRules.normalized(tag) == tag)
	}

	@Test("sorts A to Z, ignoring case")
	func order() {
		#expect(FileTagRules.sorted(["interview", "B-roll", "audio"]) == ["audio", "B-roll", "interview"])
		let counts = [FileTagCount(tag: "b", count: 9), FileTagCount(tag: "a", count: 1)]
		#expect(FileTagRules.sorted(counts).map(\.tag) == ["a", "b"])
	}
}

private final class TagRemote: FilesRemote, @unchecked Sendable {
	var rows: [FileSummary] = []
	var counts: [FileTagCount] = []
	var stored: [String] = []
	var failSave = false
	private(set) var lists: [(query: String, tags: [String], match: FileTagMatch, offset: Int)] = []
	private(set) var saves: [[String]] = []
	var changeError: String?
	private(set) var changes: [String] = []

	func renameTag(from: String, to: String) async throws -> FileTagChange {
		if let changeError { throw FileError(changeError) }
		changes.append("rename \(from) -> \(to)")
		return FileTagChange(from: from, to: to, filesChanged: 3)
	}

	func mergeTag(from: String, into: String) async throws -> FileTagChange {
		if let changeError { throw FileError(changeError) }
		changes.append("merge \(from) -> \(into)")
		return FileTagChange(from: from, to: into, filesChanged: 2)
	}

	func file(id: String) async throws -> FileDetail {
		FileDetail(id: id, name: "clip.md", mimeType: "text/markdown", sizeBytes: 1, data: Data("x".utf8))
	}

	func list(query: String, tags: [String], match: FileTagMatch, limit: Int, offset: Int) async throws
		-> [FileSummary]
	{
		lists.append((query, tags, match, offset))
		return Array(rows.dropFirst(offset).prefix(limit))
	}

	func tagCounts() async throws -> [FileTagCount] { counts }
	func tags(ofFile id: String) async throws -> [String] { stored }

	func saveTags(fileId: String, tags: [String], idempotencyKey: String) async throws -> [String] {
		saves.append(tags)
		if failSave { throw FileError("nope") }
		stored = tags
		return tags
	}
}

@MainActor
@Suite("FilesListStore tag filter")
struct FilesListStoreTagTests {
	@Test("a picked tag reloads from the first page with the tag and the match")
	func picking() async {
		let remote = TagRemote()
		let store = FilesListStore(remote: remote)
		await store.load()
		await store.setTags(["b-roll", "interview"])
		await store.setMatch(.any)
		#expect(store.selectedTags == ["b-roll", "interview"])
		#expect(remote.lists.last?.tags == ["b-roll", "interview"])
		#expect(remote.lists.last?.match == .any)
		#expect(remote.lists.last?.offset == 0)
	}

	@Test("changing the match with nothing picked does not reload; an unchanged pick does nothing")
	func noOps() async {
		let remote = TagRemote()
		let store = FilesListStore(remote: remote)
		await store.load()
		await store.setMatch(.any)
		#expect(remote.lists.count == 1)
		await store.setTags([])
		#expect(remote.lists.count == 1)
		await store.setTags(["a"])
		await store.setTags(["a"])
		#expect(remote.lists.count == 2)
	}

	@Test("the filter is hidden until a tag exists, and a picked tag with no files stays listed")
	func options() async {
		let remote = TagRemote()
		remote.counts = [FileTagCount(tag: "interview", count: 2), FileTagCount(tag: "b-roll", count: 5)]
		let store = FilesListStore(remote: remote)
		#expect(!store.hasTagFilter)
		await store.loadTags()
		#expect(store.hasTagFilter)
		#expect(store.tagOptions.map(\.tag) == ["b-roll", "interview"])
		await store.setTags(["gone"])
		#expect(store.tagOptions.map(\.tag) == ["b-roll", "gone", "interview"])
		#expect(store.tagOptions.first { $0.tag == "gone" }?.count == 0)
	}
}

@MainActor
@Suite("FileStore tags")
struct FileStoreTagTests {
	@Test("a file with no tags has none")
	func empty() async {
		let store = FileStore(fileId: "f1", remote: TagRemote())
		await store.load()
		#expect(store.tags.isEmpty)
	}

	@Test("loads the stored tags A to Z")
	func loads() async {
		let remote = TagRemote()
		remote.stored = ["interview", "b-roll"]
		let store = FileStore(fileId: "f1", remote: remote)
		await store.load()
		#expect(store.tags == ["b-roll", "interview"])
	}

	@Test("adding saves the whole list in the server's spelling; a repeat or a refused tag is ignored")
	func adding() async {
		let remote = TagRemote()
		remote.stored = ["b-roll"]
		let store = FileStore(fileId: "f1", remote: remote)
		await store.load()
		await store.addTag("  Interview ")
		await store.addTag("B-Roll")
		await store.addTag("a,b")
		await store.addTag("   ")
		#expect(remote.saves == [["b-roll", "interview"]])
		#expect(store.tags == ["b-roll", "interview"])
		#expect(store.tagError == nil)
	}

	@Test("removing saves the list without it")
	func removing() async {
		let remote = TagRemote()
		remote.stored = ["a", "b"]
		let store = FileStore(fileId: "f1", remote: remote)
		await store.load()
		await store.removeTag("a")
		#expect(remote.saves == [["b"]])
		#expect(store.tags == ["b"])
	}

	@Test("a failed save puts the tags back and says so")
	func rollback() async {
		let remote = TagRemote()
		remote.stored = ["a"]
		remote.failSave = true
		let store = FileStore(fileId: "f1", remote: remote)
		await store.load()
		await store.addTag("b")
		#expect(store.tags == ["a"])
		#expect(store.tagError == "nope")
	}

	@Test("stops at the most tags a file can hold")
	func limit() async {
		let remote = TagRemote()
		remote.stored = (0..<FileTagRules.maxPerFile).map { "t\($0)" }
		let store = FileStore(fileId: "f1", remote: remote)
		await store.load()
		#expect(!store.canAddTag)
		await store.addTag("one-more")
		#expect(remote.saves.isEmpty)
	}

	@Test("offers workspace tags the file does not have yet")
	func suggestions() async {
		let remote = TagRemote()
		remote.stored = ["b-roll"]
		remote.counts = [FileTagCount(tag: "interview", count: 2), FileTagCount(tag: "b-roll", count: 5)]
		let store = FileStore(fileId: "f1", remote: remote)
		await store.load()
		await store.loadTagCounts()
		#expect(store.suggestedTags.map(\.tag) == ["interview"])
	}
}

@MainActor
@Suite("FilesListStore tag rename and merge")
struct FilesListStoreTagChangeTests {
	@Test("a rename reloads the list and the counts, and a picked tag follows its new name")
	func rename() async {
		let remote = TagRemote()
		remote.counts = [FileTagCount(tag: "broll", count: 3)]
		let store = FilesListStore(remote: remote)
		await store.setTags(["broll", "raw"])
		let loadsBefore = remote.lists.count

		let change = await store.renameTag("broll", to: "b-roll")

		#expect(change == FileTagChange(from: "broll", to: "b-roll", filesChanged: 3))
		#expect(remote.changes == ["rename broll -> b-roll"])
		#expect(store.selectedTags == ["b-roll", "raw"])
		#expect(remote.lists.count == loadsBefore + 1)
		#expect(remote.lists.last?.tags == ["b-roll", "raw"])
		#expect(store.tagChangeError == nil)
	}

	@Test("a merge into a tag that is already picked keeps one copy of it")
	func mergeIntoPicked() async {
		let remote = TagRemote()
		let store = FilesListStore(remote: remote)
		await store.setTags(["broll", "b-roll"])

		_ = await store.mergeTag("broll", into: "b-roll")

		#expect(remote.changes == ["merge broll -> b-roll"])
		#expect(store.selectedTags == ["b-roll"])
	}

	@Test("a refused change keeps the picked tags and shows the server's reason")
	func refused() async {
		let remote = TagRemote()
		remote.changeError = "That name is already a tag. Merge into it instead."
		let store = FilesListStore(remote: remote)
		await store.setTags(["broll"])

		let change = await store.renameTag("broll", to: "b-roll")

		#expect(change == nil)
		#expect(store.selectedTags == ["broll"])
		#expect(store.tagChangeError == "That name is already a tag. Merge into it instead.")
		store.clearTagChangeError()
		#expect(store.tagChangeError == nil)
	}
}

@Suite("APIFilesRemote tag requests")
struct APIFilesRemoteTagRequestTests {
	private struct NoTransport: ClientTransport {
		func send(_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String) async throws
			-> (HTTPResponse, HTTPBody?)
		{
			(HTTPResponse(status: .notFound), nil)
		}
	}

	private func remote() -> APIFilesRemote {
		APIFilesRemote(
			client: Client(serverURL: URL(string: "http://localhost:3000")!, transport: NoTransport()),
			credentials: { MaskinCredentials(apiKey: "ank_x", workspaceId: "ws-1") },
			baseURL: URL(string: "http://localhost:3000")!, clientSource: "ios")
	}

	private let transport = APIFilesRemote.RawTransport(
		baseURL: URL(string: "http://localhost:3000")!, clientSource: "ios", session: .shared)

	@Test("the filtered list carries the tags, the match, the workspace and the key")
	func filteredList() async throws {
		let request = await remote().makeRequest(
			method: "GET", path: "api/files",
			query: [
				URLQueryItem(name: "tags", value: "b-roll,interview"),
				URLQueryItem(name: "tags_match", value: "any"),
			], body: nil, idempotencyKey: nil, transport: transport)
		let url = try #require(request.url)
		let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
		#expect(url.path == "/api/files")
		#expect(items.first { $0.name == "tags" }?.value == "b-roll,interview")
		#expect(items.first { $0.name == "tags_match" }?.value == "any")
		#expect(request.httpMethod == "GET")
		#expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer ank_x")
		#expect(request.value(forHTTPHeaderField: "X-Workspace-Id") == "ws-1")
		#expect(request.value(forHTTPHeaderField: "X-Client-Source") == "ios")
		#expect(request.httpBody == nil)
	}

	@Test("a tag save patches the whole list with an idempotency key")
	func save() async throws {
		let body = try JSONEncoder().encode(["tags": ["a", "b"]])
		let request = await remote().makeRequest(
			method: "PATCH", path: "api/files/f1", query: [], body: body, idempotencyKey: "key-1",
			transport: transport)
		#expect(request.url?.path == "/api/files/f1")
		#expect(request.httpMethod == "PATCH")
		#expect(request.value(forHTTPHeaderField: "Idempotency-Key") == "key-1")
		#expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
		let sent = try JSONDecoder().decode([String: [String]].self, from: try #require(request.httpBody))
		#expect(sent == ["tags": ["a", "b"]])
	}

	@Test("a rename and a merge post the old and new tag to their own routes")
	func changeRequests() async throws {
		let body = try JSONEncoder().encode(["from": "broll", "to": "b-roll"])
		let request = await remote().makeRequest(
			method: "POST", path: "api/files/tags/rename", query: [], body: body, idempotencyKey: nil,
			transport: transport)
		#expect(request.url?.path == "/api/files/tags/rename")
		#expect(request.httpMethod == "POST")
		#expect(request.value(forHTTPHeaderField: "X-Workspace-Id") == "ws-1")
		let sent = try JSONDecoder().decode([String: String].self, from: try #require(request.httpBody))
		#expect(sent == ["from": "broll", "to": "b-roll"])
	}

	@Test("without a raw transport the tag calls say tags aren't available")
	func noTransport() async {
		let plain = APIFilesRemote(
			client: Client(serverURL: URL(string: "http://localhost:3000")!, transport: NoTransport()))
		await #expect(throws: FileError.self) { try await plain.tagCounts() }
		await #expect(throws: FileError.self) { try await plain.renameTag(from: "a", to: "b") }
		await #expect(throws: FileError.self) { try await plain.mergeTag(from: "a", into: "b") }
	}

	@Test("reads tag counts and a file's tags from the server's JSON")
	func decoding() throws {
		struct Count: Decodable { var tag: String; var count: Int }
		let counts = try APIFilesRemote.decode(
			[Count].self, from: Data(#"[{"tag":"b-roll","count":5}]"#.utf8))
		#expect(counts.first?.count == 5)
		#expect(throws: FileError.self) { try APIFilesRemote.decode([Count].self, from: Data("nope".utf8)) }
	}
}
