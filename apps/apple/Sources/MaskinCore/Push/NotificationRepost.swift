import Foundation

/// How a decision notification is posted again after one of its buttons ran. iOS removes a
/// notification the moment an action is chosen, so every outcome is a fresh post under the same
/// identifier. This is the policy (pure, so it is tested); `NotificationActionRunner` only turns
/// it into a `UNNotificationRequest`.
///
/// - A confirmation (answered, queued, deferred, signed out) is information, not an
///   interruption: passive, silent, and WITHOUT the decision's buttons, because answering the
///   same question twice must not be one tap away.
/// - A failure is the original ask again, so it keeps the original's buttons, sound and
///   interruption level (a Time Sensitive decision that failed must not come back quieter than it
///   was), with the reason added.
public struct NotificationRepost: Sendable, Equatable {
	public enum Level: Sendable, Equatable {
		case passive, active, timeSensitive
	}

	public var body: String
	/// `nil` = no buttons.
	public var categoryIdentifier: String?
	public var level: Level
	/// Reuse the original notification's sound.
	public var keepsSound: Bool
	/// Drives the haptic.
	public var success: Bool

	public init(
		outcome: NotificationActionOutcome, originalCategory: String, originalLevel: Level
	) {
		switch outcome {
		case .answered(let text):
			self.init(body: "You chose \u{201C}\(Self.excerpt(text))\u{201D}")
		case .deferred(let when):
			self.init(body: "Later \u{00B7} \(when). It comes back to For you then.")
		case .queued(let text):
			self.init(
				body: "Saved \u{201C}\(Self.excerpt(text))\u{201D}. It sends when you're back online.")
		case .failed(let message):
			self.init(
				body: "Couldn't send. \(message)", categoryIdentifier: originalCategory,
				level: originalLevel == .passive ? .active : originalLevel, keepsSound: true,
				success: false)
		case .notSignedIn:
			self.init(body: "Open Maskin and sign in to answer from notifications.", success: false)
		}
	}

	private init(
		body: String, categoryIdentifier: String? = nil, level: Level = .passive,
		keepsSound: Bool = false, success: Bool = true
	) {
		self.body = body
		self.categoryIdentifier = categoryIdentifier
		self.level = level
		self.keepsSound = keepsSound
		self.success = success
	}

	static func excerpt(_ text: String) -> String {
		let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
		return line.count > 60 ? String(line.prefix(60)) + "\u{2026}" : line
	}
}
