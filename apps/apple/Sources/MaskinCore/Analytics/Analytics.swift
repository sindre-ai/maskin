import Foundation
import Observation

/// A property value an event may carry. Only these four shapes exist, so a name, an address or a
/// message cannot ride along as an object.
public enum AnalyticsValue: Sendable, Equatable, ExpressibleByStringLiteral,
	ExpressibleByIntegerLiteral, ExpressibleByBooleanLiteral
{
	case string(String)
	case int(Int)
	case bool(Bool)

	public init(stringLiteral value: String) { self = .string(value) }
	public init(integerLiteral value: Int) { self = .int(value) }
	public init(booleanLiteral value: Bool) { self = .bool(value) }
}

extension AnalyticsValue: Codable {
	public init(from decoder: any Decoder) throws {
		let container = try decoder.singleValueContainer()
		if let flag = try? container.decode(Bool.self) {
			self = .bool(flag)
		} else if let number = try? container.decode(Int.self) {
			self = .int(number)
		} else {
			self = .string(try container.decode(String.self))
		}
	}

	public func encode(to encoder: any Encoder) throws {
		var container = encoder.singleValueContainer()
		switch self {
		case .string(let value): try container.encode(value)
		case .int(let value): try container.encode(value)
		case .bool(let value): try container.encode(value)
		}
	}
}

public typealias AnalyticsProperties = [String: AnalyticsValue]

/// One product event waiting to be sent. Never holds the base fields (`workspace_id`, `actor_id`,
/// `actor_type`, `surface`): the server sets those from the signed-in request.
public struct AnalyticsEvent: Codable, Sendable, Equatable, Identifiable {
	public var id: UUID
	public var name: String
	public var properties: AnalyticsProperties
	/// When the action happened, so an event sent later (offline) still lands on the right day.
	public var occurredAt: Date
	public var workspaceId: String
	public var actorId: String

	public init(
		id: UUID = UUID(), name: String, properties: AnalyticsProperties, occurredAt: Date,
		workspaceId: String, actorId: String
	) {
		self.id = id
		self.name = name
		self.properties = properties
		self.occurredAt = occurredAt
		self.workspaceId = workspaceId
		self.actorId = actorId
	}
}

/// Throw from a transport when the server will never accept the batch (a 4xx other than a sign-in
/// problem, rate limit or timeout). The batch is dropped. Any other error keeps it for the next try.
public struct AnalyticsRejected: Error, Sendable, Equatable {
	public init() {}
}

/// Where a batch goes. The real one posts to the server route (`APIAnalyticsTransport`); tests
/// record calls instead.
public protocol AnalyticsTransport: Sendable {
	func send(_ events: [AnalyticsEvent], workspaceId: String) async throws
}

/// Small key-value store for the on/off switch, the unsent events and the once-only events.
public protocol AnalyticsStorage: Sendable {
	func value(for key: String) -> String?
	func set(_ value: String?, for key: String)
}

public final class InMemoryAnalyticsStorage: AnalyticsStorage, @unchecked Sendable {
	private let lock = NSLock()
	private var values: [String: String] = [:]
	public init() {}
	public func value(for key: String) -> String? { lock.withLock { values[key] } }
	public func set(_ value: String?, for key: String) { lock.withLock { values[key] = value } }
}

public struct UserDefaultsAnalyticsStorage: AnalyticsStorage, @unchecked Sendable {
	private let defaults: UserDefaults
	public init(defaults: UserDefaults = .standard) { self.defaults = defaults }
	public func value(for key: String) -> String? { defaults.string(forKey: key) }
	public func set(_ value: String?, for key: String) {
		if let value { defaults.set(value, forKey: key) } else { defaults.removeObject(forKey: key) }
	}
}

/// Product analytics for the phone, with the same event and property names as the web app (see
/// `AnalyticsFeatureArea` and `packages/shared/src/analytics-feature-area.ts`).
///
/// Events are queued on the phone with the time of the action and sent in batches to the server
/// (`POST /api/telemetry/client`), which applies the workspace's share-usage and anonymise settings
/// and the list of allowed names. There is no third-party SDK in the app.
///
/// The rules this type enforces, so call sites cannot get them wrong:
/// - On by default. Nothing is queued or sent when the person has switched it off in Settings, or
///   when the selected workspace has usage sharing off.
/// - Only events and property keys the server allows are queued (`AnalyticsAllowlist`). No names,
///   emails, message text, device id or advertising id ever ride along.
/// - The server stamps `workspace_id`, `actor_id`, `actor_type` and `surface` from the request, so
///   the phone sends none of them.
/// - Unsent events survive a relaunch, are dropped after six days (the server takes a week) and
///   when the person signs out.
///
/// `shared` is inert until `configure(transport:)` runs.
@MainActor
@Observable
public final class Analytics {
	public static let shared = Analytics()

