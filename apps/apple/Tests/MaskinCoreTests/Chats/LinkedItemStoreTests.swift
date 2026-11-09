import Foundation
import Testing

@testable import MaskinCore

/// Scripted `ObjectDraftsRemote`: answers per object id, counts calls, can be held open.
final class FakeDraftsRemote: ObjectDraftsRemote, @unchecked Sendable {
	private let lock = NSLock()
	private var _details: [String: Result<ObjectDetail, Error>] = [:]
	private var _approvals: [Result<ObjectPreview, Error>] = []
	private var _detailCalls: [String] = []
	private var _approveCalls: [(id: String, hash: String)] = []
	private var _keys: [String] = []
	var delay: Duration = .zero
	/// Runs while the lookup is in flight, before the answer is returned.
	/// The first this many lookups fail, then it answers as scripted.
	var failFirst = 0
	var duringDetail: (@Sendable () -> Void)?

	func set(_ result: Result<ObjectDetail, Error>, for id: String) { lock.withLock { _details[id] = result } }
	func queueApproval(_ result: Result<ObjectPreview, Error>) { lock.withLock { _approvals.append(result) } }
	var detailCalls: [String] { lock.withLock { _detailCalls } }
	var approveCalls: [(id: String, hash: String)] { lock.withLock { _approveCalls } }
	var approveKeys: [String] { lock.withLock { _keys } }

	func detail(objectId: String) async throws -> ObjectDetail {
		lock.withLock { _detailCalls.append(objectId) }
		try await Task.sleep(for: delay)
		duringDetail?()
		if lock.withLock({ _detailCalls.count }) <= failFirst { throw ObjectsError("down") }
		guard let result = lock.withLock({ _details[objectId] }) else { throw ObjectsError(ObjectsRemoteMessages.notFound) }
		return try result.get()
	}

	func approve(objectId: String, contentHash: String, idempotencyKey: String) async throws -> ObjectPreview {
		lock.withLock { _approveCalls.append((objectId, contentHash)); _keys.append(idempotencyKey) }
		try await Task.sleep(for: delay)
		let next = lock.withLock { _approvals.isEmpty ? nil : _approvals.removeFirst() }
		return try (next ?? .failure(ObjectApprovalError.other("unscripted"))).get()
	}
}

final class FakeLinkedFiles: FilesRemote, @unchecked Sendable {
	private let lock = NSLock()
	private var _summaries: [FileSummary] = []
	private var _calls = 0
	var fails = false

	func set(_ summaries: [FileSummary]) { lock.withLock { _summaries = summaries } }
	var calls: Int { lock.withLock { _calls } }

	func file(id: String) async throws -> FileDetail { throw FileError("unused") }
	func summaries(ids: [String]) async throws -> [FileSummary] {
		lock.withLock { _calls += 1 }
		if fails { throw FileError("You're offline.", isOffline: true) }
		return lock.withLock { _summaries.filter { ids.contains($0.id) } }
	}
}

@MainActor
@Suite("LinkedItemStore")
struct LinkedItemStoreTests {
	let ws = "ws-1"
	let one = "11111111-2222-3333-4444-555555555555"
	let two = "22222222-2222-3333-4444-555555555555"
	let fileID = "33333333-2222-3333-4444-555555555555"

	private func preview(hash: String = "h1", missing: [String] = [], delivery: ObjectPreview.Delivery? = nil) -> ObjectPreview {
		ObjectPreview(
			kind: "email", label: "Email", recipients: [.init(role: "to", name: "Torben", address: "t@x.dk")],
			subject: "Hej", body: "Hello Torben", missing: missing, contentHash: hash, delivery: delivery)
	}

	private func draft(_ id: String, workspace: String? = nil, preview: ObjectPreview?, content: String? = "Hello Torben") -> ObjectDetail {
		ObjectDetail(
			object: WorkObject(id: id, type: "task", title: "Email to Torben", content: content, status: "draft"),
			workspaceId: workspace ?? ws, preview: preview)
	}

