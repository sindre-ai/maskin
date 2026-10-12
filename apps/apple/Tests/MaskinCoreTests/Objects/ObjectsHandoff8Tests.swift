import Foundation
import Testing

@testable import MaskinCore

@MainActor
private func makeStore() -> ObjectsStore {
	let remote = FakeObjectsRemote(objects: Fixtures.objects)
	let directory = ObjectsDirectory(remote: remote, actors: Fixtures.actors)
	return ObjectsStore(remote: remote, directory: directory)
}

private func ask(
	_ id: String, text: String = "Post text only?", options: [DecisionOption] = []
) -> ObjectAsk {
	let prompt = DecisionPrompt(title: "T", summary: "S", ask: text, options: options)
	let card = ForYouCard(
		id: id, objectTitle: "x", objectType: "task",
		mention: ForYouMention(eventId: 1, actorId: "forge", content: "c", decision: prompt))
	return ObjectAsk(objectId: id, by: "Forge", text: text, card: card)
}

@Suite("Objects tabs (handoff 8)")
@MainActor
struct ObjectsTabTests {
	@Test("Needs you and All share the unfiltered list; a type is its own tab")
	func tabs() async {
		let store = makeStore()
		await store.load()
		#expect(store.tab == .all)
		await store.select(.needsYou)
		#expect(store.tab == .needsYou)
		#expect(store.typeFilter == nil)
		await store.select(.type("task"))
		#expect(store.tab == .type("task"))
		#expect(!store.display.needsYouOnly)
		#expect(!store.mixesTypes)
		await store.select(.all)
		#expect(store.tab == .all)
		#expect(store.mixesTypes)
	}

	@Test("an open ask puts an object under Needs you and in its count")
	func asksCount() async {
		let store = makeStore()
		await store.load()
		#expect(store.needsYouCount == 0)
		store.setAsks(["t2": ask("t2")])
		#expect(store.needsYou(Fixtures.objects.first { $0.id == "t2" }!))
		#expect(store.needsYouCount == 1)
		await store.select(.needsYou)
		#expect(store.visibleObjects.map(\.id) == ["t2"])
	}

	@Test("folding a group is remembered per grouping")
	func folding() async {
		let store = makeStore()
		await store.load()
		let group = store.groups[0]
		#expect(!store.isCollapsed(group))
		store.toggleCollapsed(group)
		#expect(store.isCollapsed(group))
		store.grouping = .none
		#expect(!store.isCollapsed(ObjectGroup(id: group.id, title: nil, objects: [])))
		store.grouping = .status
		#expect(store.isCollapsed(group))
		store.toggleCollapsed(group)
		#expect(!store.isCollapsed(group))
	}

	@Test("Group by Driver buckets by driver name, objects without one last")
	func groupsByDriver() async {
		let store = makeStore()
		await store.load()
		store.grouping = .driver
		let titles: [String?] = store.groups.map(\.title)
		let expected: [String?] = ["Alex Preview", "Forge", "Sigrid Larsen", "No driver"]
		#expect(titles == expected)
		#expect(store.groups.last?.id == "")
		#expect(store.groups.flatMap(\.objects).count == 5)
	}

	@Test("Done moves to the first done status and is not offered when done or cancelled")
	func doneTarget() async {
		let order = ObjectsSchema.fallback.statuses(for: "task")
		#expect(StatusFlow.doneTarget(from: "todo", in: order) == "validated")
		#expect(StatusFlow.doneTarget(from: "done", in: order) == nil)
		#expect(StatusFlow.doneTarget(from: "discarded", in: order) == nil)
		let store = makeStore()
		await store.load()
		let undo = await store.markDone("t2")
		#expect(undo?.changes.first?.from == "todo")
		#expect(store.objects.first { $0.id == "t2" }?.status == "validated")
	}
}

@Suite("Object types (handoff 8)")
struct ObjectTypeOrderTests {
	@Test("prototype order first, the rest alphabetically; Account sorts as Company")
	func order() {
		let sorted = ObjectTypeOrder.sorted(["meeting", "zeta", "task", "account", "bet", "alpha", "insight"])
		#expect(sorted == ["bet", "insight", "task", "account", "meeting", "alpha", "zeta"])
	}

	@Test("plural labels")
	func plurals() {
		#expect(ObjectTypeOrder.plural("Bet") == "Bets")
		#expect(ObjectTypeOrder.plural("Person") == "People")
		#expect(ObjectTypeOrder.plural("Company") == "Companies")
		#expect(ObjectTypeOrder.plural("Knowledge") == "Knowledge")
		#expect(ObjectTypeOrder.plural("Docs") == "Docs")
	}

	@Test("glyphs, with a square for an unknown type")
	func glyphs() {
		#expect(ObjectTypeOrder.symbol(for: "insight") == "lightbulb")
		#expect(ObjectTypeOrder.symbol(for: "Account") == "building.2")
		#expect(ObjectTypeOrder.symbol(for: "widget") == "square")
	}
}

@Suite("Object asks")
struct ObjectAskTests {
	private let yes = DecisionOption(label: "Post it", recommended: true)
	private let risky = DecisionOption(label: "Send to all", recommended: true, destructive: true)
	private let hold = DecisionOption(label: "Hold for now")

	@Test("swipe-approve takes the recommendation, never one that can't be undone")
	func swipeApprove() {
		#expect(ask("a", options: [yes, hold]).swipeApprove?.label == "Post it")
		#expect(ask("a", options: [risky, hold]).swipeApprove == nil)
		#expect(ask("a", options: [hold]).swipeApprove == nil)
		#expect(ask("a", options: [yes, hold]).holdOption?.label == "Hold for now")
	}

	@Test("the line reads Name: ask, or the ask alone")
	func line() {
		var a = ask("a")
		#expect(a.line == "Forge: Post text only?")
		a.by = nil
		#expect(a.line == "Post text only?")
	}

	@Test("only open decisions become asks")
	func mapping() {
		let open = ask("open").card
		let answered = ask("answered").card
		let thread = ForYouCard(id: "thread", mention: ForYouMention(eventId: 2, content: "hi"))
		let entries = [
			FeedEntry(card: open, bucket: .needs, record: nil),
			FeedEntry(card: answered, bucket: .done, record: nil),
			FeedEntry(card: thread, bucket: .fyi, record: nil),
		]
		let map = ObjectAsk.map(from: entries) { _ in "Forge" }
		#expect(Array(map.keys) == ["open"])
		#expect(map["open"]?.by == "Forge")
	}
}
