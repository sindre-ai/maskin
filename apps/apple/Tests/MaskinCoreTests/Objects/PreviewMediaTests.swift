import Foundation
import Testing

@testable import MaskinCore

@Suite("Draft preview media")
struct PreviewMediaTests {
	private func summary(_ id: String, _ name: String, _ mime: String, size: Int = 1_000) -> FileSummary {
		FileSummary(id: id, name: name, mimeType: mime, sizeBytes: size)
	}

	@Test("keeps the files in the order the draft lists them, not the order the server answered")
	func ordering() {
		let summaries = [
			summary("c", "3.png", "image/png"), summary("a", "1.png", "image/png"),
			summary("b", "2.png", "image/png"),
		]
		let items = PreviewMedia.items(ids: ["a", "b", "c"], summaries: summaries)
		#expect(items.map(\.file.name) == ["1.png", "2.png", "3.png"])
	}

	@Test("leaves out a file nobody can read, without a placeholder or an id")
	func skipsUnreadable() {
		let items = PreviewMedia.items(
			ids: ["a", "gone", "b"],
			summaries: [summary("a", "1.png", "image/png"), summary("b", "2.png", "image/png")])
		#expect(items.map(\.id) == ["a", "b"])
	}

	@Test("draws a repeated id once and matches ids ignoring case")
	func dedupesAndIgnoresCase() {
		let items = PreviewMedia.items(
			ids: ["ABC", "abc", "Abc"], summaries: [summary("abc", "1.png", "image/png")])
		#expect(items.count == 1)
	}

	@Test("tells pictures, videos and documents apart, including by extension")
	func kinds() {
		let items = PreviewMedia.items(
			ids: ["i", "v", "p", "o"],
			summaries: [
				summary("i", "slide.png", "image/png"), summary("v", "clip.mp4", "video/mp4"),
				summary("p", "deck.pdf", "application/pdf"),
				summary("o", "photo.jpg", "application/octet-stream"),
			])
		#expect(items.map(\.kind) == [.image, .video, .other, .image])
	}

	@Test("says where you are as 3 / 7, and says nothing for a single file")
	func counter() {
		#expect(PreviewMedia.counterText(index: 2, count: 7) == "3 / 7")
		#expect(PreviewMedia.counterText(index: 0, count: 1) == "")
	}

	@Test("labels each page for VoiceOver as Image 3 of 7")
	func accessibility() {
		let image = PreviewMediaItem(
			file: FileReference(id: "a", name: "1.png", mimeType: "image/png", sizeBytes: 1))
		let video = PreviewMediaItem(
			file: FileReference(id: "b", name: "c.mp4", mimeType: "video/mp4", sizeBytes: 1))
		#expect(PreviewMedia.accessibilityLabel(for: image, index: 2, count: 7) == "Image 3 of 7")
		#expect(PreviewMedia.accessibilityLabel(for: video, index: 0, count: 2) == "Video 1 of 2")
		#expect(PreviewMedia.accessibilityLabel(for: image, index: 0, count: 1) == "Image")
	}

	@Test("a preview stored before media existed still decodes, with no media")
	func olderPreviewDecodes() throws {
		let json = """
			{"kind":"linkedin_post","label":"LinkedIn post","recipients":[],"details":[],
			"body":"Hi","missing":[],"warnings":[],"contentHash":"h"}
			"""
		let preview = try JSONDecoder().decode(ObjectPreview.self, from: Data(json.utf8))
		#expect(preview.mediaFileIDs.isEmpty)
	}

	@Test("a preview round-trips its media ids")
	func roundTrip() throws {
		let preview = ObjectPreview(
			kind: "linkedin_post", label: "LinkedIn post", mediaFileIDs: ["a", "b"], body: "Hi", contentHash: "h")
		let again = try JSONDecoder().decode(ObjectPreview.self, from: JSONEncoder().encode(preview))
		#expect(again.mediaFileIDs == ["a", "b"])
	}
}

@MainActor
@Suite("LinkedItemStore draft media")
struct LinkedItemStorePreviewMediaTests {
	private func make(_ files: FakeLinkedFiles) -> LinkedItemStore {
		LinkedItemStore(objects: FakeDraftsRemote(), files: files, workspaceID: { "ws-1" })
	}

	@Test("reads the files in one request, in the draft's order, and not again for the same ids")
	func oneRequestThenCached() async {
		let files = FakeLinkedFiles()
		files.set([
			FileSummary(id: "b", name: "2.png", mimeType: "image/png", sizeBytes: 1),
			FileSummary(id: "a", name: "1.png", mimeType: "image/png", sizeBytes: 1),
		])
		let store = make(files)
		let first = await store.previewMedia(ids: ["a", "b"])
		let second = await store.previewMedia(ids: ["a", "b"])
		#expect(first.map(\.id) == ["a", "b"])
		#expect(second == first)
		#expect(files.calls == 1)
	}

	@Test("draws nothing, and does not throw, when the files cannot be read")
	func failedReadDrawsNothing() async {
		let files = FakeLinkedFiles()
		files.fails = true
		let items = await make(files).previewMedia(ids: ["a"])
		#expect(items.isEmpty)
	}
}
