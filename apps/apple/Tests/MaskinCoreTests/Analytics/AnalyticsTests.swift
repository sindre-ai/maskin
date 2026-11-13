import Foundation
import Testing

@testable import MaskinCore

@MainActor
private final class RecordingSink: AnalyticsSink {
	struct Event: Equatable {
		var name: String
		var properties: AnalyticsProperties
	}
	var started = 0
	var stopped = 0
	var resets = 0
	var identified: [String] = []
	var groups: [String] = []
	var events: [Event] = []

	func start() { started += 1 }
	func identify(_ distinctId: String) { identified.append(distinctId) }
	func group(type: String, key: String) { groups.append("\(type):\(key)") }
	func capture(_ event: String, properties: AnalyticsProperties) {
		events.append(Event(name: event, properties: properties))
	}
	func reset() { resets += 1 }
	func stop() { stopped += 1 }

	var names: [String] { events.map(\.name) }
}

@MainActor
private func make(
	consent: AnalyticsConsent? = nil, now: Date = Date(timeIntervalSince1970: 1_800_000_000)
) -> (Analytics, RecordingSink, InMemoryAnalyticsStorage) {
	let storage = InMemoryAnalyticsStorage()
	if let consent { storage.set(consent.rawValue, for: Analytics.consentKey) }
	let sink = RecordingSink()
	let analytics = Analytics()
	analytics.configure(sink: sink, storage: storage, clock: { now })
	return (analytics, sink, storage)
}

@MainActor
@Suite("Analytics")
struct AnalyticsTests {
	@Test("nothing is sent until the person has agreed")
	func silentWithoutConsent() {
		let (analytics, sink, _) = make()
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		analytics.appOpened()
		analytics.screen("For you", area: .forYou)
		analytics.track("object_viewed", ["entity_id": "o-1"])
		#expect(analytics.consent == .undecided)
		#expect(sink.started == 0)
		#expect(sink.identified.isEmpty)
		#expect(sink.events.isEmpty)
	}

	@Test("a refusal keeps it silent too")
	func silentWhenDenied() {
		let (analytics, sink, _) = make(consent: .denied)
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		analytics.appOpened()
		#expect(sink.started == 0)
		#expect(sink.events.isEmpty)
	}

	@Test("a build with no project token stays inert and never asks")
	func inertWithoutSink() {
		let analytics = Analytics()
		analytics.configure(sink: nil, storage: InMemoryAnalyticsStorage())
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		analytics.track("object_viewed")
		#expect(!analytics.isAvailable)
		#expect(!analytics.needsConsentPrompt)
	}

	@Test("asks once: signed in, build can send, no answer yet")
	func promptOwed() {
		let (analytics, _, _) = make()
		#expect(!analytics.needsConsentPrompt)
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		#expect(analytics.needsConsentPrompt)
		analytics.setConsent(false)
		#expect(!analytics.needsConsentPrompt)
	}

	@Test("agreeing starts the tool, identifies by actor id only and sends the waiting events")
	func agreeing() {
		let (analytics, sink, _) = make()
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		analytics.setConsent(true)
		#expect(sink.started == 1)
		#expect(sink.identified == ["actor-1"])
		#expect(sink.groups == ["workspace:ws-1"])
		#expect(sink.names == ["app_installed", "first_sign_in", "app_opened", "app_active"])
	}

	@Test("every event carries the shared properties")
	func sharedProperties() {
		let (analytics, sink, _) = make(consent: .granted)
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		sink.events.removeAll()
		analytics.track("foryou_card_action", ["card_id": "c-1"])
		let props = sink.events.first?.properties
		#expect(props?["workspace_id"] == "ws-1")
		#expect(props?["actor_id"] == "actor-1")
		#expect(props?["actor_type"] == "human")
		#expect(props?["surface"] == "iphone")
		#expect(props?["feature_area"] == "for_you")
		#expect(props?["card_id"] == "c-1")
	}

