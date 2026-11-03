import Foundation

/// The buttons a decision alert shows on the wrist: the recommended option first, Hold second, and
/// nothing else (a watch banner has room for two; the rest is a tap into the card). Each action
/// keeps the identifier of its option's index in the payload, so the phone's action runner
/// (`NotificationActionPlan.optionPrefix + index`) resolves the same choice either side.
public struct WatchNotificationPlan: Sendable, Equatable {
	public struct Action: Sendable, Equatable {
		public var identifier: String
		public var title: String
		public var isHold: Bool
		public var requiresAuthentication: Bool
	}

	public var categoryIdentifier: String
	public var actions: [Action]

	public init(_ payload: PushDecisionPayload) {
		categoryIdentifier = PushDecisionPayload.categoryPrefix + payload.notificationId
		let indexed = Array(payload.options.enumerated())
		let recommended = indexed.first(where: { $0.element.recommended }) ?? indexed.first
		let hold = indexed.first(where: {
			HoldReason.isHold($0.element.label) && $0.offset != recommended?.offset
		})
		let second = hold ?? indexed.first(where: { $0.offset != recommended?.offset })
		actions = [recommended, second].compactMap { pick in
			pick.map { index, option in
				Action(
					identifier: NotificationActionPlan.optionPrefix + String(index), title: option.label,
					isHold: HoldReason.isHold(option.label), requiresAuthentication: option.destructive)
			}
		}
	}
}
