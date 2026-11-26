import Foundation
import Testing

@testable import MaskinCore

@Suite("Create view with agent")
struct CreateViewMessageTests {
	@Test("the list names the type and the filters, and pins to Favorites")
	func listWithFilters() {
		let filters = CreateViewMessage.listFilters(
			status: "active", search: "acme", needsYouOnly: false, starredOnly: false)
		let text = CreateViewMessage.text(for: .list(type: "contact", filters: filters))
		#expect(text.contains("the contact items"))
		#expect(text.contains("Filters on the list right now: status active, search \"acme\"."))
		#expect(text.contains("pinned_files"))
		#expect(!text.contains("set_loop_view"))
	}

	@Test("a list with no filters says so")
	func listWithoutFilters() {
		let text = CreateViewMessage.text(for: .list(type: nil, filters: []))
		#expect(text.contains("No filters are set on the list."))
		#expect(text.contains("a custom view of the items in this workspace"))
	}

	@Test("the filters are empty when nothing is set")
	func noFilters() {
		#expect(CreateViewMessage.listFilters(status: nil, search: "", needsYouOnly: false, starredOnly: false).isEmpty)
	}

	@Test("an object names itself and pins to Favorites")
	func object() {
		let text = CreateViewMessage.text(for: .object(id: "obj-1", title: "Big bet", type: "bet"))
		#expect(text.contains("the bet \"Big bet\" (id obj-1)"))
		#expect(text.contains("pinned_files"))
		#expect(!text.contains("set_loop_view"))
	}

	@Test("a flow names itself and pins as a flow tab")
	func flow() {
		let text = CreateViewMessage.text(for: .flow(id: "loop-1", name: "Weekly review"))
		#expect(text.contains("the flow \"Weekly review\" (id loop-1)"))
		#expect(text.contains("set_loop_view (loop_id loop-1)"))
		#expect(!text.contains("pinned_files"))
	}
}

@MainActor
@Suite("Create view availability")
struct CreateViewStoreTests {
	private struct Source: CreateViewSource {
		var agent: ChatParticipant? = ChatParticipant(id: "a1", name: "Design Studio", kind: .agent)
		func designStudio(workspaceID: String) async throws -> ChatParticipant? { agent }
	}

	private struct Failing: CreateViewSource {
		func designStudio(workspaceID: String) async throws -> ChatParticipant? { throw CancellationError() }
	}

	@Test("flag on, a writer and Design Studio: the agent is offered")
	func offered() async {
		let store = CreateViewStore(source: Source())
		await store.load(workspaceID: "ws-1")
		#expect(store.agent(forRole: "member", flagOn: true)?.id == "a1")
		#expect(store.agent(forRole: "owner", flagOn: true)?.id == "a1")
	}

	@Test("a viewer is never offered it")
	func viewer() async {
		let store = CreateViewStore(source: Source())
		await store.load(workspaceID: "ws-1")
		#expect(store.agent(forRole: "viewer", flagOn: true) == nil)
	}

	@Test("flag off hides it")
	func flagOff() async {
		let store = CreateViewStore(source: Source())
		await store.load(workspaceID: "ws-1")
		#expect(store.agent(forRole: "member", flagOn: false) == nil)
	}

	@Test("no Design Studio in the workspace hides it")
	func noAgent() async {
		let store = CreateViewStore(source: Source(agent: nil))
		await store.load(workspaceID: "ws-1")
		#expect(store.agent(forRole: "member", flagOn: true) == nil)
	}

	@Test("a failed lookup hides it, and no workspace or a reset clears it")
	func failureAndReset() async {
		let failing = CreateViewStore(source: Failing())
		await failing.load(workspaceID: "ws-1")
		#expect(failing.agent(forRole: "member", flagOn: true) == nil)

		let store = CreateViewStore(source: Source())
		await store.load(workspaceID: "ws-1")
		await store.load(workspaceID: nil)
		#expect(store.agent(forRole: "member", flagOn: true) == nil)

		await store.load(workspaceID: "ws-1")
		store.reset()
		#expect(store.agent(forRole: "member", flagOn: true) == nil)
	}
}