	private func make(
		objects: FakeDraftsRemote = FakeDraftsRemote(), files: FakeLinkedFiles = FakeLinkedFiles(),
		clock: Box<Date> = Box(Date(timeIntervalSince1970: 1000))
	) -> (LinkedItemStore, FakeDraftsRemote, FakeLinkedFiles, Box<Date>) {
		let store = LinkedItemStore(
			objects: objects, files: files, workspaceID: { "ws-1" }, retryAfter: 30, now: { clock.value })
		return (store, objects, files, clock)
	}

	final class Box<T>: @unchecked Sendable {
		var value: T
		init(_ value: T) { self.value = value }
	}

	@Test("an object with a preview and text resolves to a draft card")
	func draftCard() async {
		let (store, objects, _, _) = make()
		objects.set(.success(draft(one, preview: preview())), for: one)
		let target = LinkedTarget(kind: .object, uuid: one)
		#expect(store.state(for: target) == nil)
		await store.resolve([target])
		guard case .draft(let object, let p)? = store.item(for: target) else {
			Issue.record("not a draft: \(String(describing: store.state(for: target)))")
			return
		}
		#expect(object.id == one)
		#expect(p.contentHash == "h1")
		#expect(store.isCard(target))
	}

	private func task(_ id: String, metadata: [String: String] = [:], driver: String? = nil, content: String? = "Fix the login.") -> ObjectDetail {
		ObjectDetail(
			object: WorkObject(
				id: id, type: "task", title: "  Fix login  ", content: content, status: "in_progress",
				metadata: metadata, driverId: driver, updatedAt: Date(timeIntervalSince1970: 500)),
			workspaceId: ws)
	}

	@Test("an object without a preview, or a draft without text, is an object card with its record")
	func objectCards() async {
		let (store, objects, _, _) = make()
		objects.set(.success(task(one, metadata: ["priority": " P2 "], driver: "a-1")), for: one)
		objects.set(.success(draft(two, preview: preview(), content: "  \n")), for: two)
		await store.resolve([LinkedTarget(kind: .object, uuid: one), LinkedTarget(kind: .object, uuid: two)])
		let target = LinkedTarget(kind: .object, uuid: one)
		guard case .object(let card)? = store.item(for: target) else {
			Issue.record("expected an object card, got \(String(describing: store.state(for: target)))")
			return
		}
		#expect(card.title == "Fix login")
		#expect(card.kindLabel == "Task")
		#expect(card.status == "in_progress")
		#expect(card.summary == "Fix the login.")
		#expect(card.priority == "P2")
		#expect(card.ownerID == "a-1")
		#expect(card.updatedAt == Date(timeIntervalSince1970: 500))
		#expect(store.isCard(target))
		guard case .object? = store.item(for: LinkedTarget(kind: .object, uuid: two)) else {
			Issue.record("a draft without text should be an object card")
			return
		}
	}

	@Test("the priority fact is left out when the object has none")
	func noPriority() async {
		let (store, objects, _, _) = make()
		objects.set(.success(task(one, metadata: ["priority": "  "])), for: one)
		objects.set(.success(task(two)), for: two)
		await store.resolve([LinkedTarget(kind: .object, uuid: one), LinkedTarget(kind: .object, uuid: two)])
		for id in [one, two] {
			guard case .object(let card)? = store.item(for: LinkedTarget(kind: .object, uuid: id)) else {
				Issue.record("expected an object card for \(id)")
				continue
			}
			#expect(card.priority == nil)
		}
	}

	@Test("a title of spaces is no title, and the card says Untitled")
	func untitled() {
		let card = LinkedObject(object: WorkObject(id: one, type: "bet", title: "   ", status: "active"), kindLabel: "Bet")
		#expect(card.title == nil)
		#expect(card.displayTitle == "Untitled")
	}

