import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// App lock (1m): require Face ID (or Touch ID, or the device passcode) on launch and after the
/// app has been in the background for the chosen time. Lock now locks at once.
struct AppLockSettingsPage: View {
	let lock: AppLockController
	@State private var choosingDelay = false

	var body: some View {
		WorkspacePage(title: "App lock") {
			PageGroupLabel(text: lock.biometryName ?? "Passcode")
			PageCard(rows: [
				PageRowModel(
					id: "require", title: "Require \(lock.biometryName ?? "passcode")",
					subtitle: "On launch and after the app has been in the background",
					accessory: .toggle(isOn: lock.isEnabled) { on in Task { await lock.setEnabled(on) } }),
				PageRowModel(
					id: "after", title: "Lock after",
					accessory: .state(PageState(lock.delay.label, lock.isEnabled ? .plain : .muted)),
					showsChevron: true, action: lock.isEnabled ? { choosingDelay = true } : nil),
			])
			PageFootnote(text: SettingsScreen.appLockFooter(lock.availability, delay: lock.delay))
			Button("Lock now") { lock.lockNow() }
				.buttonStyle(.primaryAction)
				.disabled(!lock.isEnabled)
			if !lock.isEnabled {
				PageFootnote(text: "Turn on \(lock.biometryName ?? "the passcode lock") first.")
			}
		}
		.disabled(lock.isAuthenticating)
		.confirmationDialog("Lock after", isPresented: $choosingDelay, titleVisibility: .visible) {
			ForEach(AppLockDelay.allCases, id: \.self) { delay in
				Button(delay.label) { lock.setDelay(delay) }
			}
		}
	}
}
