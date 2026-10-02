import CoreGraphics
import Foundation
import ImageIO
import Testing

@testable import MaskinCore

private struct StubFiles: FilesRemote {
	var result: Result<FileDetail, FileError>
	func file(id: String) async throws -> FileDetail { try result.get() }
}

private func detail(_ mime: String, name: String = "note.md", text: String = "# Hi") -> FileDetail {
	FileDetail(id: "f1", name: name, mimeType: mime, sizeBytes: text.utf8.count, data: Data(text.utf8))
}

@Suite("FileContentKind")
struct FileContentKindTests {
	@Test("routes MIME types to a viewer", arguments: [
		("text/markdown", FileContentKind.markdown),
		("text/markdown; charset=utf-8", .markdown),
		("text/plain", .text),
		("application/json", .text),
		("text/html", .source),
		("image/svg+xml", .source),
		("image/png", .image),
		("application/pdf", .pdf),
		("application/zip", .other),
	])
	func routes(mime: String, kind: FileContentKind) {
		#expect(FileContentKind.classify(mimeType: mime) == kind)
	}

	@Test("octet-stream falls back to the file extension")
	func extensionFallback() {
		#expect(FileContentKind.classify(mimeType: "application/octet-stream", name: "Plan.MD") == .markdown)
		#expect(FileContentKind.classify(mimeType: "application/octet-stream", name: "scan.pdf") == .pdf)
		#expect(FileContentKind.classify(mimeType: "application/octet-stream", name: "blob.bin") == .other)
	}
}

@MainActor
@Suite("FileStore")
struct FileStoreTests {
	@Test("loads a file and exposes its text")
	func loads() async {
		let store = FileStore(fileId: "f1", remote: StubFiles(result: .success(detail("text/markdown"))))
		#expect(store.phase == .idle)
		await store.load()
		#expect(store.phase == .loaded)
		#expect(store.file?.kind == .markdown)
		#expect(store.file?.text == "# Hi")
	}

	@Test("a missing file reports not found without a retry-worthy error")
	func notFound() async {
		let error = FileError("gone", isNotFound: true)
		let store = FileStore(fileId: "f1", remote: StubFiles(result: .failure(error)))
		await store.load()
		#expect(store.phase == .failed("gone"))
		#expect(store.isNotFound)
	}

	@Test("an offline failure is flagged, and a failed refresh keeps the loaded file")
	func offlineKeepsFile() async {
		let store = FileStore(
			fileId: "f1", remote: StubFiles(result: .failure(FileError("off", isOffline: true))),
			preload: detail("text/plain"))
		await store.load()
		#expect(store.phase == .loaded)
		#expect(store.isOffline)
		#expect(store.file != nil)
	}

	@Test("loading decodes the text once and bumps the revision only when bytes change")
	func decodesOnce() async {
		let store = FileStore(fileId: "f1", remote: StubFiles(result: .success(detail("text/markdown"))))
		await store.load()
		#expect(store.text == "# Hi")
		let first = store.contentRevision
		await store.load()
		#expect(store.contentRevision == first)
	}

	@Test("a refresh with different bytes bumps the revision (PDF/image views must update)")
	func revisionOnChange() async {
		final class Box: @unchecked Sendable { var detail: FileDetail; init(_ d: FileDetail) { detail = d } }
		struct Changing: FilesRemote {
			let box: Box
			func file(id: String) async throws -> FileDetail { box.detail }
		}
		let box = Box(detail("application/pdf", text: "one"))
		let store = FileStore(fileId: "f1", remote: Changing(box: box))
		await store.load()
		let first = store.contentRevision
		box.detail = detail("application/pdf", text: "two")
		await store.load()
		#expect(store.contentRevision == first + 1)
	}

	@Test("size text is human readable")
	func sizeHuman() {
		#expect(FileStore.sizeText(2_500_000).contains("MB"))
	}
}

@Suite("FileExporter")
struct FileExporterTests {
	private func root() -> URL {
		FileManager.default.temporaryDirectory.appendingPathComponent("export-test-\(UUID().uuidString)")
	}

	@Test("writes the bytes under the original file name")
	func writes() throws {
		let root = root()
		defer { FileExporter.clearAll(in: root) }
		let url = try FileExporter.write(detail("text/markdown"), in: root)
		#expect(url.lastPathComponent == "note.md")
		#expect(try Data(contentsOf: url) == Data("# Hi".utf8))
	}

	@Test("a second export replaces the first; clearAll removes everything")
	func cleans() throws {
		let root = root()
		let first = try FileExporter.write(detail("text/plain", name: "a.txt"), in: root)
		_ = try FileExporter.write(detail("text/plain", name: "b.txt"), in: root)
		#expect(!FileManager.default.fileExists(atPath: first.path))
		FileExporter.clearAll(in: root)
		#expect(!FileManager.default.fileExists(atPath: root.path))
	}

	@Test("names over 255 bytes still export, keeping the extension")
	func longName() throws {
		let root = root()
		defer { FileExporter.clearAll(in: root) }
		let name = String(repeating: "é", count: 300) + ".pdf"
		let url = try FileExporter.write(detail("application/pdf", name: name), in: root)
		#expect(url.lastPathComponent.utf8.count <= 255)
		#expect(url.lastPathComponent.hasSuffix(".pdf"))
	}

	@Test("hostile names are neutralised", arguments: [
		("../../etc/passwd", "..-..-etc-passwd"), ("a/b.txt", "a-b.txt"), ("..", "file"), ("", "file"),
		("  ", "file"), ("a\u{0}b", "a-b"),
	])
	func safeNames(raw: String, expected: String) {
		#expect(FileExporter.safeName(raw) == expected)
	}
}

@Suite("FileImageDecoder")
struct FileImageDecoderTests {
	private func png(width: Int, height: Int) throws -> Data {
		let context = try #require(CGContext(
			data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
			space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
		context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
		context.fill(CGRect(x: 0, y: 0, width: width, height: height))
		let image = try #require(context.makeImage())
		let data = NSMutableData()
		let destination = try #require(CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil))
		CGImageDestinationAddImage(destination, image, nil)
		#expect(CGImageDestinationFinalize(destination))
		return data as Data
	}

	@Test("a large image is decoded no bigger than the display bound")
	func bounded() throws {
		let decoded = try #require(FileImageDecoder.thumbnail(try png(width: 4000, height: 3000)))
		#expect(max(decoded.cgImage.width, decoded.cgImage.height) <= FileImageDecoder.maxDisplayPixels)
	}

	@Test("an image declaring more pixels than allowed is refused, not decoded")
	func refusesBombs() throws {
		let data = try png(width: 100, height: 100)
		#expect(FileImageDecoder.thumbnail(data, maxSourcePixels: 5_000) == nil)
		#expect(FileImageDecoder.thumbnail(Data("not an image".utf8)) == nil)
	}
}

@Suite("FileTextWindow")
struct FileTextWindowTests {
	@Test("shows a prefix of long text and says it was cut")
	func truncates() {
		let text = String(repeating: "a", count: 250_000)
		let window = FileTextWindow.prefix(text, limit: FileTextWindow.step)
		#expect(window.shown.count == FileTextWindow.step)
		#expect(window.isTruncated)
		#expect(!FileTextWindow.prefix("short", limit: FileTextWindow.step).isTruncated)
	}
}