	@Test("one lookup gives the card and the link their record, once per target")
	func oneLookupPerTarget() async {
		let (store, objects, _, _) = make()
		objects.set(.success(task(one)), for: one)
		let target = LinkedTarget(kind: .object, uuid: one)
		await store.resolve([target])
		let directory = InternalLinkDirectory(store: { store })
		#expect(directory.object(one) == .init(type: "task", title: "Fix login", status: "in_progress"))
		await store.resolve([target])
		#expect(objects.detailCalls.count == 1)
	}

	@Test("an object is a card from the moment it is asked about, until it turns out not to be one")
	func showsCardWhileLoading() async {
		let (store, objects, _, _) = make()
		let target = LinkedTarget(kind: .object, uuid: one)
		let file = LinkedTarget(kind: .file, uuid: fileID)
		#expect(store.showsCard(target))
		#expect(!store.showsCard(file))
		objects.set(.success(draft(one, workspace: "ws-other", preview: preview())), for: one)
		await store.resolve([target])
		#expect(!store.showsCard(target))
	}

	@Test("owners are named from one read of the workspace's people, not one per card")
	func ownerNames() async {
		let objects = FakeDraftsRemote()
		let calls = Box(0)
		let store = LinkedItemStore(
			objects: objects, files: FakeLinkedFiles(),
			actors: {
				calls.value += 1
				return [ActorRef(id: "a-1", name: "Developer", isAgent: true)]
			}, workspaceID: { "ws-1" })
		objects.set(.success(task(one, driver: "a-1")), for: one)
		objects.set(.success(task(two, driver: "a-1")), for: two)
		#expect(store.owner(for: "a-1") == nil)
		await store.resolve([LinkedTarget(kind: .object, uuid: one), LinkedTarget(kind: .object, uuid: two)])
		#expect(await eventually { store.owner(for: "a-1") != nil })
		#expect(store.owner(for: "a-1")?.name == "Developer")
		#expect(store.owner(for: nil) == nil)
		#expect(calls.value == 1)
	}

	@Test("an owner read that fails is tried again with the next lookup")
	func ownerReadRetries() async {
		let objects = FakeDraftsRemote()
		let calls = Box(0)
		let store = LinkedItemStore(
			objects: objects, files: FakeLinkedFiles(),
			actors: {
				calls.value += 1
				if calls.value == 1 { throw ObjectsError("down") }
				return [ActorRef(id: "a-1", name: "Developer", isAgent: true)]
			}, workspaceID: { "ws-1" })
		objects.set(.success(task(one)), for: one)
		objects.set(.success(task(two)), for: two)
		await store.resolve([LinkedTarget(kind: .object, uuid: one)])
		#expect(await eventually { calls.value == 1 })
		// The failed read has settled once it has had a moment to clear itself.
		try? await Task.sleep(for: .milliseconds(50))
		await store.resolve([LinkedTarget(kind: .object, uuid: two)])
		#expect(await eventually { store.owner(for: "a-1") != nil })
		#expect(calls.value == 2)
	}

	@Test("an object in another workspace never becomes a card, and is not asked about again")
	func otherWorkspace() async {
		let (store, objects, _, _) = make()
		objects.set(.success(draft(one, workspace: "ws-other", preview: preview())), for: one)
		let target = LinkedTarget(kind: .object, uuid: one)
		await store.resolve([target])
		#expect(store.state(for: target) == .unavailable)
		await store.resolve([target])
		#expect(objects.detailCalls.count == 1)
	}

	@Test("a missing object is a deleted card, and final")
	func missing() async {
		let (store, objects, _, clock) = make()
		let target = LinkedTarget(kind: .object, uuid: one)
		await store.resolve([target])
		#expect(store.state(for: target) == .ready(.deleted(target)))
		#expect(store.isCard(target))
		clock.value = clock.value.addingTimeInterval(3600)
		await store.resolve([target])
		#expect(objects.detailCalls.count == 1)
	}

