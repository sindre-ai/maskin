#if os(iOS)
	import MaskinCore
	import Observation
	import SwiftUI
	import UIKit

	/// A SwiftUI overlay cannot cover a presented sheet, and the app has sheets everywhere, so on iOS
	/// the lock screen also lives in its own window above the app's. Shown whenever the controller
	/// says to cover content; hidden otherwise (a hidden window takes no touches).
	@MainActor
	final class AppLockWindowPresenter {
		private let lock: AppLockController
		private var windows: [ObjectIdentifier: UIWindow] = [:]
		private var started = false

		init(lock: AppLockController) { self.lock = lock }

		func start() {
			guard !started else { return }
			started = true
			track()
		}

		/// Re-arms itself: `withObservationTracking` fires once per change.
		private func track() {
			let covered = withObservationTracking {
				lock.shouldCoverContent
			} onChange: { [weak self] in
				Task { @MainActor in self?.track() }
			}
			apply(covered: covered)
		}

		private func apply(covered: Bool) {
			let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
			if covered {
				for scene in scenes where windows[ObjectIdentifier(scene)] == nil {
					let window = UIWindow(windowScene: scene)
					window.windowLevel = .alert + 1
					let host = UIHostingController(rootView: AppLockWindowContent(lock: lock))
					host.view.backgroundColor = .clear
					window.rootViewController = host
					windows[ObjectIdentifier(scene)] = window
				}
				for window in windows.values { window.isHidden = false }
			} else {
				for window in windows.values { window.isHidden = true }
			}
		}
	}

	private struct AppLockWindowContent: View {
		let lock: AppLockController

		var body: some View {
			AppLockView(
				isLocked: lock.isLocked, isAuthenticating: lock.isAuthenticating,
				lastAttemptFailed: lock.lastAttemptFailed,
				onUnlock: { Task { await lock.unlock() } })
		}
	}
#endif