	/// The person's own switch (Settings). On unless they turned it off.
	public private(set) var isEnabled = true

	@ObservationIgnored private var transport: (any AnalyticsTransport)?
	@ObservationIgnored private var storage: any AnalyticsStorage = InMemoryAnalyticsStorage()
	@ObservationIgnored private var clock: @Sendable () -> Date = { Date() }
	@ObservationIgnored private var actorId: String?
	@ObservationIgnored private var workspaceId: String?
	/// Whether each workspace the person belongs to shares usage. Unknown means it does, the same
	/// default as the server.
	@ObservationIgnored private var workspaceSharing: [String: Bool] = [:]
	@ObservationIgnored private var queue: [AnalyticsEvent] = []
	@ObservationIgnored private var flushing = false
	/// Tests turn this off and call `flushNow()` themselves, so a send never races an assertion.
	@ObservationIgnored private var sendsOnItsOwn = true
	/// The app came to the front but nobody was signed in yet (a cold start restores the session a
	/// moment later). The `app_opened` is sent once the person is known.
	@ObservationIgnored private var openWaitingForSignIn = false
	/// Cards already counted as shown since launch, like the web's per-page-load record.
	@ObservationIgnored private var impressedCards: Set<String> = []

	static let enabledKey = "analytics.enabled.v1"
	/// The answer to the old one-time question. Only read, so a "No thanks" is still respected.
	static let legacyConsentKey = "analytics.consent.v1"
	static let queueKey = "analytics.queue.v1"
	static let installedKey = "analytics.sent.app_installed.v1"
	static let activeDayKey = "analytics.sent.app_active_day.v1"
	static func firstSignInKey(_ actorId: String) -> String { "analytics.sent.first_sign_in.v1.\(actorId)" }

	/// Most events kept on the phone. The oldest go first.
	static let maxQueued = 200
	/// A full queue sends without waiting for the app to go to the background.
	static let flushThreshold = 20
	/// The server takes at most 50 per batch.
	static let batchSize = 50
	/// The server refuses actions older than a week. Drop a day before that.
	static let maxAge: TimeInterval = 6 * 24 * 60 * 60
	/// The server refuses actions more than 5 minutes ahead of it.
	static let maxFuture: TimeInterval = 4 * 60

	/// Keys that usually hold a person's words or identity. Dropped from every event.
	static let blockedKeys: Set<String> = [
		"name", "email", "title", "text", "content", "message", "body", "summary", "description",
		"subject", "query", "label", "note", "phone",
	]

	public init() {}

	/// Wires the sender in and reads the saved switch and unsent events. A nil transport keeps
	/// everything inert (previews, tests).
	public func configure(
		transport: (any AnalyticsTransport)?, storage: any AnalyticsStorage = UserDefaultsAnalyticsStorage(),
		clock: @escaping @Sendable () -> Date = { Date() }, sendsOnItsOwn: Bool = true
	) {
		self.sendsOnItsOwn = sendsOnItsOwn
		self.transport = transport
		self.storage = storage
		self.clock = clock
		if let saved = storage.value(for: Self.enabledKey) {
			isEnabled = saved == "1"
		} else {
			isEnabled = storage.value(for: Self.legacyConsentKey) != "denied"
		}
		queue = Self.readQueue(storage)
		syncIdentity()
	}

	/// True when this build can send at all, so Settings shows the switch.
	public var isAvailable: Bool { transport != nil }

	/// True when events are being queued: the switch is on and the selected workspace shares usage.
	public var isActive: Bool { transport != nil && isEnabled && workspaceSharesUsage }

	private var workspaceSharesUsage: Bool {
		workspaceId.map { workspaceSharing[$0] ?? true } ?? true
	}

	/// The Settings switch. Turning it off also forgets what has not been sent yet.
	public func setEnabled(_ enabled: Bool) {
		storage.set(enabled ? "1" : "0", for: Self.enabledKey)
		isEnabled = enabled
		if enabled {
			syncIdentity()
			appOpened()
		} else {
			queue = []
			persistQueue()
		}
	}