	@Test("a failed lookup leaves the link as text and is retried only after the wait")
	func failureRetries() async {
		let (store, objects, _, clock) = make()
		let target = LinkedTarget(kind: .object, uuid: one)
		objects.set(.failure(ObjectsError("You're offline.", isOffline: true)), for: one)
		await store.resolve([target])
		#expect(store.state(for: target) == .unavailable)
		#expect(!store.isCard(target))

		clock.value = clock.value.addingTimeInterval(5)
		await store.resolve([target])
		#expect(objects.detailCalls.count == 1)

		objects.set(.success(draft(one, preview: preview())), for: one)
		clock.value = clock.value.addingTimeInterval(60)
		await store.resolve([target])
		#expect(objects.detailCalls.count == 2)
		#expect(store.isCard(target))
	}

	@Test("many askers for one target share one lookup, and a settled target is cached")
	func deduplicates() async {
		let objects = FakeDraftsRemote()
		objects.delay = .milliseconds(50)
		let (store, _, _, _) = make(objects: objects)
		objects.set(.success(draft(one, preview: preview())), for: one)
		let target = LinkedTarget(kind: .object, uuid: one)
		async let a: Void = store.resolve([target])
		async let b: Void = store.resolve([target, target])
		_ = await (a, b)
		await store.resolve([target])
		#expect(objects.detailCalls.count == 1)
		#expect(store.state(for: target)?.item != nil)
	}

	@Test("a page, a picture and text are file cards; a PDF is a plain reference")
	func files() async {
		let page = FileSummary(id: fileID, name: "Landing.html", mimeType: "text/html", sizeBytes: 10)
		let pdfID = "44444444-2222-3333-4444-555555555555"
		let pdf = FileSummary(id: pdfID, name: "Deck.pdf", mimeType: "application/pdf", sizeBytes: 10)
		let (store, _, files, _) = make()
		files.set([page, pdf])
		let pageTarget = LinkedTarget(kind: .file, uuid: fileID)
		let pdfTarget = LinkedTarget(kind: .file, uuid: pdfID)
		await store.resolve([pageTarget, pdfTarget])
		#expect(store.item(for: pageTarget) == .file(FileReference(id: fileID, name: "Landing.html", mimeType: "text/html", sizeBytes: 10)))
		guard case .plain(let reference)? = store.item(for: pdfTarget) else {
			Issue.record("pdf should be plain")
			return
		}
		#expect(reference.title == "Deck.pdf")
		#expect(reference.kindLabel == "PDF")
		#expect(!store.isCard(pdfTarget))
	}

	@Test("a file the server does not return is final; a failing lookup is retried later")
	func fileFailures() async {
		let (store, _, files, clock) = make()
		let target = LinkedTarget(kind: .file, uuid: fileID)
		await store.resolve([target])
		#expect(store.state(for: target) == .unavailable)
		clock.value = clock.value.addingTimeInterval(3600)
		await store.resolve([target])
		#expect(files.calls == 1)

		let other = LinkedTarget(kind: .file, uuid: "55555555-2222-3333-4444-555555555555")
		files.fails = true
		await store.resolve([other])
		files.fails = false
		files.set([FileSummary(id: other.uuid, name: "n.md", mimeType: "text/markdown", sizeBytes: 1)])
		clock.value = clock.value.addingTimeInterval(60)
		await store.resolve([other])
		#expect(store.isCard(other))
	}

	// MARK: Approving

	private func resolvedDraft() async -> (LinkedItemStore, FakeDraftsRemote, LinkedTarget) {
		let (store, objects, _, _) = make()
		objects.set(.success(draft(one, preview: preview())), for: one)
		let target = LinkedTarget(kind: .object, uuid: one)
		await store.resolve([target])
		return (store, objects, target)
	}

