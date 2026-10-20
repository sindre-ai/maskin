import Foundation

// STANDALONE: Foundation only, no other MaskinCore types. The notification service extension
// compiles this file directly (project.yml) so it stays small enough for an extension's memory
// limit instead of linking the whole package.
//
// The server contract (apps/dev/src/services/apns.ts, `PushDecision`): a decision-needed push
// carries `aps.category = "maskin.decision"` plus a root object
//
//     "decision": { "eventId": 42, "parentEventId": 7?, "objectId": "<uuid>",
//                   "options": [{ "label": "Ship it", "destructive": true? }, ...], "recommended": 0? }
//
// Labels arrive WHOLE (the server never truncates; it sends no actions for an over-long label),
// because the label is posted verbatim as the user's answer.
//
// next to `workspace_id`, `notification_id` and `deep_link`.

/// One tappable choice from the agent's decision block.
public struct PushDecisionOption: Sendable, Equatable {
	public var label: String
	public var recommended: Bool
	/// Irreversible choices ask for the device to be unlocked first (`destructive` on the decision
	/// option, forwarded by the server).
	public var destructive: Bool

	/// Hold is an option the agent authors like any other; it is recognised by its label.
	public var isHold: Bool { HoldOption.matches(label) }

	public init(label: String, recommended: Bool = false, destructive: Bool = false) {
		self.label = label
		self.recommended = recommended
		self.destructive = destructive
	}
}

/// Recognises the agent's "Hold" option by its label ("Hold", "Hold a week", "Hold for now").
public enum HoldOption {
	public static func matches(_ label: String) -> Bool {
		let first = label.trimmingCharacters(in: .whitespaces).lowercased().split(separator: " ").first
		return first == "hold" || first == "later" || first == "wait"
	}
}

/// What a push says about the decision it asks for. Plain values, parsed defensively: anything
/// missing or malformed makes the notification non-actionable rather than crashing a service
/// extension that has a few seconds and a few megabytes to live in.
public struct PushDecisionPayload: Sendable, Equatable {
	public static let category = "maskin.decision"
	/// Dynamic categories the extension registers are named `decision.<notificationId>`.
	public static let categoryPrefix = "decision."

	public var workspaceId: String
	public var notificationId: String
	/// The agent's decision comment: the reply threads under it and mark-read goes up to it.
	public var eventId: Int
	public var parentEventId: Int?
	public var objectId: String
	public var options: [PushDecisionOption]
	public var deepLink: String?

	public init(
		workspaceId: String, notificationId: String, eventId: Int, parentEventId: Int? = nil,
		objectId: String, options: [PushDecisionOption], deepLink: String? = nil
	) {
		self.workspaceId = workspaceId
		self.notificationId = notificationId
		self.eventId = eventId
		self.parentEventId = parentEventId
		self.objectId = objectId
		self.options = options
		self.deepLink = deepLink
	}

