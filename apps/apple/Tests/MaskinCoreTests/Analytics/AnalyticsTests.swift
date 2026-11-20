import Foundation
import MaskinAPI
import Testing

@testable import MaskinCore

private let day = Date(timeIntervalSince1970: 1_800_000_000)  // 2027-01-15 UTC

@MainActor
@Suite("Analytics")
struct AnalyticsTests {
	// MARK: On by default, and the ways it stops

	@Test("events are on by default: no question first, the first ones queue on sign-in")
	func onByDefault() {
		let (analytics, _, _) = makeAnalytics()
		#expect(analytics.isEnabled)
		#expect(analytics.isActive)
		#expect(analytics.queuedEvents.map(\.name) == ["app_installed", "first_sign_in"])
	}

	@Test("nothing is queued before anyone is signed in")
	func silentSignedOut() {
		let (analytics, _, _) = makeAnalytics(signedIn: false)
		analytics.screen("For you", area: .forYou)
		analytics.track("object_viewed", ["entity_id": "o-1"])
		#expect(analytics.queuedEvents.isEmpty)
	}

	@Test("a build with no sender stays inert")
	func inertWithoutTransport() {
		let analytics = Analytics()
		analytics.configure(transport: nil, storage: InMemoryAnalyticsStorage(), sendsOnItsOwn: false)
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		analytics.track("object_viewed")
		#expect(!analytics.isAvailable)
		#expect(!analytics.isActive)
		#expect(analytics.queuedEvents.isEmpty)
	}

	@Test("the Settings switch stops events and forgets the ones not yet sent")
	func toggleOff() {
		let (analytics, _, storage) = makeAnalytics()
		analytics.setEnabled(false)
		analytics.track("object_viewed")
		analytics.appOpened()
		#expect(!analytics.isEnabled)
		#expect(analytics.queuedEvents.isEmpty)
		#expect(storage.value(for: Analytics.queueKey) == nil)
	}

	@Test("turning it back on queues events again")
	func toggleOn() {
		let (analytics, _, _) = makeAnalytics()
		analytics.setEnabled(false)
		analytics.setEnabled(true)
		#expect(analytics.isActive)
		#expect(analytics.queuedEvents.map(\.name).contains("app_opened"))
	}

	@Test("the switch survives a relaunch")
	func togglePersists() {
		let (analytics, _, storage) = makeAnalytics()
		analytics.setEnabled(false)
		let relaunched = Analytics()
		relaunched.configure(transport: RecordingAnalyticsTransport(), storage: storage, sendsOnItsOwn: false)
		#expect(!relaunched.isEnabled)
	}

	@Test("a 'No thanks' given to the old question is still respected")
	func legacyDenied() {
		let storage = InMemoryAnalyticsStorage()
		storage.set("denied", for: Analytics.legacyConsentKey)
		let (analytics, _, _) = makeAnalytics(storage: storage)
		#expect(!analytics.isEnabled)
		#expect(analytics.queuedEvents.isEmpty)
	}

	@Test("an old 'Share usage' answer, or none, reads as on")
	func legacyGrantedOrNone() {
		let storage = InMemoryAnalyticsStorage()
		storage.set("granted", for: Analytics.legacyConsentKey)
		#expect(makeAnalytics(storage: storage).0.isEnabled)
		#expect(makeAnalytics().0.isEnabled)
	}

	@Test("a workspace with usage sharing off queues nothing, and what was queued is forgotten")
	func workspaceOff() {
		let (analytics, _, _) = makeAnalytics()
		#expect(!analytics.queuedEvents.isEmpty)
		analytics.workspacesLoaded([WorkspaceSummary(id: "ws-1", name: "A", role: "owner", memberCount: 1, sharesUsage: false)])
		#expect(analytics.queuedEvents.isEmpty)
		#expect(!analytics.isActive)
		analytics.track("object_viewed")
		analytics.appOpened()
		#expect(analytics.queuedEvents.isEmpty)
	}

	@Test("only the selected workspace's setting counts, and it can come back on")
	func workspaceSetting() {
		let (analytics, _, _) = makeAnalytics()
		analytics.workspacesLoaded([
			WorkspaceSummary(id: "ws-1", name: "A", role: "owner", memberCount: 1, sharesUsage: true),
			WorkspaceSummary(id: "ws-2", name: "B", role: "owner", memberCount: 1, sharesUsage: false),
		])
		#expect(analytics.isActive)
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-2")
		#expect(!analytics.isActive)
		analytics.workspacesLoaded([WorkspaceSummary(id: "ws-2", name: "B", role: "owner", memberCount: 1, sharesUsage: true)])
		#expect(analytics.isActive)
	}

