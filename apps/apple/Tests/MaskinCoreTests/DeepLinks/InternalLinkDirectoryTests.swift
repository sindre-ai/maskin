import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("InternalLinkDirectory") struct InternalLinkDirectoryTests {
	private let id = "11111111-2222-3333-4444-555555555555"

	private func makeStore(_ details: [String: ObjectDetail]) -> (LinkedItemStore, FakeDraftsRemote) {
		let remote = FakeDraftsRemote()
		for (id, detail) in details { remote.set(.success(detail), for: id) }
		return (LinkedItemStore(objects: remote, files: FakeLinkedFiles(), workspaceID: { "ws-1" }), remote)
	}

	private func detail(title: String?) -> ObjectDetail {
		ObjectDetail(object: WorkObject(id: id, type: "bet", title: title, status: "active"), workspaceId: "ws-1")
	}

	@Test("an unknown id starts one lookup, then reports the object's type and title")
	func resolvesOnce() async {
		let (store, remote) = makeStore([id: detail(title: "  Launch video  ")])
		let directory = InternalLinkDirectory(store: { store })
		#expect(directory.object(id) == nil)
		#expect(directory.object(id) == nil)
		#expect(await eventually { directory.object(id) != nil })
		#expect(directory.object(id) == .init(type: "bet", title: "Launch video"))
		#expect(remote.detailCalls.count == 1)
	}

	@Test("an object with no title keeps its type and no title")
	func untitled() async {
		let (store, _) = makeStore([id: detail(title: "   ")])
		let directory = InternalLinkDirectory(store: { store })
		_ = directory.object(id)
		#expect(await eventually { directory.object(id) != nil })
		#expect(directory.object(id) == .init(type: "bet", title: nil))
	}

	@Test("a failed lookup is not retried on every render")
	func failureIsQuiet() async {
		let (store, remote) = makeStore([:])
		remote.set(.failure(ObjectsError("down")), for: id)
		let directory = InternalLinkDirectory(store: { store })
		for _ in 0..<5 { _ = directory.object(id) }
		#expect(await eventually { remote.detailCalls.count == 1 })
		// The lookup has failed; asking again must not start another.
		for _ in 0..<5 { _ = directory.object(id) }
		#expect(directory.object(id) == nil)
		#expect(remote.detailCalls.count == 1)
	}

	@Test("a deleted object has no name to show")
	func deleted() async {
		let (store, _) = makeStore([:])
		let directory = InternalLinkDirectory(store: { store })
		_ = directory.object(id)
		try? await Task.sleep(for: .milliseconds(100))
		#expect(directory.object(id) == nil)
	}

	@Test("with no store yet there is nothing to show and nothing is asked")
	func noStore() {
		let directory = InternalLinkDirectory(store: { nil })
		#expect(directory.object(id) == nil)
	}
}