	@Test("approving sends the preview's hash and swaps in the approved preview")
	func approveSuccess() async {
		let (store, objects, target) = await resolvedDraft()
		objects.queueApproval(.success(preview(hash: "h2", delivery: .approved)))
		let result = await store.approve(objectID: one, preview: preview())
		#expect(result == .approved(preview(hash: "h2", delivery: .approved)))
		#expect(objects.approveCalls.map(\.hash) == ["h1"])
		guard case .draft(_, let shown)? = store.item(for: target) else {
			Issue.record("card gone")
			return
		}
		#expect(shown.delivery == .approved)
		#expect(store.phase(of: one) == nil)
	}

	@Test("a refusal because the draft changed says so and re-reads the draft")
	func approveConflict() async {
		let (store, objects, target) = await resolvedDraft()
		objects.queueApproval(.failure(ObjectApprovalError.changed))
		objects.set(.success(draft(one, preview: preview(hash: "h9"))), for: one)
		let result = await store.approve(objectID: one, preview: preview())
		#expect(result == .failed(.changed))
		#expect(store.phase(of: one) == .failed(ObjectApprovalError.changed.message))
		guard case .draft(_, let shown)? = store.item(for: target) else {
			Issue.record("card gone")
			return
		}
		#expect(shown.contentHash == "h9")
	}

	@Test("a missing required field is reported with the server's words and keeps the card")
	func approveIncomplete() async {
		let (store, objects, target) = await resolvedDraft()
		objects.queueApproval(.failure(ObjectApprovalError.incomplete("A subject is required.")))
		let result = await store.approve(objectID: one, preview: preview())
		#expect(result == .failed(.incomplete("A subject is required.")))
		#expect(store.phase(of: one) == .failed("A subject is required."))
		#expect(store.isCard(target))
		store.clearApprovalFailure(one)
		#expect(store.phase(of: one) == nil)
	}

	@Test("a retry after a reply that never came reuses the key; a definitive answer retires it")
	func approvalKeyReuse() async {
		let (store, objects, _) = await resolvedDraft()
		objects.queueApproval(.failure(ObjectApprovalError.offline))
		objects.queueApproval(.success(preview(hash: "h2", delivery: .approved)))
		_ = await store.approve(objectID: one, preview: preview())
		_ = await store.approve(objectID: one, preview: preview())
		#expect(objects.approveKeys.count == 2)
		#expect(objects.approveKeys[0] == objects.approveKeys[1])
		objects.set(.success(draft(one, preview: preview(hash: "h3"))), for: one)
		objects.queueApproval(.success(preview(hash: "h4", delivery: .approved)))
		_ = await store.approve(objectID: one, preview: preview())
		#expect(objects.approveKeys[2] != objects.approveKeys[0])
	}

	@Test("a conflict on a draft that now reads approved is a yes, and the agent can be told")
	func conflictAfterLostReply() async {
		let (store, objects, target) = await resolvedDraft()
		objects.queueApproval(.failure(ObjectApprovalError.changed))
		objects.set(.success(draft(one, preview: preview(hash: "h2", delivery: .approved))), for: one)
		let result = await store.approve(objectID: one, preview: preview())
		#expect(result == .approved(preview(hash: "h2", delivery: .approved)))
		#expect(store.phase(of: one) == nil)
		guard case .draft(_, let shown)? = store.item(for: target) else {
			Issue.record("card gone")
			return
		}
		#expect(shown.delivery == .approved)
	}

	@Test("failed lookups are asked again with a wait, and stop after a few tries")
	func retriesWithWait() async {
		let objects = FakeDraftsRemote()
		let store = LinkedItemStore(objects: objects, files: FakeLinkedFiles(), workspaceID: { "ws-1" }, retryAfter: 0.01)
		let target = LinkedTarget(kind: .object, uuid: one)
		objects.set(.failure(ObjectsError("down")), for: one)
		await store.resolveWithRetries([target])
		#expect(objects.detailCalls.count == 1 + LinkedItemStore.maxRetries)
		#expect(store.state(for: target) == .unavailable)

		let healing = FakeDraftsRemote()
		healing.failFirst = 2
		let store2 = LinkedItemStore(objects: healing, files: FakeLinkedFiles(), workspaceID: { "ws-1" }, retryAfter: 0.01)
		healing.set(.success(draft(one, preview: preview())), for: one)
		await store2.resolveWithRetries([target])
		#expect(healing.detailCalls.count == 3)
		#expect(store2.isCard(target))
	}

