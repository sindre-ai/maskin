import Foundation
import Testing
import UniformTypeIdentifiers

@testable import MaskinCore

private func session() -> InMemorySecretStore {
	InMemorySecretStore(
		try! JSONEncoder().encode(StoredSession(apiKey: "ank_x", actorId: "a", name: "S", workspaceId: "ws-1")))
}

private func defaults() -> UserDefaults {
	let suite = "share-hardening-\(UUID().uuidString)"
	return UserDefaults(suiteName: suite)!
}

/// Holds `workspace()` until released, to observe the loading window.
private final class GatedRemote: ShareRemote, @unchecked Sendable {
	private let inner = FakeShareRemote()
	private let lock = NSLock()
	private var waiter: CheckedContinuation<Void, Never>?
	private var released = false

	func release() {
		lock.withLock {
			released = true
			waiter?.resume()
			waiter = nil
		}
	}

	func workspace() async throws -> ShareWorkspace {
		await withCheckedContinuation { continuation in
			lock.withLock {
				if released { continuation.resume() } else { waiter = continuation }
			}
		}
		return try await inner.workspace()
	}
	func createObject(type: String, title: String, content: String, status: String, idempotencyKey: String)
		async throws -> String
	{ try await inner.createObject(type: type, title: title, content: content, status: status, idempotencyKey: idempotencyKey) }
	func uploadFile(name: String, mimeType: String, fileURL: URL, idempotencyKey: String) async throws -> String {
		try await inner.uploadFile(name: name, mimeType: mimeType, fileURL: fileURL, idempotencyKey: idempotencyKey)
	}
	func attach(fileID: String, toObject objectID: String, objectType: String, idempotencyKey: String) async throws {
		try await inner.attach(fileID: fileID, toObject: objectID, objectType: objectType, idempotencyKey: idempotencyKey)
	}
}

@Suite("Share hardening")
@MainActor
struct ShareHardeningTests {
	private let link = ShareContent(link: URL(string: "https://example.com/p")!, linkTitle: "A page")

	@Test("Send stays disabled until the workspace schema has loaded")
	func sendWaitsForSchema() async {
		let remote = GatedRemote()
		let model = ShareSheetModel(secretStore: session(), loadContent: { [link] in link }, makeRemote: { _ in remote })
		let started = Task { await model.start() }
		while model.phase == .loading { await Task.yield() }
		#expect(model.phase == .ready)
		#expect(model.isLoadingSchema)
		#expect(!model.canPost)
		remote.release()
		await started.value
		#expect(!model.isLoadingSchema)
		#expect(model.canPost)
	}

	@Test("an offline schema fetch still ends the loading state, with the fallback types")
	func offlineSchemaStillSends() async {
		let remote = FakeShareRemote()
		remote.workspaceResult = .failure(.offline)
		let model = ShareSheetModel(secretStore: session(), loadContent: { [link] in link }, makeRemote: { _ in remote })
		await model.start()
		#expect(model.canPost)
	}

	@Test("a title or note typed by the person is a draft; the suggested title alone is not")
	func unsentText() async {
		let model = ShareSheetModel(secretStore: session(), loadContent: { [link] in link }, makeRemote: { _ in FakeShareRemote() })
		await model.start()
		#expect(!model.hasUnsentText)
		model.note = "  follow up Monday "
		#expect(model.hasUnsentText)
		model.note = ""
		model.title = "My own title"
		#expect(model.hasUnsentText)
	}

	@Test("a saved draft comes back for the same content and is cleared once sent")
	func draftRoundTrip() async {
		let store = ShareDraftStore(defaults: defaults())
		let first = ShareSheetModel(
			secretStore: session(), loadContent: { [link] in link }, makeRemote: { _ in FakeShareRemote() }, drafts: store)
		await first.start()
		first.note = "Remember to ask Anna"
		first.saveDraft()

		let second = ShareSheetModel(
			secretStore: session(), loadContent: { [link] in link }, makeRemote: { _ in FakeShareRemote() }, drafts: store)
		await second.start()
		#expect(second.note == "Remember to ask Anna")
		await second.post()
		#expect(store.load(fingerprint: second.content.fingerprint) == nil)
	}

	@Test("a draft is not applied to different content")
	func draftIgnoredForOtherContent() async {
		let store = ShareDraftStore(defaults: defaults())
		store.save(fingerprint: "other", title: "t", note: "n")
		let model = ShareSheetModel(
			secretStore: session(), loadContent: { [link] in link }, makeRemote: { _ in FakeShareRemote() }, drafts: store)
		await model.start()
		#expect(model.note.isEmpty)
	}

