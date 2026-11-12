import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

@MainActor
private final class RecordingSink: AnalyticsSink {
	var events: [(name: String, properties: AnalyticsProperties)] = []
	func start() {}
	func identify(_ distinctId: String) {}
	func group(type: String, key: String) {}
	func capture(_ event: String, properties: AnalyticsProperties) {
		events.append((event, properties))
	}
	func reset() {}
	func stop() {}
	var updates: [AnalyticsProperties] { events.filter { $0.name == "object_updated" }.map(\.properties) }
}

@MainActor
private func makeStore(consent: AnalyticsConsent?) -> (ObjectDetailStore, FakeObjectsRemote, RecordingSink) {
	let suite = "ObjectDescriptionSaveAnalyticsTests.\(UUID().uuidString)"
	let defaults = UserDefaults(suiteName: suite)!
	defaults.removePersistentDomain(forName: suite)
	let storage = InMemoryAnalyticsStorage()
	if let consent { storage.set(consent.rawValue, for: Analytics.consentKey) }
	let sink = RecordingSink()
	let analytics = Analytics()
	analytics.configure(sink: sink, storage: storage)
	analytics.sessionChanged(actorId: "me", workspaceId: "ws-1")

	let remote = FakeObjectsRemote(objects: Fixtures.objects)
	let object = Fixtures.objects.first { $0.id == "t1" }!
	remote.setGraph(Fixtures.graph(for: object))
	let store = ObjectDetailStore(
		objectId: "t1", remote: remote, directory: ObjectsDirectory(remote: remote, actors: Fixtures.actors),
		currentActorId: "me", preload: object, defaults: defaults)
	store.analytics = analytics
	return (store, remote, sink)
}

@MainActor
@Suite("Description saves are counted")
struct ObjectDescriptionSaveAnalyticsTests {
	@Test("a saved description sends one object_updated with ids and counts only")
	func savedDescription() async {
		let (store, _, sink) = makeStore(consent: .granted)
		sink.events.removeAll()
		await store.edit(ObjectPatch(content: "A secret new description"))
		#expect(sink.updates.count == 1)
		let props = sink.updates[0]
		#expect(props["object_id"] == "t1")
		#expect(props["mutation_type"] == "field")
		#expect(props["via"] == "single")
		#expect(props["bulk_batch_size"] == 1)
		#expect(props["surface"] == "iphone")
		#expect(props["workspace_id"] == "ws-1")
		#expect(props["actor_id"] == "me")
		#expect(props["feature_area"] == "objects")
		// Nothing the person typed rides along: every value is an id, a label, a count or a flag.
		let texts = props.values.compactMap { value -> String? in
			if case .string(let text) = value { return text }
			return nil
		}
		#expect(!texts.contains { $0.contains("secret") })
	}

	@Test("nothing is sent while consent is undecided or denied")
	func noConsent() async {
		for consent in [nil, AnalyticsConsent.denied] {
			let (store, _, sink) = makeStore(consent: consent)
			await store.edit(ObjectPatch(content: "New description"))
			#expect(sink.events.isEmpty)
		}
	}

	@Test("a refused save sends nothing")
	func failedSave() async {
		let (store, remote, sink) = makeStore(consent: .granted)
		sink.events.removeAll()
		remote.fail("update")
		await store.edit(ObjectPatch(content: "New description"))
		#expect(sink.updates.isEmpty)
	}

	@Test("a title-only or status-only edit is not a description save")
	func otherEdits() async {
		let (store, _, sink) = makeStore(consent: .granted)
		sink.events.removeAll()
		await store.edit(ObjectPatch(title: "Another title"))
		await store.setStatus("done")
		#expect(sink.updates.isEmpty)
	}
}
