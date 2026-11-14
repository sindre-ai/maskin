import Foundation
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
}

@MainActor
private func makeAnalytics(consent: AnalyticsConsent?) -> (Analytics, RecordingSink) {
	let storage = InMemoryAnalyticsStorage()
	if let consent { storage.set(consent.rawValue, for: Analytics.consentKey) }
	let sink = RecordingSink()
	let analytics = Analytics()
	analytics.configure(sink: sink, storage: storage)
	analytics.sessionChanged(actorId: "me", workspaceId: "ws-1")
	sink.events.removeAll()
	return (analytics, sink)
}

@MainActor
@Suite("A push tap is counted with the notification id and type")
struct PushOpenedAnalyticsTests {
	@Test("push_notification_opened carries the id and type from the payload and the shared fields")
	func carriesIdAndType() {
		let (analytics, sink) = makeAnalytics(consent: .granted)
		analytics.pushNotificationOpened(notificationId: "n-1", type: "needs_input")
		#expect(sink.events.count == 1)
		let event = sink.events[0]
		#expect(event.name == "push_notification_opened")
		#expect(event.properties["notification_id"] == "n-1")
		#expect(event.properties["type"] == "needs_input")
		#expect(event.properties["surface"] == "iphone")
		#expect(event.properties["workspace_id"] == "ws-1")
	}

	@Test("a push from before the type was sent still counts, without it")
	func missingType() {
		let (analytics, sink) = makeAnalytics(consent: .granted)
		analytics.pushNotificationOpened(notificationId: "n-1", type: nil)
		#expect(sink.events.count == 1)
		#expect(sink.events[0].properties["type"] == nil)
	}

	@Test("a value that is not a plain id is dropped, so no text rides along")
	func dropsNonIds() {
		let (analytics, sink) = makeAnalytics(consent: .granted)
		analytics.pushNotificationOpened(notificationId: "Quarterly numbers are ready", type: "hello there")
		#expect(sink.events.count == 1)
		#expect(sink.events[0].properties["notification_id"] == nil)
		#expect(sink.events[0].properties["type"] == nil)
	}

	@Test("nothing is sent without consent")
	func noConsent() {
		for consent in [nil, AnalyticsConsent.denied] {
			let (analytics, sink) = makeAnalytics(consent: consent)
			analytics.pushNotificationOpened(notificationId: "n-1", type: "message")
			#expect(sink.events.isEmpty)
		}
	}
}
