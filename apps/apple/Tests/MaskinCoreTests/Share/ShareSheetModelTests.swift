import Foundation
import Testing

@testable import MaskinCore

private func session(workspace: String? = "ws-1") -> InMemorySecretStore {
	InMemorySecretStore(
		try! JSONEncoder().encode(StoredSession(apiKey: "ank_x", actorId: "a", name: "S", workspaceId: workspace)))
}

private let pdfAttachment = ShareAttachment(
	kind: .pdf, name: "Brief.pdf", mimeType: "application/pdf", fileURL: URL(fileURLWithPath: "/tmp/Brief.pdf"),
	sizeBytes: 10)

@MainActor
private func makeModel(
	store: any SecretStore = session(), content: ShareContent, remote: FakeShareRemote = FakeShareRemote()
) -> ShareSheetModel {
	ShareSheetModel(secretStore: store, loadContent: { content }, makeRemote: { _ in remote })
}

@Suite("ShareSheetModel")
@MainActor
struct ShareSheetModelTests {
	private let link = ShareContent(link: URL(string: "https://example.com/p")!, linkTitle: "A page")

	@Test("loads ready with the page title, insight selected and the workspace's name")
	func ready() async {
		let model = makeModel(content: link)
		await model.start()
		#expect(model.phase == .ready)
		#expect(model.title == "A page")
		#expect(model.destination == .object(type: "insight"))
		#expect(model.workspace?.name == "Mesh Firm")
	}

	@Test("the destination picker lists the workspace's real types with their display names")
	func realTypes() async {
		let remote = FakeShareRemote()
		remote.workspaceResult = .success(
			ShareWorkspace(
				id: "ws-1", name: "W",
				schema: ObjectsSchema(
					types: ["insight", "bet", "task", "meeting"], displayNames: ["meeting": "Meeting"],
					statuses: ["insight": ["new"], "meeting": ["planned", "held"]])))
		let model = makeModel(content: link, remote: remote)
		await model.start()
		#expect(model.typeOptions.count == 4)
		#expect(model.label(for: .object(type: "meeting")) == "Meeting")
		#expect(!model.typeOptions.contains(.filesOnly))
	}

	@Test("a shared file adds a Files destination")
	func filesOption() async {
		let model = makeModel(content: ShareContent(attachments: [pdfAttachment]))
		await model.start()
		#expect(model.typeOptions.last == .filesOnly)
		#expect(model.label(for: .filesOnly) == "File")
	}

	@Test("offline at load: the sheet still opens with the standard types")
	func offlineLoad() async {
		let remote = FakeShareRemote()
		remote.failNext("workspace", with: .offline)
		let model = makeModel(content: link, remote: remote)
		await model.start()
		#expect(model.phase == .ready)
		#expect(model.workspace == nil)
		#expect(model.typeOptions.map { model.label(for: $0) } == ["Insight", "Bet", "Task"])
	}

	@Test("posting uses the first status of the chosen type and ends with a deep link")
	func postSucceeds() async {
		let model = makeModel(content: link)
		await model.start()
		model.destination = .object(type: "task")
		model.note = "check this"
		await model.post()
		guard case .posted(let outcome) = model.phase else {
			Issue.record("expected posted, got \(model.phase)")
			return
		}
		#expect(outcome.objectType == "task")
		#expect(model.openURL?.absoluteString == "maskin://ws-1/objects/obj-1")
	}

	@Test("the status sent is the type's own first status from the workspace settings")
	func statusFromSchema() async {
		let remote = FakeShareRemote()
		let model = makeModel(content: link, remote: remote)
		await model.start()
		model.destination = .object(type: "task")
		await model.post()
		guard case .createObject(_, _, _, let status, _)? = remote.calls.first(where: {
			if case .createObject = $0 { true } else { false }
		}) else {
			Issue.record("no create call")
			return
		}
		#expect(status == "backlog")
	}

	@Test("a failed post keeps the draft; Retry succeeds without creating a second object")
	func retryKeepsDraft() async {
		let remote = FakeShareRemote()
		remote.failNext("object", with: .offline)
		let model = makeModel(content: link, remote: remote)
		await model.start()
		model.title = "My edit"
		model.note = "my note"
		await model.post()
		#expect(model.phase == .failed(.offline))
		#expect(model.title == "My edit" && model.note == "my note")
		await model.post()
		guard case .posted = model.phase else {
			Issue.record("retry did not post: \(model.phase)")
			return
		}
		let creates = remote.calls.filter { if case .createObject = $0 { true } else { false } }
		#expect(creates.count == 2)  // the failed attempt and the retry, same idempotency key
		let keys = creates.compactMap { call -> String? in
			if case .createObject(_, _, _, _, let k) = call { k } else { nil }
		}
		#expect(Set(keys).count == 1)
	}

	@Test("a 401 at post time blocks with 'open Maskin', and nothing is deleted from the Keychain")
	func expiredSession() async {
		let remote = FakeShareRemote()
		remote.failNext("object", with: .sessionExpired)
		let store = session()
		let model = makeModel(store: store, content: link, remote: remote)
		await model.start()
		await model.post()
		#expect(model.phase == .blocked(.sessionExpired))
		#expect((try? store.read()) != nil)
	}

	@Test("signed out: blocked before anything is extracted or sent")
	func signedOut() async {
		let remote = FakeShareRemote()
		let model = makeModel(store: InMemorySecretStore(), content: link, remote: remote)
		await model.start()
		#expect(model.phase == .blocked(.signedOut))
		#expect(remote.calls.isEmpty)
	}

	@Test("no workspace chosen: blocked with its own message")
	func noWorkspace() async {
		let model = makeModel(store: session(workspace: nil), content: link)
		await model.start()
		#expect(model.phase == .blocked(.noWorkspace))
	}

	@Test("an empty share is blocked as nothing to share")
	func emptyShare() async {
		let model = makeModel(content: ShareContent())
		await model.start()
		#expect(model.phase == .blocked(.nothingToShare))
	}

	@Test("a workspace that rejects the session at load time blocks the sheet")
	func expiredAtLoad() async {
		let remote = FakeShareRemote()
		remote.failNext("workspace", with: .sessionExpired)
		let model = makeModel(content: link, remote: remote)
		await model.start()
		#expect(model.phase == .blocked(.sessionExpired))
	}

	@Test("files have no deep link; objects do")
	func openURLOnlyForObjects() async {
		let model = makeModel(content: ShareContent(attachments: [pdfAttachment]))
		await model.start()
		model.destination = .filesOnly
		await model.post()
		guard case .posted = model.phase else {
			Issue.record("not posted: \(model.phase)")
			return
		}
		#expect(model.openURL == nil)
	}

	@Test("posting twice at once does nothing the second time")
	func noDoublePost() async {
		let remote = FakeShareRemote()
		let model = makeModel(content: link, remote: remote)
		await model.start()
		await model.post()
		await model.post()  // already posted: canPost is false
		#expect(remote.calls.filter { if case .createObject = $0 { true } else { false } }.count == 1)
	}
}
