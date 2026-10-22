import Foundation

/// The signed-in actor's push preferences (`/api/notification-preferences`). Per actor, not per
/// workspace. The wire shape stays inside `APINotificationPreferencesSource`.
public struct NotificationPreferences: Equatable, Sendable {
	public struct Categories: Equatable, Sendable {
		/// Decisions and questions. Delivered even in quiet hours.
		public var needsYou: Bool
		/// Chat replies.
		public var conversation: Bool
		/// The daily briefing and other digests.
		public var digest: Bool
		/// Tips and product updates.
		public var tips: Bool

		public init(needsYou: Bool = true, conversation: Bool = true, digest: Bool = true, tips: Bool = true) {
			self.needsYou = needsYou
			self.conversation = conversation
			self.digest = digest
			self.tips = tips
		}
	}

	/// Minutes from local midnight. `start > end` wraps past midnight (22:00 to 07:00).
	public struct QuietHours: Equatable, Sendable {
		public var start: Int
		public var end: Int
		public init(start: Int, end: Int) {
			self.start = start
			self.end = end
		}
		/// The first time quiet hours are switched on: a night.
		public static let evening = QuietHours(start: 22 * 60, end: 7 * 60)
	}

	/// IANA name; nil means the server has never been told (it then uses UTC).
	public var timezone: String?
	public var quietHours: QuietHours?
	public var categories: Categories
	public var briefingEnabled: Bool
	/// Minutes from local midnight.
	public var briefingTime: Int
	public var mutedWorkspaceIds: [String]

	public init(
		timezone: String? = nil, quietHours: QuietHours? = nil, categories: Categories = .init(),
		briefingEnabled: Bool = true, briefingTime: Int = NotificationPreferences.defaultBriefingTime,
		mutedWorkspaceIds: [String] = []
	) {
		self.timezone = timezone
		self.quietHours = quietHours
		self.categories = categories
		self.briefingEnabled = briefingEnabled
		self.briefingTime = briefingTime
		self.mutedWorkspaceIds = mutedWorkspaceIds
	}

	/// The server's default when nothing was ever saved: 08:30.
	public static let defaultBriefingTime = 510
	public static let minutesPerDay = 1440

	/// Clamp to a valid minute of the day.
	static func clamp(minutes: Int) -> Int { min(max(minutes, 0), minutesPerDay - 1) }
}

/// One field of a patch: leave alone, set, or (for the nullable fields) clear.
public enum PreferenceChange<Value: Equatable & Sendable>: Equatable, Sendable {
	case keep
	case set(Value)
	case clear
}

/// A partial update. Omitted fields keep the server's value, which is what lets two devices change
/// different settings without overwriting each other.
public struct NotificationPreferencesPatch: Equatable, Sendable {
	public var timezone: PreferenceChange<String> = .keep
	public var quietHours: PreferenceChange<NotificationPreferences.QuietHours> = .keep
	public var needsYou: Bool?
	public var conversation: Bool?
	public var digest: Bool?
	public var tips: Bool?
	public var briefingEnabled: Bool?
	public var briefingTime: Int?
	public var mutedWorkspaceIds: [String]?

	public init() {}

	public var isEmpty: Bool { self == NotificationPreferencesPatch() }

	/// What the preferences look like with this patch applied (the optimistic view).
	public func applied(to base: NotificationPreferences) -> NotificationPreferences {
		var next = base
		switch timezone {
		case .keep: break
		case .set(let zone): next.timezone = zone
		case .clear: next.timezone = nil
		}
		switch quietHours {
		case .keep: break
		case .set(let hours): next.quietHours = hours
		case .clear: next.quietHours = nil
		}
		if let needsYou { next.categories.needsYou = needsYou }
		if let conversation { next.categories.conversation = conversation }
		if let digest { next.categories.digest = digest }
		if let tips { next.categories.tips = tips }
		if let briefingEnabled { next.briefingEnabled = briefingEnabled }
		if let briefingTime { next.briefingTime = briefingTime }
		if let mutedWorkspaceIds { next.mutedWorkspaceIds = mutedWorkspaceIds }
		return next
	}

	/// The `PUT` body. Hand-encoded because the generated payload cannot send an explicit `null`,
	/// and `null` is how the server is told to clear the timezone or quiet hours.
	public func jsonBody() throws -> Data {
		try JSONEncoder().encode(Wire(patch: self))
	}

	private struct Wire: Encodable {
		let patch: NotificationPreferencesPatch

		enum Key: String, CodingKey {
			case timezone, quietStart = "quiet_hours_start", quietEnd = "quiet_hours_end"
			case categories, briefingEnabled = "briefing_enabled", briefingTime = "briefing_time"
			case muted = "muted_workspace_ids"
		}
		enum CategoryKey: String, CodingKey { case needsYou = "needs_you", conversation, digest, tips }

		func encode(to encoder: any Encoder) throws {
			var c = encoder.container(keyedBy: Key.self)
			switch patch.timezone {
			case .keep: break
			case .set(let zone): try c.encode(zone, forKey: .timezone)
			case .clear: try c.encodeNil(forKey: .timezone)
			}
			// The bounds travel together: both numbers or both null.
			switch patch.quietHours {
			case .keep: break
			case .set(let hours):
				try c.encode(NotificationPreferences.clamp(minutes: hours.start), forKey: .quietStart)
				try c.encode(NotificationPreferences.clamp(minutes: hours.end), forKey: .quietEnd)
			case .clear:
				try c.encodeNil(forKey: .quietStart)
				try c.encodeNil(forKey: .quietEnd)
			}
			if patch.needsYou != nil || patch.conversation != nil || patch.digest != nil || patch.tips != nil {
				var cat = c.nestedContainer(keyedBy: CategoryKey.self, forKey: .categories)
				try cat.encodeIfPresent(patch.needsYou, forKey: .needsYou)
				try cat.encodeIfPresent(patch.conversation, forKey: .conversation)
				try cat.encodeIfPresent(patch.digest, forKey: .digest)
				try cat.encodeIfPresent(patch.tips, forKey: .tips)
			}
			try c.encodeIfPresent(patch.briefingEnabled, forKey: .briefingEnabled)
			try c.encodeIfPresent(patch.briefingTime.map(NotificationPreferences.clamp(minutes:)), forKey: .briefingTime)
			try c.encodeIfPresent(patch.mutedWorkspaceIds, forKey: .muted)
		}
	}
}

/// `GET` and `PUT /api/notification-preferences`. A protocol so the store tests without a server.
public protocol NotificationPreferencesAPI: Sendable {
	func load() async throws -> NotificationPreferences
	/// Returns the server's preferences after the update.
	func save(_ patch: NotificationPreferencesPatch, idempotencyKey: String) async throws
		-> NotificationPreferences
}

/// Minutes from local midnight, to and from the `Date` a time picker wants.
public enum MinuteOfDay {
	public static func date(minutes: Int, calendar: Calendar = .current, on day: Date = Date()) -> Date {
		let clamped = NotificationPreferences.clamp(minutes: minutes)
		return calendar.date(bySettingHour: clamped / 60, minute: clamped % 60, second: 0, of: day) ?? day
	}

	public static func minutes(from date: Date, calendar: Calendar = .current) -> Int {
		let parts = calendar.dateComponents([.hour, .minute], from: date)
		return NotificationPreferences.clamp(minutes: (parts.hour ?? 0) * 60 + (parts.minute ?? 0))
	}
}
