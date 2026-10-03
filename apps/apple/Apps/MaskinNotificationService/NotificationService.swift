import UserNotifications

/// Turns a decision push into one the user can answer from the banner or lock screen.
///
/// iOS only lets an app register notification categories (the action button sets) AHEAD of time,
/// but a decision's buttons are the agent's own option labels and differ per notification. So the
/// server marks such pushes `mutable-content` with a compact `decision` object, and this extension
/// builds a category for THAT notification from its options, registers it, and points the
/// notification at it before iOS shows anything. The app handles the tap
/// (`PushAppDelegate`, which hands it to `NotificationActionHandler`).
///
/// Anything that is not an actionable decision passes through untouched, and every failure path
/// still delivers the original notification: this extension must never swallow a push.
///
/// `PushDecision.swift` is compiled into this target directly (project.yml), which keeps the
/// extension to Foundation + UserNotifications and well inside its memory limit.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
	private var contentHandler: ((UNNotificationContent) -> Void)?
	private var original: UNNotificationContent?

	override func didReceive(
		_ request: UNNotificationRequest,
		withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
	) {
		self.contentHandler = contentHandler
		original = request.content
		guard let content = request.content.mutableCopy() as? UNMutableNotificationContent,
			let payload = PushDecisionPayload(userInfo: content.userInfo)
		else {
			contentHandler(request.content)
			return
		}

		let plan = NotificationActionPlan(payload)
		let category = Self.category(for: plan)
		content.categoryIdentifier = plan.categoryIdentifier

		let center = UNUserNotificationCenter.current()
		center.getDeliveredNotifications { [weak self] delivered in
			center.getNotificationCategories { existing in
				// `setNotificationCategories` REPLACES the whole set, so merge: keep every fixed
				// category the app registered, and only the dynamic ones whose notification is
				// still on screen (an old one's buttons are useless once it is gone).
				let live = Set(delivered.map(\.request.content.categoryIdentifier))
				var merged = existing.filter {
					!$0.identifier.hasPrefix(PushDecisionPayload.categoryPrefix) || live.contains($0.identifier)
				}
				merged.remove(category)
				merged.insert(category)
				center.setNotificationCategories(merged)
				// Read the set back: that round trip is what guarantees the registration landed
				// before iOS renders the notification and looks its category up.
				center.getNotificationCategories { _ in
					self?.finish(content)
				}
			}
		}
	}

	/// About to be killed: deliver as it arrived, with the static fallback category from the
	/// payload's `aps.category` (a Reply field), rather than lose the notification.
	override func serviceExtensionTimeWillExpire() {
		if let original { finish(original) }
	}

	private func finish(_ content: UNNotificationContent) {
		contentHandler?(content)
		contentHandler = nil
	}

	static func category(for plan: NotificationActionPlan) -> UNNotificationCategory {
		let actions: [UNNotificationAction] = plan.actions.map { action in
			var options: UNNotificationActionOptions = []
			if action.requiresAuthentication { options.insert(.authenticationRequired) }
			if action.isDestructive { options.insert(.destructive) }
			switch action.kind {
			case .option:
				return UNNotificationAction(identifier: action.identifier, title: action.title, options: options)
			case .reply:
				return UNTextInputNotificationAction(
					identifier: action.identifier, title: action.title, options: options,
					icon: UNNotificationActionIcon(systemImageName: "arrowshape.turn.up.left"),
					textInputButtonTitle: "Send", textInputPlaceholder: "Reply")
			case .open:
				// The only action that opens the app; options and Reply run in the background.
				options.insert(.foreground)
				return UNNotificationAction(
					identifier: action.identifier, title: action.title, options: options,
					icon: UNNotificationActionIcon(systemImageName: "arrow.up.forward.app"))
			}
		}
		return UNNotificationCategory(
			identifier: plan.categoryIdentifier, actions: actions, intentIdentifiers: [],
			hiddenPreviewsBodyPlaceholder: "Maskin needs a decision", options: [])
	}
}
