import MaskinCore
import SwiftUI
import UserNotifications

#if os(iOS)
	import UIKit
#elseif os(macOS)
	import AppKit
#endif

/// Bridges the OS push callbacks into `PushRegistrar` and `DeepLinkRouter`.
///
/// Wire it from `MaskinApp`:
///
///     #if os(iOS)
///     @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
///     #else
///     @NSApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
///     #endif
///     ...
///     .task { pushDelegate.attach(registrar: registrar, router: router) }
///
/// The delegate can receive a token or a tap before the SwiftUI scene has built the registrar
/// and router, so both are held until `attach` and anything that arrived early is replayed.
@MainActor
final class PushAppDelegate: NSObject, ObservableObject {
	private var registrar: PushRegistrar?
	private var router: DeepLinkRouter?
	private var earlyToken: Data?
	private var earlyFailure: (any Error)?
	private var earlyLinks: [URL] = []

	func attach(registrar: PushRegistrar, router: DeepLinkRouter) {
		self.registrar = registrar
		self.router = router
		if let token = earlyToken {
			earlyToken = nil
			Task { await registrar.didReceive(deviceToken: token) }
		}
		if let failure = earlyFailure {
			earlyFailure = nil
			registrar.didFailToRegister(failure)
		}
		for url in earlyLinks { router.open(url) }
		earlyLinks = []
	}

	fileprivate func receive(deviceToken: Data) {
		if let registrar {
			Task { await registrar.didReceive(deviceToken: deviceToken) }
		} else {
			earlyToken = deviceToken
		}
	}

	fileprivate func receive(registrationFailure error: any Error) {
		if let registrar { registrar.didFailToRegister(error) } else { earlyFailure = error }
	}

	/// A tap on a delivered notification. The payload's `deep_link` is parsed (and validated) by
	/// `DeepLink`, never trusted as a raw URL.
	fileprivate func receiveTap(deepLink raw: String?) {
		guard let raw, let url = URL(string: raw) else { return }
		if let router { router.open(url) } else { earlyLinks.append(url) }
	}
}

// MARK: - UserNotifications

extension PushAppDelegate: UNUserNotificationCenterDelegate {
	/// Foreground delivery: show the banner and play the sound; the in-app inbox updates over SSE.
	nonisolated func userNotificationCenter(
		_ center: UNUserNotificationCenter, willPresent notification: UNNotification
	) async -> UNNotificationPresentationOptions {
		[.banner, .list, .sound, .badge]
	}

	nonisolated func userNotificationCenter(
		_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse
	) async {
		// `userInfo` isn't Sendable; carry only the one string across the actor hop.
		let link = response.notification.request.content.userInfo["deep_link"] as? String
		await MainActor.run { receiveTap(deepLink: link) }
	}
}

// MARK: - Platform hooks

#if os(iOS)
	extension PushAppDelegate: UIApplicationDelegate {
		func application(
			_ application: UIApplication,
			didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
		) -> Bool {
			UNUserNotificationCenter.current().delegate = self
			return true
		}

		func application(
			_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
		) {
			receive(deviceToken: deviceToken)
		}

		func application(
			_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error
		) {
			receive(registrationFailure: error)
		}
	}
#elseif os(macOS)
	extension PushAppDelegate: NSApplicationDelegate {
		func applicationDidFinishLaunching(_ notification: Notification) {
			UNUserNotificationCenter.current().delegate = self
		}

		func application(
			_ application: NSApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
		) {
			receive(deviceToken: deviceToken)
		}

		func application(
			_ application: NSApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error
		) {
			receive(registrationFailure: error)
		}
	}
#endif

// MARK: - OS side of PushRegistrar

/// `PushSystem` over `UNUserNotificationCenter` and the platform application object.
struct SystemPushSystem: PushSystem {
	func currentPermission() async -> PushPermission {
		let settings = await UNUserNotificationCenter.current().notificationSettings()
		switch settings.authorizationStatus {
		case .notDetermined: return .notDetermined
		case .denied: return .denied
		default: return .authorized
		}
	}

	func requestPermission() async -> Bool {
		(try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]))
			?? false
	}

	@MainActor func registerForRemoteNotifications() {
		#if os(iOS)
			UIApplication.shared.registerForRemoteNotifications()
		#elseif os(macOS)
			NSApplication.shared.registerForRemoteNotifications()
		#endif
	}

	@MainActor func setBadge(_ count: Int) {
		UNUserNotificationCenter.current().setBadgeCount(count) { _ in }
	}
}