	@Test("an answer that arrives after a workspace switch is dropped, not kept as a permanent no")
	func workspaceSwitch() async {
		let objects = FakeDraftsRemote()
		let current = Box<String>("ws-1")
		objects.duringDetail = { current.value = "ws-2" }
		let store = LinkedItemStore(objects: objects, files: FakeLinkedFiles(), workspaceID: { current.value })
		objects.set(.success(draft(one, preview: preview())), for: one)
		let target = LinkedTarget(kind: .object, uuid: one)
		await store.resolve([target])
		#expect(store.state(for: target) == nil)
	}

	@Test("a second tap while approving does nothing")
	func approveOnce() async {
		let objects = FakeDraftsRemote()
		objects.delay = .milliseconds(80)
		let (store, _, _, _) = make(objects: objects)
		objects.set(.success(draft(one, preview: preview())), for: one)
		await store.resolve([LinkedTarget(kind: .object, uuid: one)])
		objects.queueApproval(.success(preview(hash: "h2", delivery: .approved)))
		async let first = store.approve(objectID: one, preview: preview())
		try? await Task.sleep(for: .milliseconds(20))
		#expect(store.phase(of: one) == .approving)
		let second = await store.approve(objectID: one, preview: preview())
		_ = await first
		if case .approved = second { Issue.record("second approval went through") }
		#expect(objects.approveCalls.count == 1)
	}

	@Test("the message to the agent quotes the exact text")
	func agentMessage() {
		let text = LinkedDraftMessage.approved(title: "Email to Torben", body: "Hello Torben\n\nBest, Sam")
		#expect(text == "Approved \"Email to Torben\". Send it exactly as it reads:\n\n> Hello Torben\n> \n> Best, Sam")
		#expect(LinkedDraftMessage.approved(title: " ", body: "x").hasPrefix("Approved \"Untitled\"."))
	}
}

@Suite("Approval response")
struct ObjectApprovalResponseTests {
	private func body(_ json: String) -> Data { Data(json.utf8) }

	@Test("a success carries the approved preview")
	func success() throws {
		let json = """
			{"approval_id": 7, "preview": {"kind": "email", "label": "Email", "recipients": [], "details": [],
			"body": "Hi", "missing": [], "warnings": [], "content_hash": "abc", "delivery": {"state": "approved", "at": null}}}
			"""
		let preview = try APIObjectsRemote.approvalResult(status: 200, body: body(json))
		#expect(preview.contentHash == "abc")
		#expect(preview.delivery == .approved)
	}

	@Test("409, 400, 403 and 404 mean what the card says")
	func failures() {
		func error(_ status: Int, _ json: String = "{}") -> ObjectApprovalError? {
			do {
				_ = try APIObjectsRemote.approvalResult(status: status, body: Data(json.utf8))
				return nil
			} catch { return error as? ObjectApprovalError }
		}
		#expect(error(409) == .changed)
		#expect(
			error(400, #"{"error":{"code":"x","message":"Invalid","details":[{"field":"subject","message":"A subject is required."}]}}"#)
				== .incomplete("A subject is required."))
		#expect(error(400) == .incomplete(nil))
		#expect(error(403) == .notAllowed)
		#expect(error(404) == .notFound)
		#expect(error(500) != nil)
	}
}