	@Test("a workspace with usage sharing off is not sent even if events were queued before it was known")
	func workspaceOffAtFlush() async {
		let (analytics, transport, _) = makeAnalytics()
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-9")
		analytics.track("object_viewed", ["entity_id": "o-1"])
		analytics.workspacesLoaded([WorkspaceSummary(id: "ws-9", name: "Off", role: "owner", memberCount: 1, sharesUsage: false)])
		await analytics.flushNow()
		#expect(transport.sent.allSatisfy { $0.workspaceId != "ws-9" })
	}

	@Test("a list saved by an older build reads as sharing")
	func oldWorkspaceListDecodes() throws {
		let json = #"[{"id":"w","name":"N","role":"owner","memberCount":2}]"#
		let list = try JSONDecoder().decode([WorkspaceSummary].self, from: Data(json.utf8))
		#expect(list.first?.sharesUsage == true)
	}

	@Test("signing out forgets what was not sent, and the next person starts clean")
	func signOut() {
		let (analytics, _, storage) = makeAnalytics()
		analytics.sessionChanged(actorId: nil, workspaceId: nil)
		#expect(analytics.queuedEvents.isEmpty)
		#expect(storage.value(for: Analytics.queueKey) == nil)
		analytics.track("object_viewed")
		#expect(analytics.queuedEvents.isEmpty)
		analytics.sessionChanged(actorId: "actor-2", workspaceId: "ws-2")
		#expect(analytics.queuedEvents.contains { $0.actorId == "actor-2" })
	}

	// MARK: What an event carries

	@Test("an event holds the name, the properties, the workspace, the person and the time of the action")
	func eventShape() {
		let (analytics, _, _) = makeAnalytics()
		analytics.track("foryou_card_action", ["card_kind": "decision", "card_id": "c-1", "action_id": "approve"])
		let event = analytics.queuedEvents.last
		#expect(event?.name == "foryou_card_action")
		#expect(event?.properties == ["card_kind": "decision", "card_id": "c-1", "action_id": "approve"])
		#expect(event?.workspaceId == "ws-1")
		#expect(event?.actorId == "actor-1")
		#expect(event?.occurredAt == day)
	}

	@Test("the phone never sends who or where: the server sets those")
	func noBaseFields() {
		let (analytics, _, _) = makeAnalytics()
		analytics.track("object_viewed", ["actor_id": "someone-else", "surface": "web", "workspace_id": "x", "actor_type": "agent", "object_type": "bet"])
		#expect(analytics.queuedEvents.last?.properties == ["object_type": "bet"])
	}

	@Test("names, emails and message text never leave, whatever the caller passes")
	func blockedKeys() {
		let (analytics, _, _) = makeAnalytics()
		analytics.track(
			"object_viewed",
			["name": "Alex", "Email": "a@b.c", "text": "hello", "content": "x", "title": "t", "object_type": "bet"])
		#expect(analytics.queuedEvents.last?.properties == ["object_type": "bet"])
	}

	@Test("an event the server does not allow is dropped here, so it cannot cost a batch")
	func unknownEventDropped() {
		let (analytics, _, _) = makeAnalytics()
		let before = analytics.queuedEvents.count
		analytics.track("some_new_event", ["a": "b"])
		#expect(analytics.queuedEvents.count == before)
	}

	@Test("a property the server does not allow, or with a sentence in it, is dropped and the event stays")
	func badPropertyDropped() {
		let (analytics, _, _) = makeAnalytics()
		analytics.track(
			"object_viewed",
			["entity_id": "o-1", "entity_type": "object", "object_type": "a whole sentence typed by someone", "colour": "red"])
		#expect(analytics.queuedEvents.last?.properties == ["entity_id": "o-1", "entity_type": "object"])
	}

	@Test("the allowlist checks each kind of value")
	func allowlistRules() {
		#expect(AnalyticsAllowlist.accepts(.id, "abc-123_X"))
		#expect(!AnalyticsAllowlist.accepts(.id, "has space"))
		#expect(!AnalyticsAllowlist.accepts(.id, .string(String(repeating: "a", count: 65))))
		#expect(!AnalyticsAllowlist.accepts(.id, 3))
		#expect(AnalyticsAllowlist.accepts(.label, "For you"))
		#expect(!AnalyticsAllowlist.accepts(.label, "a@b.c"))
		#expect(AnalyticsAllowlist.accepts(.int, 0))
		#expect(!AnalyticsAllowlist.accepts(.int, -1))
		#expect(!AnalyticsAllowlist.accepts(.int, "1"))
		#expect(AnalyticsAllowlist.accepts(.oneOf(["a", "b"]), "a"))
		#expect(!AnalyticsAllowlist.accepts(.oneOf(["a", "b"]), "c"))
	}

