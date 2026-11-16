import Foundation
import Testing

@testable import MaskinCore

/// An event object with text; records the patches a card sends.
final class FakeEditableRemote: ObjectDraftsRemote, @unchecked Sendable {
	private let lock = NSLock()
	private var object = WorkObject(
		id: "d5d665d3-606f-4bcc-999f-49021817f9d6", type: "event", title: "Webinar", content: "Listing draft",
		status: "planned")
	private var _patches: [ObjectPatch] = []
	var failing = false

	var patches: [ObjectPatch] { lock.withLock { _patches } }

	func detail(objectId: String) async throws -> ObjectDetail {
		ObjectDetail(object: lock.withLock { object }, workspaceId: "ws-1", preview: nil)
	}

	func approve(objectId: String, contentHash: String, idempotencyKey: String) async throws -> ObjectPreview {
		throw ObjectApprovalError.notAllowed
	}

	func update(objectId: String, patch: ObjectPatch, idempotencyKey: String) async throws -> WorkObject {
		if failing { throw ObjectsError("nope") }
		return lock.withLock {
			_patches.append(patch)
			object = patch.applied(to: object)
			return object
		}
	}

	private var _reads = 0
	var statusReads: Int { lock.withLock { _reads } }
	/// What the workspace lists; empty stands for a read that failed.
	var statuses: [String: [String]] = ["event": ["planned", "approved", "live", "done"]]

	func workspaceStatuses(workspaceId: String) async -> [String: [String]] {
		lock.withLock { _reads += 1 }
		try? await Task.sleep(for: .milliseconds(20))
		return statuses
	}
}

@Suite("LinkedObject editing")
struct LinkedObjectEditLogicTests {
	private func object(type: String, content: String?) -> LinkedObject {
		LinkedObject(
			target: LinkedTarget(kind: .object, uuid: "a"), type: type, kindLabel: type, title: "T", status: "planned",
			content: content)
	}

	@Test("any object with text is editable except a contact or company")
	func eligibility() {
		for type in ["event", "bet", "insight", "task"] { #expect(object(type: type, content: "Hej").isEditable) }
		for type in ["contact", "company"] { #expect(!object(type: type, content: "Hej").isEditable) }
		#expect(!object(type: "event", content: nil).isEditable)
		#expect(!object(type: "event", content: "  \n").isEditable)
	}

	@Test("only a task opens with its text showing")
	func startsOpen() {
		#expect(object(type: "task", content: "Hej").startsOpen)
		#expect(!object(type: "event", content: "Hej").startsOpen)
	}

	@Test("the next status is the one after this one in the workspace's order")
	func nextStatus() {
		let order = ["planned", "approved", "done"]
		#expect(LinkedObject.nextStatus(after: "planned", in: order) == "approved")
		#expect(LinkedObject.nextStatus(after: "done", in: order) == nil)
		#expect(LinkedObject.nextStatus(after: "unknown", in: order) == nil)
		#expect(LinkedObject.nextStatus(after: "planned", in: []) == nil)
	}
}

@MainActor
@Suite("LinkedItemStore object editing")
struct LinkedObjectEditStoreTests {
	private let target = LinkedTarget(kind: .object, uuid: "d5d665d3-606f-4bcc-999f-49021817f9d6")
	private let chat = ObjectPatchChat(conversationID: "c1", agentID: "a1")

	private func store(_ remote: FakeEditableRemote) -> LinkedItemStore {
		LinkedItemStore(objects: remote, files: FakeLinkedFiles(), workspaceID: { "ws-1" })
	}

	@Test("saving the text sends it with the chat context and updates the card")
	func saveText() async {
		let remote = FakeEditableRemote()
		let store = store(remote)
		await store.resolve([target])
		#expect(await store.saveText(objectID: target.uuid, text: "New text", chat: chat))
		#expect(remote.patches.first?.content == "New text")
		#expect(remote.patches.first?.chat == chat)
		guard case .object(let card)? = store.item(for: target) else {
			Issue.record("not an object card")
			return
		}
		#expect(card.content == "New text")
		#expect(card.summary == "New text")
	}

	@Test("moving the status sends the next phase and updates the card")
	func move() async {
		let remote = FakeEditableRemote()
		let store = store(remote)
		await store.resolve([target])
		let order = await store.statusOrder(forType: "event")
		let next = LinkedObject.nextStatus(after: "planned", in: order)
		#expect(next == "approved")
		#expect(await store.move(objectID: target.uuid, to: "approved", chat: nil))
		#expect(remote.patches.first?.status == "approved")
		#expect(remote.patches.first?.chat == nil)
		guard case .object(let card)? = store.item(for: target) else {
			Issue.record("not an object card")
			return
		}
		#expect(card.status == "approved")
	}

	@Test("a failed save leaves the card as it was and says so")
	func failure() async {
		let remote = FakeEditableRemote()
		remote.failing = true
		let store = store(remote)
		await store.resolve([target])
		#expect(await store.saveText(objectID: target.uuid, text: "New", chat: chat) == false)
		#expect(store.editFailures[target.uuid] != nil)
		guard case .object(let card)? = store.item(for: target) else {
			Issue.record("not an object card")
			return
		}
		#expect(card.content == "Listing draft")
	}

	@Test("cards that ask together make one read of the workspace's statuses")
	func oneRead() async {
		let remote = FakeEditableRemote()
		let store = store(remote)
		async let a = store.statusOrder(forType: "event")
		async let b = store.statusOrder(forType: "event")
		async let c = store.statusOrder(forType: "event")
		_ = await (a, b, c)
		#expect(await store.statusOrder(forType: "event") == ["planned", "approved", "live", "done"])
		#expect(remote.statusReads == 1)
	}

	@Test("a read that failed is not held, so the next card asks again")
	func failedReadNotHeld() async {
		let remote = FakeEditableRemote()
		remote.statuses = [:]
		let store = store(remote)
		#expect(await store.statusOrder(forType: "event").isEmpty)
		remote.statuses = ["event": ["planned", "done"]]
		#expect(await store.statusOrder(forType: "event") == ["planned", "done"])
		#expect(remote.statusReads == 2)
	}

	@Test("a type the workspace lists no statuses for has no order, and no default stands in")
	func unlistedType() async {
		let store = store(FakeEditableRemote())
		#expect(await store.statusOrder(forType: "insight").isEmpty)
	}
}

@Suite("Which card under a message edits")
struct LinkedTextCardTargetTests {
	private let file = LinkedTarget(kind: .file, uuid: "f")
	private let first = LinkedTarget(kind: .object, uuid: "a")
	private let second = LinkedTarget(kind: .object, uuid: "b")

	@Test("the first object, not the first card of another kind")
	func firstObject() {
		let target = LinkedMessageLayout.textCardTarget(parts: [.markdown("x")], appended: [file, first, second])
		#expect(target == first)
	}

	@Test("none when an object is already a card in place")
	func objectInPlace() {
		let target = LinkedMessageLayout.textCardTarget(parts: [.card(second)], appended: [first])
		#expect(target == nil)
	}

	@Test("a file in place does not take the slot")
	func fileInPlace() {
		let target = LinkedMessageLayout.textCardTarget(parts: [.card(file)], appended: [first])
		#expect(target == first)
	}

	@Test("none when no object is linked in a sentence")
	func noObject() {
		#expect(LinkedMessageLayout.textCardTarget(parts: [], appended: [file]) == nil)
	}
}
