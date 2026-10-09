import Foundation
import Testing

@testable import MaskinCore

@Suite("Loop overview")
struct LoopOverviewTests {
	private func link(
		_ id: String, _ relation: String, type: String = "task", title: String = "T",
		status: String? = "todo", outgoing: Bool = true
	) -> ObjectLink {
		ObjectLink(
			id: "r-\(id)", relation: relation, isOutgoing: outgoing, otherId: id, otherType: type,
			otherTitle: title, otherStatus: status)
	}

	private func graph(links: [ObjectLink] = [], events: [ObjectEvent] = []) -> ObjectGraph {
		ObjectGraph(object: WorkObject(id: "loop", type: "loop", status: "learning"), links: links, events: events)
	}

	private func comment(_ id: Int, _ text: String, parent: Int? = nil, decision: Bool = false, at: TimeInterval = 0)
		-> ObjectEvent
	{
		var data: [String: JSONValue] = ["content": .string(text)]
		if let parent { data["parentEventId"] = .number(Double(parent)) }
		if decision { data["decision"] = .object(["question": .string("?")]) }
		return ObjectEvent(
			id: id, actorId: "a", action: "commented", data: .object(data),
			createdAt: Date(timeIntervalSince1970: at))
	}

	@Test("members are the outgoing in_loop edges that are not files")
	func members() {
		let g = graph(links: [
			link("1", "in_loop"), link("2", "in_loop", outgoing: false), link("3", "relates_to"),
			link("4", "in_loop", type: "file"),
		])
		#expect(LoopOverviewBuilder.members(from: g).map(\.id) == ["1"])
	}

	@Test("posts are top-level comments, newest first, with reply counts")
	func posts() {
		let events = [
			comment(1, "first", at: 10), comment(2, "reply", parent: 1, at: 20),
			comment(3, "second", decision: true, at: 30), comment(4, "  ", at: 40),
			ObjectEvent(id: 5, actorId: nil, action: "updated"),
		]
		let posts = LoopOverviewBuilder.posts(from: events)
		#expect(posts.map(\.id) == [3, 1])
		#expect(posts[1].replyCount == 1)
		#expect(posts[0].isDecision)
		#expect(!posts[1].isDecision)
	}

	@Test("outputs de-duplicate and put HTML first")
	func outputs() {
		let loopFiles = [LoopOutput(id: "f1", name: "notes.md"), LoopOutput(id: "f2", name: "brief.html")]
		let memberFiles = [LoopOutput(id: "f2", name: "brief.html", sourceTitle: "X"), LoopOutput(id: "f3", name: "a.pdf")]
		let out = LoopOverviewBuilder.outputs(loopFiles: loopFiles, memberFiles: memberFiles)
		#expect(out.map(\.id) == ["f2", "f1", "f3"])
	}

	@Test("files come only from outgoing attached edges to files")
	func files() {
		let g = graph(links: [
			link("f", "attached", type: "file", title: "x.html"), link("o", "attached", type: "task"),
			link("g", "attached", type: "file", outgoing: false),
		])
		#expect(LoopOverviewBuilder.files(from: g, sourceTitle: nil).map(\.id) == ["f"])
	}
}

@Suite("Loop phases")
struct LoopPhasesTests {
	private func m(_ id: String, _ status: String, type: String = "task") -> LoopMember {
		LoopMember(id: id, type: type, title: id, status: status)
	}

	private func step(_ id: String, from: String?) -> LoopStep {
		LoopStep(
			triggerID: id, name: id, triggerKind: .event,
			triggerConfig: .object(from.map { ["from_status": .string($0)] } ?? [:]))
	}

	@Test("phases follow the configured order, then unknown statuses")
	func order() {
		let phases = LoopPhases.build(
			members: [m("a", "done"), m("b", "todo"), m("c", "weird")], steps: [],
			statusOrder: ["backlog", "todo", "done"])
		#expect(phases.map(\.status) == ["todo", "done", "weird"])
	}

	@Test("only the most common type forms phases")
	func primary() {
		let phases = LoopPhases.build(
			members: [m("a", "todo"), m("b", "todo"), m("c", "new", type: "insight")], steps: [],
			statusOrder: ["todo"])
		#expect(phases.count == 1)
		#expect(phases[0].count == 2)
	}

	@Test("a step attaches to the phase it fires from, even when empty")
	func steps() {
		let phases = LoopPhases.build(
			members: [m("a", "todo")], steps: [step("s1", from: "review"), step("s2", from: nil)],
			statusOrder: ["todo", "review"])
		#expect(phases.map(\.status) == ["todo", "review"])
		#expect(phases[1].steps.map(\.triggerID) == ["s1"])
	}

	@Test("no members means no phases")
	func empty() {
		#expect(LoopPhases.build(members: [], steps: [], statusOrder: ["todo"]).isEmpty)
	}
}

@MainActor
@Suite("Loop detail overview")
struct LoopDetailOverviewTests {
	@Test("refresh loads members, posts and outputs; the tapped phase wins, else the busiest")
	func loads() async {
		let api = FakeLoopsAPI([loopRow("a")])
		await api.setOverview(
			LoopOverview(
				members: [
					LoopMember(id: "1", type: "task", title: "One", status: "todo"),
					LoopMember(id: "2", type: "task", title: "Two", status: "done"),
					LoopMember(id: "3", type: "task", title: "Three", status: "done"),
				],
				posts: [LoopPost(id: 1, actorID: nil, text: "hi")],
				outputs: [LoopOutput(id: "f", name: "x.html")], statusOrder: ["todo", "done"]))
		let store = LoopDetailStore(loop: loopRow("a"), api: api, events: nil)
		await store.refresh()
		#expect(store.posts.count == 1)
		#expect(store.outputs.count == 1)
		#expect(store.phases.map(\.status) == ["todo", "done"])
		#expect(store.selectedPhase?.status == "todo")
		store.selectedStatus = "done"
		#expect(store.selectedPhase?.count == 2)
	}

	@Test("verdict reads healthy, waiting or failing")
	func verdict() async {
		let api = FakeLoopsAPI([loopRow("a", waiting: 2, inProgress: 3)])
		let store = LoopDetailStore(loop: loopRow("a", waiting: 2, inProgress: 3), api: api, events: nil)
		await store.refresh()
		#expect(store.verdict == "2 need you · 3 in progress")
		let ok = LoopDetailStore(loop: loopRow("b", inProgress: 1), api: FakeLoopsAPI([loopRow("b", inProgress: 1)]), events: nil)
		await ok.refresh()
		#expect(ok.verdict == "Healthy · 1 in progress")
	}
}
