import Foundation
import Testing

@testable import MaskinCore

private func attachment(_ name: String, kind: ShareAttachment.Kind = .pdf, mime: String = "application/pdf") -> ShareAttachment {
	ShareAttachment(kind: kind, name: name, mimeType: mime, fileURL: URL(fileURLWithPath: "/tmp/\(name)"), sizeBytes: 10)
}

private func request(
	_ destination: ShareDestination = .object(type: "insight"), title: String = "Title", note: String = "",
	content: ShareContent
) -> ShareRequest {
	ShareRequest(destination: destination, title: title, note: note, content: content, status: "new")
}

@Suite("SharePoster")
struct SharePosterTests {
	@Test("creates the object, then uploads and attaches each file, in that order")
	func order() async throws {
		let remote = FakeShareRemote()
		let a = attachment("a.pdf"), b = attachment("b.pdf")
		let content = ShareContent(link: URL(string: "https://example.com")!, linkTitle: "Ex", attachments: [a, b])
		let outcome = try await SharePoster(remote: remote, idempotencyBase: "k").post(request(content: content))
		#expect(outcome.objectID == "obj-1" && outcome.objectType == "insight" && outcome.fileIDs.count == 2)
		let kinds = remote.calls.map { call -> String in
			switch call {
			case .createObject: "object"
			case .upload: "upload"
			case .attach: "attach"
			case .workspace: "workspace"
			}
		}
		#expect(kinds == ["object", "upload", "attach", "upload", "attach"])
		guard case .createObject(let type, let title, let body, let status, _) = remote.calls[0] else {
			Issue.record("first call was not createObject")
			return
		}
		#expect(type == "insight" && title == "Title" && status == "new" && body == "[Ex](https://example.com)")
	}

	@Test("every request carries its own key, derived from one stable base")
	func keys() async throws {
		let remote = FakeShareRemote()
		let a = attachment("a.pdf")
		_ = try await SharePoster(remote: remote, idempotencyBase: "base").post(request(content: ShareContent(text: "t", attachments: [a])))
		var keys: [String] = []
		for call in remote.calls {
			switch call {
			case .createObject(_, _, _, _, let k), .upload(_, _, let k), .attach(_, _, _, let k): keys.append(k)
			case .workspace: break
			}
		}
		#expect(keys == ["base-object", "base-file-\(a.id.uuidString)", "base-attach-\(a.id.uuidString)"])
		#expect(Set(keys).count == keys.count)
	}

	@Test("a failed upload keeps the object; Retry does not create a second one and reuses its key")
	func retryAfterUploadFailure() async throws {
		let remote = FakeShareRemote()
		remote.failNext("upload", with: .offline)
		let a = attachment("a.pdf")
		let poster = SharePoster(remote: remote, idempotencyBase: "base")
		let req = request(content: ShareContent(text: "t", attachments: [a]))
		await #expect(throws: ShareError.offline) { _ = try await poster.post(req) }
		#expect(await poster.progress.objectID == "obj-1")
		let outcome = try await poster.post(req)
		#expect(outcome.objectID == "obj-1")
		let objects = remote.calls.filter { if case .createObject = $0 { true } else { false } }
		#expect(objects.count == 1)
		let uploads = remote.calls.compactMap { call -> String? in
			if case .upload(_, _, let k) = call { k } else { nil }
		}
		#expect(uploads.count == 2 && Set(uploads).count == 1)
	}

	@Test("a failed object create is retried with the same key and nothing was recorded as created")
	func retryAfterCreateFailure() async throws {
		let remote = FakeShareRemote()
		remote.failNext("object", with: .server)
		let poster = SharePoster(remote: remote, idempotencyBase: "base")
		let req = request(content: ShareContent(text: "t"))
		await #expect(throws: ShareError.server) { _ = try await poster.post(req) }
		#expect(await poster.progress.objectID == nil)
		_ = try await poster.post(req)
		let keys = remote.calls.compactMap { call -> String? in
			if case .createObject(_, _, _, _, let k) = call { k } else { nil }
		}
		#expect(keys == ["base-object", "base-object"])
	}

	@Test("Retry skips files that already uploaded and edges that already attached")
	func resumesPartially() async throws {
		let remote = FakeShareRemote()
		let a = attachment("a.pdf"), b = attachment("b.pdf")
		remote.failNext("attach", with: .server)  // fails on a's attach? No: the first attach call.
		let poster = SharePoster(remote: remote, idempotencyBase: "base")
		let req = request(content: ShareContent(text: "t", attachments: [a, b]))
		await #expect(throws: ShareError.server) { _ = try await poster.post(req) }
		_ = try await poster.post(req)
		let uploads = remote.calls.filter { if case .upload = $0 { true } else { false } }
		let attaches = remote.calls.filter { if case .attach = $0 { true } else { false } }
		#expect(uploads.count == 2)  // a once, b once: a's upload was not repeated
		#expect(attaches.count == 3)  // a failed once, then a and b
	}

	@Test("files only: uploads without creating an object or an edge")
	func filesOnly() async throws {
		let remote = FakeShareRemote()
		let outcome = try await SharePoster(remote: remote).post(
			request(.filesOnly, content: ShareContent(attachments: [attachment("a.pdf")])))
		#expect(outcome.objectID == nil && outcome.fileIDs.count == 1)
		#expect(remote.calls.count == 1)
		if case .upload = remote.calls[0] {} else { Issue.record("expected one upload") }
	}

	@Test("files only with no files is an error, not an empty success")
	func filesOnlyEmpty() async {
		let remote = FakeShareRemote()
		await #expect(throws: ShareError.nothingToShare) {
			_ = try await SharePoster(remote: remote).post(request(.filesOnly, content: ShareContent(text: "t")))
		}
		#expect(remote.calls.isEmpty)
	}

	@Test("steps are reported so the sheet can show progress")
	func steps() async throws {
		let remote = FakeShareRemote()
		let seen = StepLog()
		_ = try await SharePoster(remote: remote).post(
			request(content: ShareContent(attachments: [attachment("a.pdf"), attachment("b.pdf")]))
		) { seen.add($0) }
		#expect(seen.steps == [.creatingObject, .uploading(index: 1, of: 2), .uploading(index: 2, of: 2)])
	}
}

private final class StepLog: @unchecked Sendable {
	private let lock = NSLock()
	private var _steps: [SharePoster.Step] = []
	var steps: [SharePoster.Step] { lock.withLock { _steps } }
	func add(_ s: SharePoster.Step) { lock.withLock { _steps.append(s) } }
}