@MainActor
@Suite("Telling the agent about an approval")
struct LinkedApprovalMessageTests {
	@Test("the agent that wrote the draft is mentioned and the approved text is quoted")
	func mentionsAgent() async {
		let h = ChatHarness(server: [chatMsg(1, by: "relay", agent: true, "Draft ready")], online: false)
		await h.store.start()
		let id = h.store.tellAgentOfApproval(title: "Email to Torben", body: "Hello Torben", linkedBy: "relay", author: .agent)
		#expect(id != nil)
		let sent = h.store.messages.last
		#expect(sent?.content == "Approved \"Email to Torben\". Send it exactly as it reads:\n\n> Hello Torben")
		#expect(sent?.mentionIDs == ["relay"])
		h.network.set(online: true)
		#expect(await h.settled())
		let meta = await h.api.sentMetadata.first
		#expect(meta??.mentions == ["relay"])
	}

	@Test("a draft a person linked is approved without mentioning anyone")
	func noMentionForPeople() async {
		let h = ChatHarness(server: [chatMsg(1, by: "sam", "see this")], online: false)
		await h.store.start()
		h.store.tellAgentOfApproval(title: nil, body: "x", linkedBy: "sam", author: .human)
		#expect(h.store.messages.last?.mentionIDs == [])
	}
}

@MainActor
@Suite("LinkedItemStore file text")
struct LinkedFileTextTests {
	final class TextFiles: FilesRemote, @unchecked Sendable {
		var text = "# Hello\n\nBody"
		var calls = 0
		var fails = false
		func file(id: String) async throws -> FileDetail {
			calls += 1
			if fails { throw FileError("offline", isOffline: true) }
			return FileDetail(id: id, name: "a.md", mimeType: "text/markdown", sizeBytes: text.utf8.count, data: Data(text.utf8))
		}
	}

	private func make(_ files: TextFiles) -> LinkedItemStore {
		LinkedItemStore(objects: FakeDraftsRemote(), files: files, workspaceID: { "ws-1" })
	}

	private let ref = FileReference(id: "f1", name: "a.md", mimeType: "text/markdown", sizeBytes: 12)

	@Test("the first characters are kept, once")
	func loadsOnce() async {
		let files = TextFiles()
		let store = make(files)
		await store.loadText(of: ref)
		await store.loadText(of: ref)
		#expect(store.fileTexts["f1"] == .ready("# Hello\n\nBody", isTruncated: false))
		#expect(files.calls == 1)
	}

	@Test("a long text is cut and says so")
	func truncates() async {
		let files = TextFiles()
		files.text = String(repeating: "a", count: LinkedItemStore.previewCharacters + 50)
		let store = make(files)
		await store.loadText(of: ref)
		guard case .ready(let text, let cut)? = store.fileTexts["f1"] else {
			Issue.record("not ready")
			return
		}
		#expect(cut)
		#expect(text.count == LinkedItemStore.previewCharacters)
	}

	@Test("a file too big to preview is not fetched")
	func tooBig() async {
		let files = TextFiles()
		let store = make(files)
		await store.loadText(of: FileReference(id: "big", name: "b.md", mimeType: "text/markdown", sizeBytes: LinkedItemStore.maxPreviewBytes + 1))
		#expect(store.fileTexts["big"] == .failed)
		#expect(files.calls == 0)
	}

	@Test("a failed read shows an error, and Retry reads it again")
	func retries() async {
		let files = TextFiles()
		files.fails = true
		let store = make(files)
		await store.loadText(of: ref)
		#expect(store.fileTexts["f1"] == .error)
		files.fails = false
		await store.retryText(of: ref)
		#expect(store.fileTexts["f1"] == .ready("# Hello\n\nBody", isTruncated: false))
	}

	@Test("only the most recent texts are kept")
	func evicts() async {
		let files = TextFiles()
		let store = make(files)
		for i in 0..<(LinkedItemStore.maxCachedTexts + 5) {
			await store.loadText(of: FileReference(id: "f\(i)", name: "a.md", mimeType: "text/markdown", sizeBytes: 5))
		}
		#expect(store.fileTexts.count == LinkedItemStore.maxCachedTexts)
		#expect(store.fileTexts["f0"] == nil)
		#expect(store.fileTexts["f\(LinkedItemStore.maxCachedTexts + 4)"] != nil)
	}
}
