#if os(iOS)
	import MaskinCore
	import UIKit

	/// Receives the tap on a home screen icon action (`UIApplicationShortcutItems` in `project.yml`).
	/// SwiftUI apps with a scene manifest get these on the scene, not on the app delegate, so
	/// `PushAppDelegate` names this class as the delegate of every scene it connects.
	///
	/// A tap that launches the app arrives in `connectionOptions`; a tap while the app is already
	/// running (open or in the background) arrives in `performActionFor`. The system never sends both
	/// for one tap. Either way the action goes to `HomeScreenQuickActionRelay`, which holds it until
	/// the app's runtime is ready.
	final class QuickActionSceneDelegate: NSObject, UIWindowSceneDelegate {
		func scene(
			_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions
		) {
			if let item = connectionOptions.shortcutItem { handle(item) }
		}

		func windowScene(
			_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
			completionHandler: @escaping (Bool) -> Void
		) {
			completionHandler(handle(shortcutItem))
		}

		@discardableResult
		private func handle(_ item: UIApplicationShortcutItem) -> Bool {
			guard let action = HomeScreenQuickAction(shortcutType: item.type) else { return false }
			Task { @MainActor in HomeScreenQuickActionRelay.perform(action) }
			return true
		}
	}
#endif
