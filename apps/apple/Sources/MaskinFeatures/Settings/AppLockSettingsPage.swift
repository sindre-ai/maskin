import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// App lock (1m): require Face ID (or Touch ID, or the device passcode) on launch and after the
/// app has been in the background. The delay is fixed (`AppLockController.gracePeriod`), so it is
/// shown, not chosen; a choice of delays and Lock now need the lock controller to offer them.
struct AppLockSettingsPage: View {
	let lock: AppLockController

	var body: some View {
		WorkspacePage(title: "App lock") {
			PageGroupLabel(text: lock.biometryName ?? "Passcode")
			PageCard(rows: [
				PageRowModel(
					id: "require", title: "Require \(lock.biometryName ?? "passcode")",
					subtitle: "On launch and after the app has been in the background",
					accessory: .toggle(isOn: lock.isEnabled) { on in Task { await lock.setEnabled(on) } }),
				PageRowModel(
					id: "after", title: "Lock after", accessory: .state(PageState(Self.graceText, .plain))),
			])
			PageFootnote(text: SettingsScreen.appLockFooter(lock.availability))
		}
		.disabled(lock.isAuthenticating)
	}

	static var graceText: String {
		let seconds = Int(AppLockController.gracePeriod)
		return seconds < 60 ? "\(seconds) seconds" : "\(seconds / 60) minutes"
	}
}
