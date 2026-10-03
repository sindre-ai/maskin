import MaskinCore
import UserNotifications

#if os(iOS)
	import UIKit
#endif

/// Carries out a tap on one of a decision notification's action buttons, then updates what the
/// user sees. The write itself is `NotificationActionHandler` (UI-free, unit-tested); this file
/// is only the UserNotifications side: registering the fallback category, re-posting the
/// notification as a confirmation or an error, and the haptic.
///
/// There is NO undo window here, unlike the For You card: a button on a notification is an
/// explicit tap and the user may not have the app on screen to cancel from, so it sends at once.
///
/// iOS removes a notification the moment one of its actions is chosen, so "keep the notification
/// on failure" means posting it again (same identifier, same category, so its buttons are still
/// there for a retry) with the reason added.
struct NotificationActionRunner: Sendable {
	/// What a tap resolved to, for the delegate.
	enum Resolution: Sendable {
		/// Not ours (default tap, dismiss, an unknown action): the delegate's usual handling.
		case notHandled
		/// The "Open" button: the delegate opens the deep link.
		case open
		case handled
	}

	private let handler: NotificationActionHandler

	init(handler: NotificationActionHandler) { self.handler = handler }

	static func production() -> NotificationActionRunner {
		let raw = Bundle.main.object(forInfoDictionaryKey: "MaskinAPIBaseURL") as? String
		let baseURL = raw.flatMap(URL.init(string:)) ?? URL(string: "https://maskin.io")!
		#if os(macOS)
			let source = "macos"
		#else
			let source = "ios"
		#endif
		return NotificationActionRunner(
			handler: .production(
				baseURL: baseURL, clientSource: source, secrets: KeychainSecretStore()))
	}

	func run(_ response: UNNotificationResponse) async -> Resolution {
		let request = response.notification.request
		guard let payload = PushDecisionPayload(userInfo: request.content.userInfo),
			let kind = NotificationActionPlan.choice(for: response.actionIdentifier, in: payload)
		else { return .notHandled }
		if case .open = kind { return .open }

		let text = (response as? UNTextInputNotificationResponse)?.userText
		let outcome = await handler.perform(kind, userText: text, payload: payload)
		await present(outcome, original: request)
		return .handled
	}

	private func present(_ outcome: NotificationActionOutcome, original: UNNotificationRequest) async {
		let center = UNUserNotificationCenter.current()
		let content = UNMutableNotificationContent()
		content.title = original.content.title
		content.threadIdentifier = original.content.threadIdentifier
		content.userInfo = original.content.userInfo
		// A confirmation is information, not an interruption: no sound, never lights the screen.
		content.interruptionLevel = .passive
		var success = true
		switch outcome {
		case .answered(let text):
			content.body = "You chose \u{201C}\(Self.excerpt(text))\u{201D}"
		case .queued(let text):
			content.body =
				"Saved \u{201C}\(Self.excerpt(text))\u{201D}. It sends when you're back online."
		case .failed(let message):
			success = false
			// Same body, same buttons, plus the reason: the user can simply tap again.
			content.body = "Couldn't send. \(message)"
			content.categoryIdentifier = original.content.categoryIdentifier
			content.interruptionLevel = .active
		case .notSignedIn:
			success = false
			content.body = "Open Maskin and sign in to answer from notifications."
		}
		// Same identifier replaces the delivered notification instead of stacking a second one.
		let replacement = UNNotificationRequest(identifier: original.identifier, content: content, trigger: nil)
		center.removeDeliveredNotifications(withIdentifiers: [original.identifier])
		try? await center.add(replacement)
		await Self.haptic(success: success)
	}

	/// Only perceptible when the app is on screen; from the lock screen iOS has already played
	/// its own tap feedback and a background process may not drive the Taptic Engine.
	@MainActor private static func haptic(success: Bool) {
		#if os(iOS)
			guard UIApplication.shared.applicationState == .active else { return }
			UINotificationFeedbackGenerator().notificationOccurred(success ? .success : .error)
		#endif
	}

	private static func excerpt(_ text: String) -> String {
		let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? text
		return line.count > 60 ? String(line.prefix(60)) + "\u{2026}" : line
	}

	/// The fixed category every decision push names in `aps.category`. If the service extension
	/// could not swap in the per-notification one (it was killed, or it is a Mac), the user still
	/// gets a Reply field. It is MERGED into the registered set because
	/// `setNotificationCategories` replaces everything, including the extension's dynamic ones.
	static func registerFallbackCategory() {
		let center = UNUserNotificationCenter.current()
		let reply = UNTextInputNotificationAction(
			identifier: NotificationActionPlan.replyIdentifier, title: "Reply", options: [],
			textInputButtonTitle: "Send", textInputPlaceholder: "Reply")
		let open = UNNotificationAction(
			identifier: NotificationActionPlan.openIdentifier, title: "Open", options: [.foreground])
		let fallback = UNNotificationCategory(
			identifier: PushDecisionPayload.category, actions: [reply, open], intentIdentifiers: [],
			options: [])
		center.getNotificationCategories { existing in
			var merged = existing
			merged.remove(fallback)
			merged.insert(fallback)
			center.setNotificationCategories(merged)
		}
	}
}
