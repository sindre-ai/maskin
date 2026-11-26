import Foundation
import Testing

@testable import MaskinCore

private struct StubFiles: FilesRemote {
	var detail: FileDetail
	func file(id: String) async throws -> FileDetail { detail }
}

private func root() -> URL {
	FileManager.default.temporaryDirectory.appendingPathComponent("attachment-test-\(UUID().uuidString)")
}

@Suite("AttachmentDownloader")
struct AttachmentDownloaderTests {
	@Test("writes an inline file under its own name, in a folder per file")
	func writesInline() async throws {
		let root = root()
		defer { AttachmentDownloader.clearAll(in: root) }
		let file = FileDetail(id: "f1", name: "plan.pdf", mimeType: "application/pdf", sizeBytes: 3, data: Data([1, 2, 3]))
		let url = try await AttachmentDownloader(remote: StubFiles(detail: file), root: root).localURL(forFile: "f1")
		#expect(url.lastPathComponent == "plan.pdf")
		#expect(url.deletingLastPathComponent().lastPathComponent == "f1")
		#expect(try Data(contentsOf: url) == Data([1, 2, 3]))
	}

	@Test("two files with the same name do not overwrite each other")
	func sameName() async throws {
		let root = root()
		defer { AttachmentDownloader.clearAll(in: root) }
		let a = FileDetail(id: "a", name: "scan.jpg", mimeType: "image/jpeg", sizeBytes: 1, data: Data([1]))
		let b = FileDetail(id: "b", name: "scan.jpg", mimeType: "image/jpeg", sizeBytes: 1, data: Data([2]))
		let first = try await AttachmentDownloader(remote: StubFiles(detail: a), root: root).localURL(forFile: "a")
		let second = try await AttachmentDownloader(remote: StubFiles(detail: b), root: root).localURL(forFile: "b")
		#expect(first != second)
		#expect(try Data(contentsOf: first) == Data([1]))
	}

	@Test("a name with path separators stays inside the folder")
	func safeName() async throws {
		let root = root()
		defer { AttachmentDownloader.clearAll(in: root) }
		let file = FileDetail(id: "f1", name: "../../evil.txt", mimeType: "text/plain", sizeBytes: 1, data: Data([1]))
		let url = try await AttachmentDownloader(remote: StubFiles(detail: file), root: root).localURL(forFile: "f1")
		#expect(url.path.hasPrefix(root.path))
	}

	@Test("a file over the inline cap is fetched from its download link")
	func largeFile() async throws {
		let root = root()
		defer { AttachmentDownloader.clearAll(in: root) }
		let link = URL(string: "https://example.com/big.mov")!
		var file = FileDetail(id: "v1", name: "big.mov", mimeType: "video/quicktime", sizeBytes: 9, data: Data())
		file.contentOmitted = true
		file.downloadURL = link
		let downloader = AttachmentDownloader(remote: StubFiles(detail: file), root: root) { url in
			#expect(url == link)
			let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
			try Data(repeating: 7, count: 9).write(to: temporary)
			return temporary
		}
		let url = try await downloader.localURL(forFile: "v1")
		#expect(try Data(contentsOf: url) == Data(repeating: 7, count: 9))
	}

	@Test("a large file with no download link says it is too big")
	func largeWithoutLink() async {
		let root = root()
		defer { AttachmentDownloader.clearAll(in: root) }
		var file = FileDetail(id: "v1", name: "big.mov", mimeType: "video/quicktime", sizeBytes: 9, data: Data())
		file.contentOmitted = true
		await #expect(throws: FileError.self) {
			try await AttachmentDownloader(remote: StubFiles(detail: file), root: root).localURL(forFile: "v1")
		}
	}
}

@Suite("AttachmentSaveRules")
struct AttachmentSaveRulesTests {
	@Test("pictures and videos can go to Photos, other files only to Files")
	func kinds() {
		#expect(AttachmentSaveRules.kind(mimeType: "image/jpeg", name: "a.jpg") == .photo)
		#expect(AttachmentSaveRules.kind(mimeType: "video/quicktime", name: "a.mov") == .video)
		// A generic type falls back to the extension.
		#expect(AttachmentSaveRules.kind(mimeType: "application/octet-stream", name: "clip.MP4") == .video)
		#expect(AttachmentSaveRules.kind(mimeType: nil, name: "shot.HEIC") == .photo)
		#expect(AttachmentSaveRules.kind(mimeType: "application/pdf", name: "plan.pdf") == nil)
		#expect(AttachmentSaveRules.kind(mimeType: nil, name: nil) == nil)
		#expect(AttachmentSaveRules.canSaveToPhotos(mimeType: "image/png", name: nil))
		#expect(!AttachmentSaveRules.canSaveToPhotos(mimeType: "text/plain", name: "notes.txt"))
	}
}
