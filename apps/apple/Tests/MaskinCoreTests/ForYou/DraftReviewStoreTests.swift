import Foundation
import Testing

@testable import MaskinCore

/// An email draft held by one object, answering the three calls the store makes. The fingerprint
/// is a plain join of subject and text, so a test can say exactly which text was approved.
final class FakeReviewRemote: DraftReviewRemote, @unchecked Sendable {
	private let lock = NSLock()
	private var _content: String
	private var _subject: String
	private var _delivery: ObjectPreview.Delivery?
	private var _log: [String] = []
	private var _approveError: (any Error)?

	init(content: String = "Hi Mette", subject: String = "Following up") {
		_content = content
		_subject = subject
	}

	var log: [String] { lock.withLock { _log } }
	var content: String {
		get { lock.withLock { _content } }
		set { lock.withLock { _content = newValue } }
	}
	var subject: String { lock.withLock { _subject } }
	var delivery: ObjectPreview.Delivery? {
		get { lock.withLock { _delivery } }
		set { lock.withLock { _delivery = newValue } }
	}
	/// The next approval fails with this, once.
	var approveError: (any Error)? {
		get { lock.withLock { _approveError } }
		set { lock.withLock { _approveError = newValue } }
	}
	var hash: String { lock.withLock { "\(_subject)|\(_content)" } }

	func detail(objectId: String) async throws -> ObjectDetail {
		lock.withLock {
			let preview = ObjectPreview(
				kind: "email", label: "Email", subject: _subject, body: _content,
				contentHash: "\(_subject)|\(_content)", delivery: _delivery)
			let object = WorkObject(
				id: objectId, type: "task", title: "Follow up", content: _content, status: "todo",
				metadata: ["subject": _subject])
			return ObjectDetail(object: object, workspaceId: "ws-1", preview: preview)
		}
	}

	func save(objectId: String, content: String?, subject: String?, idempotencyKey: String) async throws {
		lock.withLock {
			_log.append("save:\(content ?? "-"):\(subject ?? "-")")
			if let content { _content = content }
			if let subject { _subject = subject }
		}
	}

	func approve(objectId: String, contentHash: String, idempotencyKey: String) async throws -> ObjectPreview {
		let error: (any Error)? = lock.withLock {
			_log.append("approve:\(contentHash)")
			if let failure = _approveError {
				_approveError = nil
				return failure
			}
			if contentHash != "\(_subject)|\(_content)" { return ObjectApprovalError.changed }
			_delivery = .approved
			return nil
		}
		if let error { throw error }
		return ObjectPreview(
			kind: "email", label: "Email", subject: subject, body: content, contentHash: contentHash,
			delivery: .approved)
	}
}

@MainActor
struct DraftReviewStoreTests {
	private func draft(_ remote: FakeReviewRemote) -> ReviewDraft {
		ReviewDraft(
			objectId: "o1", target: DecisionTarget(entityId: "card-1", parentEventId: 5, latestEventId: 9),
			draftKey: "mette", kind: "email", kindLabel: "Email", agentName: "Sales Assistant",
			label: "Email to Mette", to: "Mette Holm, Northwind",
			recipients: [.init(role: "to", name: "Mette Holm", address: "mette@example.com")],
			subject: remote.subject, body: remote.content, contentHash: remote.hash)
	}

	private func make(
		_ remote: FakeReviewRemote, window: TimeInterval = 0.02, told: ToldAgent = ToldAgent()
	) -> DraftReviewStore {
		DraftReviewStore(
			remote: remote, undoWindow: window,
			announce: { draft in
				told.drafts.append(draft.objectId)
				return told.succeeds
			})
	}

	@Test func sendsTheEditedTextNotTheOriginal() async {
		let remote = FakeReviewRemote()
		let told = ToldAgent()
		let store = make(remote, told: told)
		let d = draft(remote)
		store.setBody("Hi Mette, edited", for: d)
		store.approve(d)
		#expect(await eventually { store.phase(of: d) == .sent })
		#expect(remote.content == "Hi Mette, edited")
		#expect(remote.log == ["save:Hi Mette, edited:-", "approve:Following up|Hi Mette, edited"])
		#expect(told.drafts == ["o1"])
	}

	@Test func anUntouchedDraftIsApprovedWithoutSavingAnything() async {
		let remote = FakeReviewRemote()
		let store = make(remote)
		let d = draft(remote)
		store.approve(d)
		#expect(await eventually { store.phase(of: d) == .sent })
		#expect(remote.log == ["approve:Following up|Hi Mette"])
	}

	@Test func theSubjectIsSavedToItsOwnField() async {
		let remote = FakeReviewRemote()
		let store = make(remote)
		let d = draft(remote)
		store.setSubject("Our call on Thursday", for: d)
		store.approve(d)
		#expect(await eventually { store.phase(of: d) == .sent })
		#expect(remote.log == ["save:-:Our call on Thursday", "approve:Our call on Thursday|Hi Mette"])
	}

	@Test func editedShowsOnlyWhileTheTextDiffersAndRevertRestoresTheOriginal() {
		let remote = FakeReviewRemote()
		let store = make(remote)
		let d = draft(remote)
		#expect(!store.isEdited(d))
		store.setBody("Something else", for: d)
		#expect(store.isEdited(d))
		store.setBody("Hi Mette", for: d)
		#expect(!store.isEdited(d))
		store.setBody("Changed again", for: d)
		store.setSubject("Other", for: d)
		store.revert(d)
		#expect(!store.isEdited(d))
		#expect(store.edit(for: d) == DraftEdit(d))
	}