	/// The workspaces the person belongs to, with each one's usage-sharing setting. Events for a
	/// workspace that does not share are forgotten at once.
	public func workspacesLoaded(_ workspaces: [WorkspaceSummary]) {
		workspaceSharing = Dictionary(workspaces.map { ($0.id, $0.sharesUsage) }) { _, last in last }
		let before = queue.count
		queue.removeAll { workspaceSharing[$0.workspaceId] == false }
		if queue.count != before { persistQueue() }
		syncIdentity()
	}

	/// Called whenever the signed-in actor or workspace changes (nil actor = signed out).
	public func sessionChanged(actorId: String?, workspaceId: String?) {
		let leaving = self.actorId != nil && actorId != self.actorId
		self.actorId = actorId
		self.workspaceId = workspaceId
		// Events belong to the person who made them. They are not sent under someone else's key.
		if leaving {
			queue = []
			persistQueue()
		}
		syncIdentity()
		if actorId != nil { flush() }
	}

	/// Sends the once-only events that were waiting for a sign-in.
	private func syncIdentity() {
		guard isActive, let actorId, workspaceId != nil else { return }
		sendOnce(Self.installedKey, event: "app_installed")
		sendOnce(Self.firstSignInKey(actorId), event: "first_sign_in")
		if openWaitingForSignIn {
			openWaitingForSignIn = false
			appOpened()
		}
	}

	private func sendOnce(_ key: String, event: String) {
		guard storage.value(for: key) == nil else { return }
		storage.set("1", for: key)
		track(event)
	}

	/// The app came to the front: `app_opened` every time, `app_active` once per UTC day (the daily
	/// and weekly active people event, same name and `utc_day` as the web app).
	public func appOpened() {
		guard isActive else { return }
		// No person yet: nothing goes out and the day must not be marked as sent. Remember the open
		// so it goes out as soon as the session is restored.
		guard actorId != nil, workspaceId != nil else {
			openWaitingForSignIn = true
			return
		}
		track("app_opened")
		let day = Self.utcDay(clock())
		if storage.value(for: Self.activeDayKey) != day {
			storage.set(day, for: Self.activeDayKey)
			track("app_active", ["utc_day": .string(day)])
		}
		flush()
	}

	/// A main screen came on show.
	public func screen(_ name: String, area: AnalyticsFeatureArea? = nil) {
		var props: AnalyticsProperties = ["screen": .string(name)]
		if let area { props["feature_area"] = .string(area.rawValue) }
		track("screen_viewed", props)
	}

	/// A For you card came on screen: `foryou_card_shown`, once per card per launch (the web's
	/// denominator for `foryou_card_action`). `cardKind` is `decision` or `thread`.
	public func foryouCardShown(cardKind: String, cardId: String) {
		guard isActive, actorId != nil, !impressedCards.contains(cardId) else { return }
		impressedCards.insert(cardId)
		track("foryou_card_shown", ["card_kind": .string(cardKind), "card_id": .string(cardId)])
	}

	/// A chat was created on the server. `participants` are the people and agents the person picked
	/// (not themselves). The agent's name only feeds the web's kebab-cased role (`chief-of-staff`),
	/// and only when the chat has that one agent and nobody else.
	public func chatSessionStarted(conversationId: String, participants: [ChatParticipant]) {
		var props: AnalyticsProperties = [
			"entity_id": .string(conversationId), "entity_type": "session", "source": "iphone",
			"entry_point": "agent_one_shot", "participant_count": .int(participants.count),
		]
		if participants.count == 1, let only = participants.first, only.kind == .agent,
			let role = Self.agentRole(only.name)
		{
			props["entry_agent_role"] = .string(role)
		}
		track("chat_session_started", props)
	}

	/// An object was created and the server confirmed it. `type` is the object's own type (bet,
	/// insight, task...), sent as `object_subtype` like the web.
	public func objectCreated(id: String, type: String) {
		track(
			"object_created",
			[
				"entity_id": .string(id), "entity_type": "object", "source": "iphone",
				"object_subtype": .string(type),
			])
	}

	/// An existing object was changed and the server confirmed it. Same names as the web's
	/// `object_updated` (`mutation_type` is `field` for a title, description or property edit).
	/// Ids and counts only, never the text that changed.
	public func objectUpdated(id: String, mutationType: String) {
		track(
			"object_updated",
			[
				"object_id": .string(id), "mutation_type": .string(mutationType), "via": "single",
				"bulk_batch_size": 1,
			])
	}

