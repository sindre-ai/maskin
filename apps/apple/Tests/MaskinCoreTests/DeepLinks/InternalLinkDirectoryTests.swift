import Foundation
import Testing

@testable import MaskinCore

@MainActor
@Suite("InternalLinkDirectory") struct InternalLinkDirectoryTests {
	private func remote(_ objects: [WorkObject]) -> FakeObjectsRemote {
		let remote = FakeObjectsRemote(objects: objects)
		for object in objects { remote.setGraph(Fixtures.graph(for: object)) }
		return remote
	}

	@Test("an unknown id starts one lookup, then reports the object's type and title")
	func resolvesOnce() async {
		let fake = remote([WorkObject(id: "b1", type: "bet", title: "  Launch video  ", status: "active")])
		let directory = InternalLinkDirectory(remote: fake)
		#expect(directory.object("b1") == nil)
		#expect(directory.object("b1") == nil)
		#expect(await eventually { directory.object("b1") != nil })
		#expect(directory.object("b1") == .init(type: "bet", title: "Launch video"))
		#expect(fake.graphCalls == 1)
	}

	@Test("an object with no title keeps its type and no title")
	func untitled() async {
		let fake = remote([WorkObject(id: "t1", type: "task", title: "   ", status: "todo")])
		let directory = InternalLinkDirectory(remote: fake)
		_ = directory.object("t1")
		#expect(await eventually { directory.object("t1") != nil })
		#expect(directory.object("t1") == .init(type: "task", title: nil))
	}

	@Test("a failed lookup is not retried on every render")
	func failureIsQuiet() async {
		let fake = remote([WorkObject(id: "b1", type: "bet", title: "x", status: "active")])
		fake.fail("graph")
		let directory = InternalLinkDirectory(remote: fake)
		for _ in 0..<5 { _ = directory.object("b1") }
		try? await Task.sleep(for: .milliseconds(100))
		#expect(directory.object("b1") == nil)
		#expect(fake.graphCalls == 1)
	}
}
