import Foundation

// STANDALONE: Foundation + UserNotifications only. Compiled directly into the notification
// service extension (project.yml) AND into MaskinCore, so the extension and the app build the
// same categories and merge them the same way, and one set of tests covers both.

/// Which registered categories survive a write. `setNotificationCategories` REPLACES the whole
/// set, so every writer (the extension per push, the app at launch) merges instead.
public enum PushCategoryMerge {
	/// Keep every fixed category; keep a per-notification (`decision.<id>`) one only while its
	/// notification is still on screen, because an old one's buttons are useless once it is gone.
	public static func keeps(identifier: String, live: Set<String>) -> Bool {
		!identifier.hasPrefix(PushDecisionPayload.categoryPrefix) || live.contains(identifier)
	}
}

#if canImport(UserNotifications) && !os(tvOS) && !os(watchOS)
	import UserNotifications

	public enum PushCategories {
		/// The existing set, pruned of dead dynamic categories, plus `adding` (replacing a category
		/// with the same identifier) and, when `ensuringFallback`, the fixed fallback.
		public static func merged(
			existing: Set<UNNotificationCategory>, live: Set<String>,
			adding: UNNotificationCategory, ensuringFallback: Bool = true
		) -> Set<UNNotificationCategory> {
			// Matched by identifier, not by `Set` equality: a category rebuilt with the same
			// identifier is not `==` to the registered one, so `remove(adding)` would leave both.
			var merged = existing.filter {
				$0.identifier != adding.identifier
					&& PushCategoryMerge.keeps(identifier: $0.identifier, live: live)
			}
			if ensuringFallback, !merged.contains(where: { $0.identifier == PushDecisionPayload.category }) {
				merged.insert(fallback())
			}
			merged.insert(adding)
			return merged
		}

		/// The fixed category every decision push names in `aps.category`. If the service extension
		/// could not swap in the per-notification one (it was killed, or it is a Mac), the user
		/// still gets a Reply field. The extension also makes sure it exists, so it is there even
		/// before the app has ever launched.
		public static func fallback() -> UNNotificationCategory {
			let reply = UNTextInputNotificationAction(
				identifier: NotificationActionPlan.replyIdentifier, title: "Reply", options: [],
				textInputButtonTitle: "Send", textInputPlaceholder: "Reply")
			let open = UNNotificationAction(
				identifier: NotificationActionPlan.openIdentifier, title: "Open", options: [.foreground])
			return UNNotificationCategory(
				identifier: PushDecisionPayload.category, actions: [reply, open], intentIdentifiers: [],
				options: [])
		}

		/// The buttons of one decision notification.
		public static func category(for plan: NotificationActionPlan) -> UNNotificationCategory {
			let actions: [UNNotificationAction] = plan.actions.map { action in
				var options: UNNotificationActionOptions = []
				if action.requiresAuthentication { options.insert(.authenticationRequired) }
				if action.isDestructive { options.insert(.destructive) }
				switch action.kind {
				case .option:
					return UNNotificationAction(
						identifier: action.identifier, title: action.title, options: options)
				case .later:
					// Runs in the background and sends nothing: it only hides the card until later.
					return UNNotificationAction(
						identifier: action.identifier, title: action.title, options: options,
						icon: UNNotificationActionIcon(systemImageName: "clock"))
				case .reply:
					return UNTextInputNotificationAction(
						identifier: action.identifier, title: action.title, options: options,
						icon: UNNotificationActionIcon(systemImageName: "arrowshape.turn.up.left"),
						textInputButtonTitle: "Send", textInputPlaceholder: "Reply")
				case .open:
					// Opens the app: Open, and a "Review" button for an option that needs a
					// confirmation. Plain options, Later and Reply run in the background.
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
#endif