	@Test("names, emails and message text never leave, whatever the caller passes")
	func blockedKeys() {
		let (analytics, sink, _) = make(consent: .granted)
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		sink.events.removeAll()
		analytics.track(
			"object_viewed",
			["name": "Alex", "Email": "a@b.c", "text": "hello", "content": "x", "title": "t", "object_type": "bet"])
		let props = sink.events.first?.properties ?? [:]
		#expect(props["object_type"] == "bet")
		for key in ["name", "Email", "text", "content", "title"] { #expect(props[key] == nil) }
	}

	@Test("a caller cannot overwrite who or where the event is from")
	func sharedPropertiesWin() {
		let (analytics, sink, _) = make(consent: .granted)
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		sink.events.removeAll()
		analytics.track("object_viewed", ["actor_id": "someone-else", "surface": "web"])
		#expect(sink.events.first?.properties["actor_id"] == "actor-1")
		#expect(sink.events.first?.properties["surface"] == "iphone")
	}

	@Test("install and first sign-in are sent once, even across launches")
	func onceOnly() {
		let (first, sink, storage) = make(consent: .granted)
		first.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		#expect(sink.names == ["app_installed", "first_sign_in"])

		let second = Analytics()
		let again = RecordingSink()
		second.configure(sink: again, storage: storage)
		second.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		#expect(again.events.isEmpty)

		second.sessionChanged(actorId: "actor-2", workspaceId: "ws-1")
		#expect(again.names == ["first_sign_in"])
	}

	@Test("app_active goes out once per UTC day, app_opened every time")
	func activeOncePerDay() {
		let (analytics, sink, storage) = make(consent: .granted)
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		sink.events.removeAll()
		analytics.appOpened()
		analytics.appOpened()
		#expect(sink.names == ["app_opened", "app_active", "app_opened"])
		#expect(sink.events[1].properties["utc_day"] == "2027-01-15")
		#expect(storage.value(for: Analytics.activeDayKey) == "2027-01-15")
	}

	@Test("opening the app before anyone is signed in does not use up the day")
	func activeWaitsForSignIn() {
		let (analytics, sink, storage) = make(consent: .granted)
		analytics.appOpened()
		#expect(sink.events.isEmpty)
		#expect(storage.value(for: Analytics.activeDayKey) == nil)
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		analytics.appOpened()
		#expect(sink.names.contains("app_active"))
	}

	@Test("taking consent back stops the tool and sends nothing more")
	func revoking() {
		let (analytics, sink, _) = make(consent: .granted)
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		sink.events.removeAll()
		analytics.setConsent(false)
		analytics.track("object_viewed")
		#expect(sink.stopped == 1)
		#expect(sink.events.isEmpty)
		#expect(analytics.consent == .denied)
	}

	@Test("signing out forgets the person, and the next one is identified fresh")
	func signOut() {
		let (analytics, sink, _) = make(consent: .granted)
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		analytics.sessionChanged(actorId: nil, workspaceId: nil)
		#expect(sink.resets == 1)
		sink.events.removeAll()
		analytics.track("object_viewed")
		#expect(sink.events.isEmpty)
		analytics.sessionChanged(actorId: "actor-2", workspaceId: "ws-2")
		#expect(sink.identified == ["actor-1", "actor-2"])
		#expect(sink.groups == ["workspace:ws-1", "workspace:ws-2"])
	}

	@Test("the answer survives a relaunch")
	func answerPersists() {
		let (analytics, _, storage) = make()
		analytics.setConsent(true)
		let relaunched = Analytics()
		relaunched.configure(sink: RecordingSink(), storage: storage)
		#expect(relaunched.consent == .granted)
	}

	@Test("feature areas match the shared list")
	func featureAreas() {
		#expect(AnalyticsFeatureArea.allCases.map(\.rawValue) == [
			"chats", "for_you", "objects", "loops_triggers", "agents", "files_briefings",
			"integrations", "search", "voice", "billing", "settings",
		])
		#expect(AnalyticsFeatureArea.forEvent("foryou_card_action") == .forYou)
		#expect(AnalyticsFeatureArea.forEvent("object_viewed") == .objects)
		#expect(AnalyticsFeatureArea.forEvent("loop_viewed") == .loopsTriggers)
		#expect(AnalyticsFeatureArea.forEvent("agent_chat_started") == .chats)
		#expect(AnalyticsFeatureArea.forEvent("agent_opened") == .agents)
		#expect(AnalyticsFeatureArea.forEvent("app_opened") == nil)
		#expect(AnalyticsFeatureArea.forEvent("screen_viewed") == nil)
	}

	@Test("option labels become the same ids the web app sends")
	func slugs() {
		#expect(Analytics.slug("7-day window") == "7_day_window")
		#expect(Analytics.slug("  Approve!  ") == "approve")
		#expect(Analytics.slug("???") == "option")
	}

	@Test("foryou_card_shown goes out once per card with the web's property names")
	func cardShownOnce() {
		let (analytics, sink, _) = make(consent: .granted)
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		sink.events.removeAll()
		analytics.foryouCardShown(cardKind: "decision", cardId: "card-1")
		analytics.foryouCardShown(cardKind: "decision", cardId: "card-1")
		analytics.foryouCardShown(cardKind: "thread", cardId: "card-2")
		#expect(sink.names == ["foryou_card_shown", "foryou_card_shown"])
		#expect(sink.events[0].properties["card_kind"] == "decision")
		#expect(sink.events[0].properties["card_id"] == "card-1")
		#expect(sink.events[0].properties["feature_area"] == "for_you")
		#expect(sink.events[0].properties["surface"] == "iphone")
	}

	@Test("a card seen before consent is still counted once consent is given")
	func cardShownWaitsForConsent() {
		let (analytics, sink, _) = make()
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		analytics.foryouCardShown(cardKind: "decision", cardId: "card-1")
		#expect(sink.events.isEmpty)
		analytics.setConsent(true)
		sink.events.removeAll()
		analytics.foryouCardShown(cardKind: "decision", cardId: "card-1")
		#expect(sink.names == ["foryou_card_shown"])
	}

	@Test("chat_session_started carries ids and counts, and the role only for one agent")
	func chatStarted() {
		let (analytics, sink, _) = make(consent: .granted)
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		sink.events.removeAll()
		let chief = ChatParticipant(id: "a-1", name: "Chief of Staff", kind: .agent)
		let person = ChatParticipant(id: "h-1", name: "Sam Example", kind: .human)
		analytics.chatSessionStarted(conversationId: "chat-1", participants: [chief])
		analytics.chatSessionStarted(conversationId: "chat-2", participants: [chief, person])
		#expect(sink.names == ["chat_session_started", "chat_session_started"])
		let one = sink.events[0].properties
		#expect(one["entity_id"] == "chat-1")
		#expect(one["entity_type"] == "session")
		#expect(one["entry_point"] == "agent_one_shot")
		#expect(one["participant_count"] == 1)
		#expect(one["entry_agent_role"] == "chief-of-staff")
		#expect(one["feature_area"] == "chats")
		let two = sink.events[1].properties
		#expect(two["participant_count"] == 2)
		#expect(two["entry_agent_role"] == nil)
		// Names never ride along.
		#expect(!two.values.contains(.string("Sam Example")))
	}

	@Test("object_created carries the id and the object's type, nothing typed by the person")
	func objectCreated() {
		let (analytics, sink, _) = make(consent: .granted)
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		sink.events.removeAll()
		analytics.objectCreated(id: "obj-1", type: "bet")
		#expect(sink.names == ["object_created"])
		let props = sink.events[0].properties
		#expect(props["entity_id"] == "obj-1")
		#expect(props["entity_type"] == "object")
		#expect(props["object_subtype"] == "bet")
		#expect(props["feature_area"] == "objects")
		#expect(props["workspace_id"] == "ws-1")
	}

	@Test("an app_opened on a cold start waits for the restored session, then goes out once")
	func openedBeforeSessionRestores() {
		let (analytics, sink, _) = make(consent: .granted)
		analytics.appOpened()
		#expect(sink.events.isEmpty)
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		#expect(sink.names == ["app_installed", "first_sign_in", "app_opened", "app_active"])
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-2")
		#expect(sink.names.filter { $0 == "app_opened" }.count == 1)
	}

	@Test("an app_opened before the person has agreed is not replayed later")
	func openedBeforeConsentIsNotQueued() {
		let (analytics, sink, _) = make()
		analytics.appOpened()
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		#expect(sink.events.isEmpty)
	}

	@Test("the role is the web's kebab-cased agent name")
	func agentRole() {
		#expect(Analytics.agentRole("Chief of Staff") == "chief-of-staff")
		#expect(Analytics.agentRole("  Code  Reviewer! ") == "code-reviewer")
		#expect(Analytics.agentRole("???") == nil)
		#expect(Analytics.agentRole(nil) == nil)
	}
}
