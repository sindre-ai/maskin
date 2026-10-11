import MaskinCore
import UserNotifications

/// Runs a decision notification's buttons on the watch itself. When the watch app is installed,
/// watchOS hands it the notification and the tapped action (an iPhone-mirrored alert only goes to
/// the phone when the watch app is absent), so without this the buttons would show and do nothing.
/// The write is the phone's own: `NotificationActionRunner` (compiled into this target) over the
/// UI-free `NotificationActionHandler`, with the session from the shared Keychain group.
// No stored state, so sharing one instance across threads is safe; `NSObject` just can't prove it.
final class WatchNotificationDelegate: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
	/// Alerts show while the app is open too; a decision should not wait for the wearer to leave it.
	func userNotificationCenter(
		_ center: UNUserNotificationCenter, willPresent notification: UNNotification
	) async -> UNNotificationPresentationOptions {
		WatchNotifications.register(for: notification.request.content.userInfo)
		return [.banner, .list, .sound]
	}

	func userNotificationCenter(
		_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
	) async {
		// `.open` and anything not ours need nothing here: the app is already coming forward.
		_ = await NotificationActionRunner.production().run(response)
	}
}

enum WatchNotifications {
	/// A decision alert on the wrist offers the recommended option first and Hold second (see
	/// `WatchNotificationPlan`), each keeping the phone's `maskin.option.<index>` identifier so the
	/// shared action runner resolves the same choice. Registered as the alert arrives; a category
	/// the phone's service extension already set for a background delivery is left to it.
	static func register(for userInfo: [AnyHashable: Any]) {
		guard let payload = PushDecisionPayload(userInfo: userInfo) else { return }
		let plan = WatchNotificationPlan(payload)
		let actions: [UNNotificationAction] = plan.actions.map { action in
			var options: UNNotificationActionOptions = []
			if action.requiresAuthentication { options.insert(.authenticationRequired) }
			return UNNotificationAction(identifier: action.identifier, title: action.title, options: options)
		}
		let category = UNNotificationCategory(
			identifier: plan.categoryIdentifier, actions: actions, intentIdentifiers: [], options: [])
		let center = UNUserNotificationCenter.current()
		center.getNotificationCategories { existing in
			var merged = existing
			merged.remove(category)
			merged.insert(category)
			center.setNotificationCategories(merged)
		}
	}

	/// Held for the life of the process: `UNUserNotificationCenter.delegate` is weak.
	private static let delegate = WatchNotificationDelegate()

	static func install() {
		UNUserNotificationCenter.current().delegate = delegate
		// The fixed category every decision push names, so Reply/Open exist even when the phone's
		// service extension could not swap in the per-notification buttons.
		NotificationActionRunner.registerFallbackCategory()
	}
}
