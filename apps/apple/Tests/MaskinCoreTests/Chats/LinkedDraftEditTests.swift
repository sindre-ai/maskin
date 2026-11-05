import Foundation
import Testing

@testable import MaskinCore

/// A LinkedIn post whose description carries a header above the post: the preview, and so the
/// fingerprint, hold only the text between the POST and MEDIA lines, as the server computes them.
final class FakePostRemote: ObjectDraftsRemote, @unchecked Sendable {
	static let header = "Account: Magnus\nAngle: demand\n"
	static let footer = "\n--- MEDIA ---\nnone"
	private let lock = NSLock()
	private var _text: String
	private var _saves: [String] = []
	private var _approvedHashes: [String] = []

	init(text: String = "Old text") { _text = text }

	var content: String { lock.withLock { Self.header + "--- POST ---\n" + _text + Self.footer } }
	var saves: [String] { lock.withLock { _saves } }
	var approvedHashes: [String] { lock.withLock { _approvedHashes } }
	var hash: String { lock.withLock { "post|\(_text)" } }

	func preview(delivery: ObjectPreview.Delivery? = nil) -> ObjectPreview {
		lock.withLock {
			ObjectPreview(
				kind: "linkedin_post", label: "LinkedIn post", body: _text, contentHash: "post|\(_text)",
				delivery: delivery)
		}
	}

	func detail(objectId: String) async throws -> ObjectDetail {
		ObjectDetail(
			object: WorkObject(id: objectId, type: "task", title: "Post", content: content, status: "todo"),
			workspaceId: "ws-1", preview: preview())
	}

	func save(objectId: String, content: String?, subject: String?, idempotencyKey: String) async throws {
		guard let content else { return }
		lock.withLock {
			_saves.append(content)
			let start = content.range(of: "--- POST ---\n")!.upperBound
			let end = content.range(of: "\n--- MEDIA ---")!.lowerBound
			_text = String(content[start..<end])
		}
	}

	func approve(objectId: String, contentHash: String, idempotencyKey: String) async throws -> ObjectPreview {
		lock.withLock { _approvedHashes.append(contentHash) }
		if contentHash != hash { throw ObjectApprovalError.changed }
		return preview(delivery: .approved)
	}
}

/// Editing a draft in the chat card: the edit is saved, then the text as saved is approved.
@MainActor
@Suite("LinkedItemStore draft editing")
struct LinkedDraftEditTests {
	private func makeStore(_ remote: any ObjectDraftsRemote) -> LinkedItemStore {
		LinkedItemStore(objects: remote, files: FakeLinkedFiles(), workspaceID: { "ws-1" })
	}

	private func shown(_ remote: FakeReviewRemote) -> ObjectPreview {
		ObjectPreview(
			kind: "email", label: "Email", subject: remote.subject, body: remote.content, contentHash: remote.hash)
	}

	@Test("an edited email is saved first, then approved with the fingerprint of the saved text")
	func saveThenApprove() async {
		let remote = FakeReviewRemote()
		let store = makeStore(remote)
		let result = await store.approve(
			objectID: "o1", preview: shown(remote), edit: DraftEdit(body: "Hi Mette, edited", subject: "Following up"))
		guard case .approved(let approved) = result else {
			Issue.record("not approved: \(result)")
			return
		}
		#expect(approved.delivery == .approved)
		#expect(remote.log == ["save:Hi Mette, edited:-", "approve:Following up|Hi Mette, edited"])
		#expect(store.phase(of: "o1") == nil)
	}

	@Test("an edited subject goes to the subject field")
	func subjectEdit() async {
		let remote = FakeReviewRemote()
		let store = makeStore(remote)
		_ = await store.approve(
			objectID: "o1", preview: shown(remote), edit: DraftEdit(body: "Hi Mette", subject: "Thursday"))
		#expect(remote.log == ["save:-:Thursday", "approve:Thursday|Hi Mette"])
	}

