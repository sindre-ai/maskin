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

	public var anyValue: Any {
		switch self {
		case .string(let value): value
		case .int(let value): value
		case .bool(let value): value
		}
	}
}

public typealias AnalyticsProperties = [String: AnalyticsValue]

/// Whether the person has agreed to share product usage from this phone. Nothing is sent while it
/// is `undecided` or `denied`.
public enum AnalyticsConsent: String, Sendable, Equatable {
	case undecided, granted, denied
}

/// Where the analytics tool lives. The real one wraps the PostHog SDK (`PostHogSink` in
/// MaskinFeatures); tests record calls instead. `Analytics` only calls a sink once the person has
/// agreed, and calls `stop()` when they take it back.
@MainActor
public protocol AnalyticsSink: AnyObject {
	/// Starts the SDK. Called after consent, and again on later launches. Safe to repeat.
	func start()
	func identify(_ distinctId: String)
	func group(type: String, key: String)
	func capture(_ event: String, properties: AnalyticsProperties)
	/// Forgets the identified person (sign-out).
	func reset()
	/// Consent taken back: stop sending and forget the person.
	func stop()
}

/// Small key-value store for the consent answer and the once-only events.
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
/// The rules this type enforces, so call sites cannot get them wrong:
/// - Nothing reaches the sink until the person has agreed (`consent == .granted`).
/// - The person is identified by the stable actor id only. No name, no email.
/// - Every event carries `workspace_id`, `actor_id`, `actor_type` and `surface` (`iphone`), plus
///   `feature_area` when the event has one.
/// - Property keys that usually hold names or text are dropped. Callers pass ids and short labels.
///
/// `shared` is inert until `configure(sink:)` runs, which only happens when the build has a
/// PostHog project token. Without one every call is a no-op.
@MainActor
@Observable
public final class Analytics {
	public static let shared = Analytics()

	public private(set) var consent: AnalyticsConsent = .undecided

	@ObservationIgnored private var sink: (any AnalyticsSink)?
	@ObservationIgnored private var storage: any AnalyticsStorage = InMemoryAnalyticsStorage()
	@ObservationIgnored private var clock: @Sendable () -> Date = { Date() }
	@ObservationIgnored private var actorId: String?
	@ObservationIgnored private var workspaceId: String?
	@ObservationIgnored private var identifiedActorId: String?
	@ObservationIgnored private var groupedWorkspaceId: String?
	/// The app came to the front while consent was given but nobody was signed in yet (a cold start
	/// restores the session a moment later). The `app_opened` is sent once the person is known.
	@ObservationIgnored private var openWaitingForSignIn = false
	/// Cards already counted as shown since launch, like the web's per-page-load record.
	@ObservationIgnored private var impressedCards: Set<String> = []

	static let consentKey = "analytics.consent.v1"
	static let installedKey = "analytics.sent.app_installed.v1"
	static let activeDayKey = "analytics.sent.app_active_day.v1"
	static func firstSignInKey(_ actorId: String) -> String { "analytics.sent.first_sign_in.v1.\(actorId)" }

	/// Keys that usually hold a person's words or identity. Dropped from every event.
	static let blockedKeys: Set<String> = [
		"name", "email", "title", "text", "content", "message", "body", "summary", "description",
		"subject", "query", "label", "note", "phone",
	]

	public init() {}

	/// Wires the tool in. A nil sink (no project token in this build) keeps everything inert.
	public func configure(
		sink: (any AnalyticsSink)?, storage: any AnalyticsStorage = UserDefaultsAnalyticsStorage(),
		clock: @escaping @Sendable () -> Date = { Date() }
	) {
		self.sink = sink
		self.storage = storage
		self.clock = clock
		consent = storage.value(for: Self.consentKey).flatMap(AnalyticsConsent.init(rawValue:)) ?? .undecided
		if isActive { sink?.start() }
		syncIdentity()
	}

	/// True when this build can send at all (it has a project token).
	public var isAvailable: Bool { sink != nil }

	/// True when the person has agreed and the build can send.
	public var isActive: Bool { sink != nil && consent == .granted }

	/// The one-time question is owed: the build can send, the person is signed in, and they have
	/// not answered yet.
	public var needsConsentPrompt: Bool { isAvailable && consent == .undecided && actorId != nil }

	public func setConsent(_ granted: Bool) {
		storage.set(granted ? AnalyticsConsent.granted.rawValue : AnalyticsConsent.denied.rawValue, for: Self.consentKey)
		consent = granted ? .granted : .denied
		guard let sink else { return }
		if granted {
			sink.start()
			syncIdentity()
			appOpened()
		} else {
			sink.stop()
			identifiedActorId = nil
			groupedWorkspaceId = nil
		}
	}

	/// Called whenever the signed-in actor or workspace changes (nil actor = signed out).
	public func sessionChanged(actorId: String?, workspaceId: String?) {
		let signedOut = actorId == nil && self.actorId != nil
		self.actorId = actorId
		self.workspaceId = workspaceId
		if signedOut, isActive {
			sink?.reset()
			identifiedActorId = nil
			groupedWorkspaceId = nil
		}
		syncIdentity()
	}

	/// Identifies the person, joins the workspace group and sends the once-only events that were
	/// waiting for consent or for a sign-in.
	private func syncIdentity() {
		guard isActive, let sink, let actorId else { return }
		if identifiedActorId != actorId {
			sink.identify(actorId)
			identifiedActorId = actorId
			groupedWorkspaceId = nil
		}
		if let workspaceId, groupedWorkspaceId != workspaceId {
			sink.group(type: "workspace", key: workspaceId)
			groupedWorkspaceId = workspaceId
		}
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
		// No actor yet: nothing goes out and the day must not be marked as sent. Remember the open
		// so it goes out as soon as the session is restored.
		guard actorId != nil else {
			openWaitingForSignIn = true
			return
		}
		track("app_opened")
		let day = Self.utcDay(clock())
		if storage.value(for: Self.activeDayKey) != day {
			storage.set(day, for: Self.activeDayKey)
			track("app_active", ["utc_day": .string(day)])
		}
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

	/// Sends one event if the person has agreed and is signed in.
	public func track(_ event: String, _ properties: AnalyticsProperties = [:]) {
		guard isActive, let sink, let actorId else { return }
		sink.capture(event, properties: Self.compose(
			event: event, properties: properties, actorId: actorId, workspaceId: workspaceId))
	}

	/// The properties an event leaves with: caller values minus blocked keys, then the shared ones.
	static func compose(
		event: String, properties: AnalyticsProperties, actorId: String, workspaceId: String?
	) -> AnalyticsProperties {
		var result: AnalyticsProperties = [:]
		if let area = AnalyticsFeatureArea.forEvent(event) { result["feature_area"] = .string(area.rawValue) }
		for (key, value) in properties where !blockedKeys.contains(key.lowercased()) {
			result[key] = value
		}
		if let workspaceId { result["workspace_id"] = .string(workspaceId) }
		result["actor_id"] = .string(actorId)
		result["actor_type"] = "human"
		result["surface"] = "iphone"
		return result
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