	@Test func undoInsideTheWindowSendsNothingAndKeepsTheEdit() async {
		let remote = FakeReviewRemote()
		let store = make(remote, window: 60)
		let d = draft(remote)
		store.setBody("Keep me", for: d)
		store.approve(d)
		if case .held = store.phase(of: d) {} else { Issue.record("expected the receipt to be held") }
		#expect(store.receiptDrafts.map(\.id) == ["o1"])
		store.undo(d)
		#expect(store.phase(of: d) == .editing)
		#expect(store.receiptDrafts.isEmpty)
		#expect(store.edit(for: d).body == "Keep me")
		try? await Task.sleep(for: .milliseconds(100))
		#expect(remote.log.isEmpty)
	}

	@Test func aFailureKeepsTheEditAndRetryFinishesWithoutSavingTwice() async {
		let remote = FakeReviewRemote()
		remote.approveError = ObjectApprovalError.offline
		let store = make(remote)
		let d = draft(remote)
		store.setBody("Edited and kept", for: d)
		store.approve(d)
		#expect(await eventually { if case .failed = store.phase(of: d) { true } else { false } })
		#expect(store.edit(for: d).body == "Edited and kept")
		#expect(store.isEdited(d))
		store.retry(d)
		#expect(await eventually { store.phase(of: d) == .sent })
		#expect(remote.log.filter { $0.hasPrefix("save:") }.count == 1)
		#expect(remote.log.last == "approve:Following up|Edited and kept")
	}

	@Test func aDraftThatChangedUnderTheReaderIsNotApproved() async {
		let remote = FakeReviewRemote()
		let store = make(remote)
		let d = draft(remote)
		remote.content = "The agent rewrote this"
		store.approve(d)
		#expect(await eventually { if case .failed = store.phase(of: d) { true } else { false } })
		#expect(remote.log.isEmpty)
		if case .failed(let message) = store.phase(of: d) {
			#expect(message == ObjectApprovalError.changed.message)
		}
	}

	@Test func typingAfterAFailureClearsItAndOffersApproveAgain() async {
		let remote = FakeReviewRemote()
		remote.approveError = ObjectApprovalError.other("The server couldn't approve this draft.")
		let store = make(remote)
		let d = draft(remote)
		store.approve(d)
		#expect(await eventually { if case .failed = store.phase(of: d) { true } else { false } })
		store.setBody("Hi Mette, one more line", for: d)
		#expect(store.phase(of: d) == .editing)
	}

	@Test func anAgentThatCouldNotBeToldIsRetriedWithoutApprovingTwice() async {
		let remote = FakeReviewRemote()
		let told = ToldAgent()
		told.succeeds = false
		let store = make(remote, told: told)
		let d = draft(remote)
		store.approve(d)
		#expect(await eventually { if case .failed = store.phase(of: d) { true } else { false } })
		told.succeeds = true
		store.retry(d)
		#expect(await eventually { store.phase(of: d) == .sent })
		#expect(remote.log.filter { $0.hasPrefix("approve:") }.count == 1)
		#expect(told.drafts == ["o1", "o1"])
	}

	@Test func anEmptyBodyOrSubjectCannotBeApproved() {
		let remote = FakeReviewRemote()
		let store = make(remote, window: 60)
		let d = draft(remote)
		store.setBody("   ", for: d)
		#expect(!store.canApprove(d))
		store.approve(d)
		#expect(store.phase(of: d) == .editing)
		store.revert(d)
		store.setSubject("", for: d)
		#expect(!store.canApprove(d))
	}

	@Test func aDimmedApproveSaysWhy() {
		let remote = FakeReviewRemote()
		let store = make(remote, window: 60)
		let d = draft(remote)
		#expect(store.blockedReason(d) == nil)
		store.setBody("   ", for: d)
		#expect(store.blockedReason(d) == "Add some text to approve.")
		store.revert(d)
		store.setSubject("", for: d)
		#expect(store.blockedReason(d) == "Add a subject to approve.")
		var lacking = d
		lacking.missing = ["a recipient"]
		#expect(store.blockedReason(lacking) == "Still needs: a recipient")
	}

	@Test func sentCallsDidSendOnce() async {
		let remote = FakeReviewRemote()
		let store = make(remote)
		var sent: [String] = []
		store.didSend = { sent.append($0.objectId) }
		let d = draft(remote)
		store.approve(d)
		#expect(await eventually { store.phase(of: d) == .sent })
		#expect(sent == ["o1"])
	}
}

/// Records whom the store told to send, and whether telling works.
@MainActor
final class ToldAgent {
	var drafts: [String] = []
	var succeeds = true
}

struct DraftBodySpliceTests {
	@Test func aMessageInsideMarkersIsSwappedAndTheHeaderKept() {
		let content = "Account: Magnus\nAngle: demand\n--- POST ---\nOld text\n--- MEDIA ---\nnone"
		let result = DraftBodySplice.replacing("Old text", with: "New text", in: content)
		#expect(result == "Account: Magnus\nAngle: demand\n--- POST ---\nNew text\n--- MEDIA ---\nnone")
	}

	@Test func aWholeDescriptionIsReplaced() {
		#expect(DraftBodySplice.replacing("Hello", with: "Hi", in: "Hello") == "Hi")
	}

	@Test func aMessageThatCannotBeFoundIsNeverGuessed() {
		#expect(DraftBodySplice.replacing("Gone", with: "New", in: "Something else") == nil)
	}

	@Test func theOlderSubjectLineIsRemovedWithItsBlankLine() {
		let content = "Subject: Hello\n\nHi Mette"
		#expect(DraftBodySplice.removingSubjectLine(from: content) == "Hi Mette")
		#expect(DraftBodySplice.removingSubjectLine(from: "Hi Mette") == "Hi Mette")
	}
}