	@Test("text left as shown is a plain approval and saves nothing")
	func untouched() async {
		let remote = FakeReviewRemote()
		let store = makeStore(remote)
		let result = await store.approve(
			objectID: "o1", preview: shown(remote), edit: DraftEdit(body: "Hi Mette", subject: "Following up"))
		guard case .approved = result else {
			Issue.record("not approved: \(result)")
			return
		}
		#expect(remote.log == ["approve:Following up|Hi Mette"])
	}

	@Test("a draft that changed under the reader is neither saved over nor approved")
	func changedUnderTheReader() async {
		let remote = FakeReviewRemote()
		let store = makeStore(remote)
		let before = shown(remote)
		remote.content = "The agent rewrote this"
		let result = await store.approve(
			objectID: "o1", preview: before, edit: DraftEdit(body: "My edit", subject: "Following up"))
		#expect(result == .failed(.changed))
		#expect(remote.log.isEmpty)
		#expect(remote.content == "The agent rewrote this")
		#expect(store.phase(of: "o1") == .failed(ObjectApprovalError.changed.message))
	}

	@Test("a retry after a failed approval keeps the edit and does not save twice")
	func retryDoesNotSaveTwice() async {
		let remote = FakeReviewRemote()
		remote.approveError = ObjectApprovalError.offline
		let store = makeStore(remote)
		let before = shown(remote)
		let edit = DraftEdit(body: "Edited and kept", subject: "Following up")
		#expect(await store.approve(objectID: "o1", preview: before, edit: edit) == .failed(.offline))
		let result = await store.approve(objectID: "o1", preview: before, edit: edit)
		guard case .approved = result else {
			Issue.record("not approved: \(result)")
			return
		}
		#expect(remote.log.filter { $0.hasPrefix("save:") }.count == 1)
		#expect(remote.log.last == "approve:Following up|Edited and kept")
	}

	@Test("a LinkedIn post with a header changes only the text between the markers")
	func headerPost() async {
		let remote = FakePostRemote()
		let store = makeStore(remote)
		let before = remote.preview()
		let result = await store.approve(
			objectID: "o1", preview: before, edit: DraftEdit(body: "New text"))
		guard case .approved = result else {
			Issue.record("not approved: \(result)")
			return
		}
		#expect(remote.saves == [FakePostRemote.header + "--- POST ---\nNew text" + FakePostRemote.footer])
		#expect(remote.approvedHashes == ["post|New text"])
	}

	@Test("a remote that cannot save refuses the edit and approves nothing")
	func noSave() async {
		let remote = FakeDraftsRemote()
		remote.set(
			.success(
				ObjectDetail(
					object: WorkObject(id: "o1", type: "task", title: "T", content: "Hello", status: "draft"),
					workspaceId: "ws-1",
					preview: ObjectPreview(kind: "email", label: "Email", body: "Hello", contentHash: "h1"))),
			for: "o1")
		let store = makeStore(remote)
		let result = await store.approve(
			objectID: "o1", preview: ObjectPreview(kind: "email", label: "Email", body: "Hello", contentHash: "h1"),
			edit: DraftEdit(body: "Hello there", subject: ""))
		guard case .failed = result else {
			Issue.record("expected a failure: \(result)")
			return
		}
		#expect(remote.approveCalls.isEmpty)
	}

	@Test("the reason Approve is off: a missing subject, then missing text, else none")
	func blockedReason() {
		#expect(DraftEdit(body: "Hi", subject: "").blockedReason(isEmail: true) == "Add a subject to approve.")
		#expect(DraftEdit(body: "Hi", subject: nil).blockedReason(isEmail: true) == "Add a subject to approve.")
		#expect(DraftEdit(body: "  ", subject: "Hello").blockedReason(isEmail: true) == "Add some text to approve.")
		#expect(DraftEdit(body: "").blockedReason(isEmail: false) == "Add some text to approve.")
		#expect(DraftEdit(body: "Hi", subject: "Hello").blockedReason(isEmail: true) == nil)
		#expect(DraftEdit(body: "Hi").blockedReason(isEmail: false) == nil)
	}
}