	@Test("a discarded draft is gone")
	func discard() async {
		let store = ShareDraftStore(defaults: defaults())
		let model = ShareSheetModel(
			secretStore: session(), loadContent: { [link] in link }, makeRemote: { _ in FakeShareRemote() }, drafts: store)
		await model.start()
		model.note = "x"
		model.saveDraft()
		model.discardDraft()
		#expect(store.load(fingerprint: model.content.fingerprint) == nil)
	}

	@Test("Copy text carries the title, note and link so a blocked screen can still hand them back")
	func copyable() async {
		let model = ShareSheetModel(secretStore: session(), loadContent: { [link] in link }, makeRemote: { _ in FakeShareRemote() })
		await model.start()
		model.title = "Idea"
		model.note = "Look at this"
		#expect(model.copyableText == "Idea\n\nLook at this\n\n[A page](https://example.com/p)")
	}

	@Test("a failed post that already created the object says so, for the Retry hint")
	func createdBeforeFailure() async {
		let scratch = ShareScratch()
		let file = scratch.file("a.pdf", bytes: 10)
		let attachment = ShareAttachment(
			kind: .pdf, name: "a.pdf", mimeType: "application/pdf", fileURL: file, sizeBytes: 10)
		let remote = FakeShareRemote()
		remote.failNext("upload", with: .rejected)
		let model = ShareSheetModel(
			secretStore: session(), loadContent: { ShareContent(link: URL(string: "https://e.com")!, attachments: [attachment]) },
			makeRemote: { _ in remote })
		await model.start()
		await model.post()
		#expect(model.phase == .failed(.rejected))
		#expect(model.createdObjectBeforeFailure)
	}

	@Test("a share whose only item was too large says why instead of 'nothing here'")
	func onlyItemTooLarge() async {
		let skipped = ShareContent(skipped: [ShareSkip(name: "Big.pdf", reason: .tooLarge)])
		let model = ShareSheetModel(secretStore: session(), loadContent: { skipped }, makeRemote: { _ in FakeShareRemote() })
		await model.start()
		#expect(model.phase == .blocked(.nothingToShare))
		#expect(model.blockedDetail == "Big.pdf is over 10 MB, so it wasn't added.")
	}
}

@Suite("Share extraction hardening")
struct ShareExtractionHardeningTests {
	private let scratch = ShareScratch()

	@Test("text over the limit is cut and says so")
	func truncationNoted() async {
		let extractor = ShareExtractor(workDirectory: scratch.url.appendingPathComponent("w"))
		let long = String(repeating: "a", count: ShareLimits.maxTextCharacters + 5)
		let content = await extractor.extract(from: [.text(long)])
		#expect(content.text?.count == ShareLimits.maxTextCharacters)
		#expect(content.skipped.contains { $0.reason == .truncatedText })
	}

	@Test("a web image keeps the address of the page it came from")
	func webImageKeepsLink() async {
		let image = scratch.image("p.jpg", width: 64, height: 64)
		let source = ShareFakeSource(
			typeIdentifiers: [UTType.jpeg.identifier, UTType.url.identifier], url: URL(string: "https://example.com/page"),
			file: image)
		let content = await ShareExtractor(workDirectory: scratch.url.appendingPathComponent("w")).extract(from: [source])
		#expect(content.attachments.count == 1)
		#expect(content.link == URL(string: "https://example.com/page"))
	}

	@Test("a plain image has no link")
	func plainImageNoLink() async {
		let image = scratch.image("p.jpg", width: 64, height: 64)
		let content = await ShareExtractor(workDirectory: scratch.url.appendingPathComponent("w"))
			.extract(from: [.image(image)])
		#expect(content.link == nil)
	}

	@Test("cleanUp removes the staging directory, and sweeping removes only old maskin-share-* ones")
	func cleanupAndSweep() async throws {
		let work = scratch.url.appendingPathComponent("\(ShareExtractor.workDirectoryPrefix)\(UUID().uuidString)")
		let content = await ShareExtractor(workDirectory: work).extract(
			from: [.image(scratch.image("p.jpg", width: 64, height: 64))])
		#expect(FileManager.default.fileExists(atPath: work.path))
		content.cleanUp()
		#expect(!FileManager.default.fileExists(atPath: work.path))

		let stale = scratch.url.appendingPathComponent("\(ShareExtractor.workDirectoryPrefix)old")
		let other = scratch.url.appendingPathComponent("keep-me")
		try FileManager.default.createDirectory(at: stale, withIntermediateDirectories: true)
		try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
		let later = Date().addingTimeInterval(7200)
		ShareExtractor.sweepStaleDirectories(in: scratch.url, olderThan: 3600, now: later)
		#expect(!FileManager.default.fileExists(atPath: stale.path))
		#expect(FileManager.default.fileExists(atPath: other.path))
		ShareExtractor.sweepStaleDirectories(in: scratch.url, olderThan: 3600)
		#expect(FileManager.default.fileExists(atPath: other.path))
	}
}