	@Test("the allowlist has the same events as the server's list")
	func matchesServerList() throws {
		let repoRoot = URL(fileURLWithPath: #filePath)
			.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
			.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
		let file = repoRoot.appendingPathComponent("apps/dev/src/lib/analytics/client-events.ts")
		let source = try String(contentsOf: file, encoding: .utf8)
		let start = try #require(source.range(of: "const EVENT_PROPERTIES"))
		let block = source[start.upperBound...].prefix(upTo: try #require(source[start.upperBound...].range(of: "\n}\n")).lowerBound)
		var serverEvents = Set<String>()
		for line in block.split(separator: "\n") where line.hasPrefix("\t") && !line.hasPrefix("\t\t") {
			let trimmed = line.dropFirst()
			if let colon = trimmed.firstIndex(of: ":"), trimmed[trimmed.startIndex..<colon].allSatisfy({ $0.isLowercase || $0 == "_" }) {
				serverEvents.insert(String(trimmed[trimmed.startIndex..<colon]))
			}
		}
		#expect(!serverEvents.isEmpty)
		#expect(Set(AnalyticsAllowlist.events.keys) == serverEvents)
	}

	// MARK: Lifecycle events

	@Test("install and first sign-in are queued once, even across launches")
	func onceOnly() {
		let (_, _, storage) = makeAnalytics()
		let (second, _, _) = makeAnalytics(storage: storage)
		// The queue from the first launch comes back, and no second install or sign-in is added.
		#expect(second.queuedEvents.map(\.name) == ["app_installed", "first_sign_in"])
		second.sessionChanged(actorId: "actor-2", workspaceId: "ws-1")
		#expect(second.queuedEvents.filter { $0.name == "first_sign_in" }.count == 1)
		#expect(second.queuedEvents.filter { $0.actorId == "actor-2" }.map(\.name) == ["first_sign_in"])
	}

	@Test("app_active goes out once per UTC day, app_opened every time")
	func activeOncePerDay() {
		let (analytics, _, storage) = makeAnalytics()
		let before = analytics.queuedEvents.count
		analytics.appOpened()
		analytics.appOpened()
		let added = Array(analytics.queuedEvents.dropFirst(before))
		#expect(added.map(\.name) == ["app_opened", "app_active", "app_opened"])
		#expect(added[1].properties["utc_day"] == "2027-01-15")
		#expect(storage.value(for: Analytics.activeDayKey) == "2027-01-15")
	}

	@Test("an app_opened on a cold start waits for the restored session, then goes out once")
	func openedBeforeSessionRestores() {
		let (analytics, _, _) = makeAnalytics(signedIn: false)
		analytics.appOpened()
		#expect(analytics.queuedEvents.isEmpty)
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		#expect(analytics.queuedEvents.map(\.name) == ["app_installed", "first_sign_in", "app_opened", "app_active"])
		analytics.sessionChanged(actorId: "actor-1", workspaceId: "ws-2")
		#expect(analytics.queuedEvents.filter { $0.name == "app_opened" }.count == 1)
	}

	@Test("opening the app before anyone is signed in does not use up the day")
	func activeWaitsForSignIn() {
		let (analytics, _, storage) = makeAnalytics(signedIn: false)
		analytics.appOpened()
		#expect(storage.value(for: Analytics.activeDayKey) == nil)
	}

	// MARK: The queue and the send

	@Test("a flush sends the queue as one batch for the workspace, and empties it")
	func flushSends() async {
		let (analytics, transport, storage) = makeAnalytics()
		analytics.appOpened()
		await analytics.flushNow()
		#expect(transport.batches.count == 1)
		#expect(transport.batches[0].workspaceId == "ws-1")
		#expect(transport.names == ["app_installed", "first_sign_in", "app_opened", "app_active"])
		#expect(analytics.queuedEvents.isEmpty)
		#expect(storage.value(for: Analytics.queueKey) == nil)
	}

	@Test("a batch holds at most 50 events")
	func batchesOf50() async {
		let (analytics, transport, _) = makeAnalytics()
		for index in 0..<58 { analytics.track("object_viewed", ["entity_id": .string("o-\(index)")]) }
		await analytics.flushNow()
		#expect(transport.batches.map(\.events.count) == [50, 10])
	}

	@Test("a failed send keeps the events for the next try")
	func transientFailureKeeps() async {
		let (analytics, transport, _) = makeAnalytics()
		let waiting = analytics.queuedEvents.count
		transport.fail(with: TransientFailure())
		await analytics.flushNow()
		#expect(analytics.queuedEvents.count == waiting)
		transport.fail(with: nil)
		await analytics.flushNow()
		#expect(transport.sent.count == waiting)
		#expect(analytics.queuedEvents.isEmpty)
	}

	@Test("a batch the server refuses is dropped, so it cannot block the ones behind it")
	func rejectedDrops() async {
		let (analytics, transport, _) = makeAnalytics()
		transport.fail(with: AnalyticsRejected())
		await analytics.flushNow()
		#expect(analytics.queuedEvents.isEmpty)
		#expect(transport.sent.isEmpty)
	}

	@Test("unsent events survive a relaunch")
	func queuePersists() {
		let (analytics, _, storage) = makeAnalytics()
		analytics.track("object_viewed", ["entity_id": "o-1"])
		let relaunched = Analytics()
		relaunched.configure(transport: RecordingAnalyticsTransport(), storage: storage, clock: { day }, sendsOnItsOwn: false)
		#expect(relaunched.queuedEvents == analytics.queuedEvents)
		#expect(relaunched.queuedEvents.last?.occurredAt == day)
	}

	@Test("events older than six days are dropped, the server refuses a week")
	func staleDropped() async {
		let (_, _, storage) = makeAnalytics()
		let later = Analytics()
		let transport = RecordingAnalyticsTransport()
		later.configure(transport: transport, storage: storage, clock: { day.addingTimeInterval(7 * 86_400) }, sendsOnItsOwn: false)
		later.sessionChanged(actorId: "actor-1", workspaceId: "ws-1")
		await later.flushNow()
		#expect(transport.sent.isEmpty)
		#expect(later.queuedEvents.isEmpty)
	}

	@Test("the queue holds at most 200 events, oldest first out")
	func queueCap() {
		let (analytics, _, _) = makeAnalytics()
		for index in 0..<230 { analytics.track("object_viewed", ["entity_id": .string("o-\(index)")]) }
		#expect(analytics.queuedEvents.count == 200)
		#expect(analytics.queuedEvents.last?.properties["entity_id"] == "o-229")
	}

	@Test("a switched-off phone does not send what was left from before")
	func switchedOffDoesNotFlush() async {
		let (analytics, transport, _) = makeAnalytics()
		analytics.setEnabled(false)
		await analytics.flushNow()
		#expect(transport.sent.isEmpty)
	}

	// MARK: The request

	@Test("the request goes to the client route with the workspace, the key and the action times")
	func requestShape() async throws {
		let transport = APIAnalyticsTransport(
			baseURL: URL(string: "https://example.test")!, clientSource: "ios",
			credentials: { MaskinCredentials(apiKey: "key-1", workspaceId: nil) })
		let event = AnalyticsEvent(
			name: "object_created", properties: ["entity_id": "o-1", "entity_type": "object", "ok": true, "n": 2],
			occurredAt: day, workspaceId: "ws-1", actorId: "actor-1")
		let request = try await transport.makeRequest([event], workspaceId: "ws-1")
		#expect(request.url?.absoluteString == "https://example.test/api/telemetry/client")
		#expect(request.httpMethod == "POST")
		#expect(request.value(forHTTPHeaderField: "X-Workspace-Id") == "ws-1")
		#expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer key-1")
		let body = try #require(request.httpBody)
		let json = try #require(try JSONSerialization.jsonObject(with: body) as? [String: [[String: Any]]])
		let sent = try #require(json["events"]?.first)
		#expect(sent["name"] as? String == "object_created")
		#expect(sent["occurred_at"] as? String == "2027-01-15T08:00:00Z")
		let properties = try #require(sent["properties"] as? [String: Any])
		#expect(properties["entity_id"] as? String == "o-1")
		#expect(properties["ok"] as? Bool == true)
		#expect(properties["n"] as? Int == 2)
		// The ids of the queue and the person stay on the phone: the server reads them from the key.
		#expect(sent["id"] == nil)
		#expect(sent["actorId"] == nil)
	}

	// MARK: The events the web also sends

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

	@Test("a screen view carries the screen and its feature area")
	func screenView() {
		let (analytics, _, _) = makeAnalytics()
		analytics.screen("For you", area: .forYou)
		#expect(analytics.queuedEvents.last?.properties == ["screen": "For you", "feature_area": "for_you"])
	}

	@Test("option labels become the same ids the web app sends")
	func slugs() {
		#expect(Analytics.slug("7-day window") == "7_day_window")
		#expect(Analytics.slug("  Approve!  ") == "approve")
		#expect(Analytics.slug("???") == "option")
	}

	@Test("foryou_card_shown goes out once per card with the web's property names")
	func cardShownOnce() {
		let (analytics, _, _) = makeAnalytics()
		let before = analytics.queuedEvents.count
		analytics.foryouCardShown(cardKind: "decision", cardId: "card-1")
		analytics.foryouCardShown(cardKind: "decision", cardId: "card-1")
		analytics.foryouCardShown(cardKind: "thread", cardId: "card-2")
		let added = Array(analytics.queuedEvents.dropFirst(before))
		#expect(added.map(\.name) == ["foryou_card_shown", "foryou_card_shown"])
		#expect(added[0].properties == ["card_kind": "decision", "card_id": "card-1"])
	}

	@Test("chat_session_started carries ids and counts, and the role only for one agent")
	func chatStarted() {
		let (analytics, _, _) = makeAnalytics()
		let before = analytics.queuedEvents.count
		let chief = ChatParticipant(id: "a-1", name: "Chief of Staff", kind: .agent)
		let person = ChatParticipant(id: "h-1", name: "Sam Example", kind: .human)
		analytics.chatSessionStarted(conversationId: "chat-1", participants: [chief])
		analytics.chatSessionStarted(conversationId: "chat-2", participants: [chief, person])
		let added = Array(analytics.queuedEvents.dropFirst(before))
		#expect(added.map(\.name) == ["chat_session_started", "chat_session_started"])
		let one = added[0].properties
		#expect(one["entity_id"] == "chat-1")
		#expect(one["entity_type"] == "session")
		#expect(one["entry_point"] == "agent_one_shot")
		#expect(one["participant_count"] == 1)
		#expect(one["entry_agent_role"] == "chief-of-staff")
		let two = added[1].properties
		#expect(two["participant_count"] == 2)
		#expect(two["entry_agent_role"] == nil)
		#expect(!two.values.contains(.string("Sam Example")))
	}

	@Test("object_created carries the id and the object's type, nothing typed by the person")
	func objectCreated() {
		let (analytics, _, _) = makeAnalytics()
		analytics.objectCreated(id: "obj-1", type: "bet")
		#expect(analytics.queuedEvents.last?.name == "object_created")
		#expect(
			analytics.queuedEvents.last?.properties
				== ["entity_id": "obj-1", "entity_type": "object", "source": "iphone", "object_subtype": "bet"])
	}

	@Test("every event the app sends today passes the allowlist with all its properties")
	func appEventsPass() {
		let (analytics, _, _) = makeAnalytics()
		analytics.appOpened()
		analytics.screen("For you", area: .forYou)
		analytics.foryouCardShown(cardKind: "decision", cardId: "c-1")
		analytics.track("foryou_card_action", ["card_kind": "thread", "card_id": "c-1", "action_id": "dismiss"])
		analytics.chatSessionStarted(conversationId: "chat-1", participants: [])
		analytics.objectCreated(id: "o-1", type: "task")
		analytics.objectUpdated(id: "o-1", mutationType: "field")
		analytics.track("object_viewed", ["entity_id": "o-1", "entity_type": "object", "object_type": "task"])
		analytics.track("push_permission_granted")
		analytics.track("push_permission_denied")
		analytics.track("push_notification_opened")
		analytics.chatOpenedFromList(.init(source: .search, section: .search, position: 30))
		analytics.chatListSearchUsed(resultCount: 25)
		let byName = Dictionary(grouping: analytics.queuedEvents, by: \.name)
		#expect(byName["object_updated"]?.first?.properties.count == 4)
		#expect(byName["chat_session_started"]?.first?.properties.count == 5)
		#expect(byName["screen_viewed"]?.first?.properties.count == 2)
		#expect(byName["chat_opened_from_list"]?.first?.properties.count == 3)
		#expect(byName["chat_list_search_used"]?.first?.properties.count == 1)
		for name in ["push_permission_granted", "push_permission_denied", "push_notification_opened"] {
			#expect(byName[name]?.count == 1)
		}
	}

	@Test("the role is the web's kebab-cased agent name")
	func agentRole() {
		#expect(Analytics.agentRole("Chief of Staff") == "chief-of-staff")
		#expect(Analytics.agentRole("  Code  Reviewer! ") == "code-reviewer")
		#expect(Analytics.agentRole("???") == nil)
		#expect(Analytics.agentRole(nil) == nil)
	}
}
