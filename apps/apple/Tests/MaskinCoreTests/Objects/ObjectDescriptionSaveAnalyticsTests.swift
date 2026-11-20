import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

@MainActor
private func makeStore(enabled: Bool = true) -> (ObjectDetailStore, FakeObjectsRemote, Analytics) {
	let suite = "ObjectDescriptionSaveAnalyticsTests.\(UUID().uuidString)"
	let defaults = UserDefaults(suiteName: suite)!
	defaults.removePersistentDomain(forName: suite)
	let (analytics, _, _) = makeAnalytics()
	if !enabled { analytics.setEnabled(false) }

	let remote = FakeObjectsRemote(objects: Fixtures.objects)
	let object = Fixtures.objects.first { $0.id == "t1" }!
	remote.setGraph(Fixtures.graph(for: object))
	let store = ObjectDetailStore(
		objectId: "t1", remote: remote, directory: ObjectsDirectory(remote: remote, actors: Fixtures.actors),
		currentActorId: "me", preload: object, defaults: defaults)
	store.analytics = analytics
	return (store, remote, analytics)
}

extension Analytics {
	fileprivate var updates: [AnalyticsProperties] {
		queuedEvents.filter { $0.name == "object_updated" }.map(\.properties)
	}
}

@MainActor
@Suite("Description saves are counted")
struct ObjectDescriptionSaveAnalyticsTests {
	@Test("a saved description sends one object_updated with ids and counts only")
	func savedDescription() async {
		let (store, _, analytics) = makeStore()
		await store.edit(ObjectPatch(content: "A secret new description"))
		#expect(analytics.updates.count == 1)
		let props = analytics.updates[0]
		#expect(props["object_id"] == "t1")
		#expect(props["mutation_type"] == "field")
		#expect(props["via"] == "single")
		#expect(props["bulk_batch_size"] == 1)
		// The server stamps who and where from the signed-in request, so the phone sends none of it.
		for key in ["surface", "workspace_id", "actor_id", "actor_type", "feature_area"] {
			#expect(props[key] == nil)
		}
		// Nothing the person typed rides along: every value is an id, a label, a count or a flag.
		let texts = props.values.compactMap { value -> String? in
			if case .string(let text) = value { return text }
			return nil
		}
		#expect(!texts.contains { $0.contains("secret") })
	}

	@Test("nothing is queued while the person has switched events off")
	func switchedOff() async {
		let (store, _, analytics) = makeStore(enabled: false)
		await store.edit(ObjectPatch(content: "New description"))
		#expect(analytics.queuedEvents.isEmpty)
	}

	@Test("a refused save sends nothing")
	func failedSave() async {
		let (store, remote, analytics) = makeStore()
		remote.fail("update")
		await store.edit(ObjectPatch(content: "New description"))
		#expect(analytics.updates.isEmpty)
	}

	@Test("a title-only or status-only edit is not a description save")
	func otherEdits() async {
		let (store, _, analytics) = makeStore()
		await store.edit(ObjectPatch(title: "Another title"))
		await store.setStatus("done")
		#expect(analytics.updates.isEmpty)
	}
}