	/// Queues one event when sending is on and a person is signed in. Events the server does not
	/// allow are dropped here, so one of them cannot cost the whole batch.
	public func track(_ event: String, _ properties: AnalyticsProperties = [:]) {
		guard isActive, let actorId, let workspaceId else { return }
		let safe = properties.filter { !Self.blockedKeys.contains($0.key.lowercased()) }
		guard let clean = AnalyticsAllowlist.clean(event: event, properties: safe) else { return }
		queue.append(
			AnalyticsEvent(
				name: event, properties: clean, occurredAt: clock(), workspaceId: workspaceId,
				actorId: actorId))
		if queue.count > Self.maxQueued { queue.removeFirst(queue.count - Self.maxQueued) }
		persistQueue()
		if queue.count >= Self.flushThreshold { flush() }
	}

	/// Sends what is queued, a batch at a time. Called when the app comes to the front or goes to
	/// the background, when someone signs in, and when the queue fills. Safe to call often: one send
	/// runs at a time, and a failed one leaves the events for the next call.
	public func flush() {
		guard sendsOnItsOwn else { return }
		Task { await flushNow() }
	}

	func flushNow() async {
		guard let transport, isEnabled, !flushing else { return }
		flushing = true
		defer { flushing = false }
		dropUnsendable()
		while let first = queue.first {
			let workspace = first.workspaceId
			let batch = Array(queue.lazy.filter { $0.workspaceId == workspace }.prefix(Self.batchSize))
			do {
				try await transport.send(batch, workspaceId: workspace)
			} catch is AnalyticsRejected {
				// The server will never take this batch. Dropping it keeps one bad event from
				// blocking everything behind it.
			} catch {
				return
			}
			let sent = Set(batch.map(\.id))
			queue.removeAll { sent.contains($0.id) }
			persistQueue()
		}
	}

	/// Events that must not go out: too old or ahead of the clock for the server, made by someone
	/// else, or for a workspace that does not share usage.
	private func dropUnsendable() {
		let now = clock()
		let before = queue.count
		queue.removeAll {
			$0.occurredAt < now.addingTimeInterval(-Self.maxAge)
				|| $0.occurredAt > now.addingTimeInterval(Self.maxFuture) || $0.actorId != actorId
				|| workspaceSharing[$0.workspaceId] == false
		}
		if queue.count != before { persistQueue() }
	}

	var queuedEvents: [AnalyticsEvent] { queue }

	private func persistQueue() {
		guard !queue.isEmpty else {
			storage.set(nil, for: Self.queueKey)
			return
		}
		let encoder = JSONEncoder()
		encoder.dateEncodingStrategy = .iso8601
		storage.set((try? encoder.encode(queue)).flatMap { String(data: $0, encoding: .utf8) }, for: Self.queueKey)
	}

	private static func readQueue(_ storage: any AnalyticsStorage) -> [AnalyticsEvent] {
		guard let text = storage.value(for: queueKey), let data = text.data(using: .utf8) else { return [] }
		let decoder = JSONDecoder()
		decoder.dateDecodingStrategy = .iso8601
		return (try? decoder.decode([AnalyticsEvent].self, from: data)) ?? []
	}

	static func utcDay(_ date: Date) -> String {
		let formatter = ISO8601DateFormatter()
		formatter.formatOptions = [.withFullDate]
		formatter.timeZone = TimeZone(identifier: "UTC")
		return formatter.string(from: date)
	}

	/// The web's `deriveEntryAgentRole`: "Chief of Staff" becomes "chief-of-staff".
	static func agentRole(_ name: String?) -> String? {
		guard let name else { return nil }
		var out = ""
		var pendingSeparator = false
		for scalar in name.lowercased().unicodeScalars {
			if (scalar >= "a" && scalar <= "z") || (scalar >= "0" && scalar <= "9") {
				if pendingSeparator, !out.isEmpty { out.append("-") }
				pendingSeparator = false
				out.unicodeScalars.append(scalar)
			} else {
				pendingSeparator = true
			}
		}
		return out.isEmpty ? nil : out
	}

	/// Web-style stable id for a choice label: "7-day window" becomes "7_day_window".
	public static func slug(_ label: String) -> String {
		let lowered = label.lowercased()
		var out = ""
		var pendingSeparator = false
		for scalar in lowered.unicodeScalars {
			if (scalar >= "a" && scalar <= "z") || (scalar >= "0" && scalar <= "9") {
				if pendingSeparator, !out.isEmpty { out.append("_") }
				pendingSeparator = false
				out.unicodeScalars.append(scalar)
			} else {
				pendingSeparator = true
			}
		}
		return String(out.prefix(40)).isEmpty ? "option" : String(out.prefix(40))
	}
}