	/// `nil` unless the payload is an actionable decision (ids present, at least one option).
	public init?(userInfo: [AnyHashable: Any]) {
		guard let decision = userInfo["decision"] as? [String: Any],
			let workspaceId = userInfo["workspace_id"] as? String, !workspaceId.isEmpty,
			let notificationId = userInfo["notification_id"] as? String, !notificationId.isEmpty,
			let eventId = Self.int(decision["eventId"]), eventId > 0,
			let objectId = decision["objectId"] as? String, !objectId.isEmpty,
			let rawOptions = decision["options"] as? [[String: Any]]
		else { return nil }
		let recommended = Self.int(decision["recommended"])
		var options: [PushDecisionOption] = []
		for (index, raw) in rawOptions.enumerated() {
			guard let label = (raw["label"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
				!label.isEmpty
			else { continue }
			options.append(
				PushDecisionOption(
					label: label, recommended: recommended == index,
					destructive: raw["destructive"] as? Bool ?? false))
		}
		guard !options.isEmpty else { return nil }
		self.init(
			workspaceId: workspaceId, notificationId: notificationId, eventId: eventId,
			parentEventId: Self.int(decision["parentEventId"]).flatMap { $0 > 0 ? $0 : nil },
			objectId: objectId, options: options, deepLink: userInfo["deep_link"] as? String)
	}

	/// JSON numbers arrive as `NSNumber`; accept an integral double or a numeric string too.
	private static func int(_ value: Any?) -> Int? {
		switch value {
		case let n as Int: return n
		case let d as Double: return d.rounded() == d ? Int(d) : nil
		case let s as String: return Int(s)
		default: return nil
		}
	}
}

/// The buttons a decision notification shows, as plain values. The extension turns it into a
/// `UNNotificationCategory`; the app turns an action identifier back into what was chosen.
public struct NotificationActionPlan: Sendable, Equatable {
	public struct Action: Sendable, Equatable {
		public enum Kind: Sendable, Equatable {
			case option(label: String)
			case reply
			/// Defer the ask on this device ("Later"). Needs no network.
			case later
			case open
		}
		public var identifier: String
		public var title: String
		public var kind: Kind
		/// Needs the device unlocked first (irreversible choices).
		public var requiresAuthentication: Bool
		public var isDestructive: Bool
	}

	public static let replyIdentifier = "maskin.reply"
	public static let laterIdentifier = "maskin.later"
	public static let openIdentifier = "maskin.open"
	public static let optionPrefix = "maskin.option."
	/// iOS shows at most four actions on a banner.
	public static let maxActions = 4

	public var categoryIdentifier: String
	public var actions: [Action]

	/// The suggested option leads (and the agent's Hold follows it), then Later, then the
	/// free-text Reply: four buttons, the most iOS shows on a banner. An option that needs a
	/// confirmation (`destructive`) is never one tap on a lock screen: its button says "Review"
	/// and opens the card, where the confirmation lives. The notification body itself already
	/// opens the app, so there is no separate Open button.
	public init(_ payload: PushDecisionPayload) {
		categoryIdentifier = PushDecisionPayload.categoryPrefix + payload.notificationId
		var actions: [Action] = []
		// The identifier keeps the option's index in the PAYLOAD, not its place in the plan, so
		// `choice(for:in:)` is independent of ordering.
		for (index, option) in Self.display(payload.options).prefix(Self.maxActions - 2) {
			if option.destructive {
				actions.append(
					Action(
						identifier: Self.optionPrefix + String(index), title: "Review \u{201C}\(option.label)\u{201D}",
						kind: .open, requiresAuthentication: false, isDestructive: false))
			} else {
				actions.append(
					Action(
						identifier: Self.optionPrefix + String(index), title: option.label,
						kind: .option(label: option.label), requiresAuthentication: false,
						isDestructive: false))
			}
		}
		actions.append(
			Action(
				identifier: Self.laterIdentifier, title: "Later", kind: .later,
				requiresAuthentication: false, isDestructive: false))
		actions.append(
			Action(
				identifier: Self.replyIdentifier, title: "Reply", kind: .reply,
				requiresAuthentication: false, isDestructive: false))
		self.actions = actions
	}

	/// Options in the order a banner shows them: the lead (recommended, else the first that is not
	/// Hold), then Hold, then the rest as sent.
	/// Pairs each with its index in the payload.
	static func display(_ options: [PushDecisionOption]) -> [(Int, PushDecisionOption)] {
		let indexed = Array(options.enumerated())
		let lead = indexed.first { $0.element.recommended } ?? indexed.first { !$0.element.isHold }
		let hold = indexed.first { $0.element.isHold && $0.offset != lead?.offset }
		let rest = indexed.filter { $0.offset != lead?.offset && $0.offset != hold?.offset }
		return ([lead, hold].compactMap { $0 } + rest).map { ($0.offset, $0.element) }
	}

	/// What a tapped action identifier means for this payload. `nil` for the default tap,
	/// dismissal, or an identifier from a different/older plan.
	public static func choice(
		for actionIdentifier: String, in payload: PushDecisionPayload
	) -> Action.Kind? {
		let plan = NotificationActionPlan(payload)
		return plan.actions.first { $0.identifier == actionIdentifier }?.kind
	}
}
