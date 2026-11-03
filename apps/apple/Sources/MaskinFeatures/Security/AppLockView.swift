import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Covers the app while it is locked, and while the system may snapshot it for the app switcher.
/// Opaque: nothing underneath shows through. Plain values in, closures out.
struct AppLockView: View {
	/// Locked shows the unlock button; otherwise this is only the privacy shield.
	var isLocked: Bool
	var isAuthenticating: Bool
	var lastAttemptFailed: Bool
	/// "Face ID", "Touch ID" or "Optic ID"; nil when the device only has a passcode.
	var biometryName: String?
	/// The workspace the app opens into, named in the sentence under the title. Nil leaves it out.
	var workspaceName: String?
	var onUnlock: () -> Void

	/// "Use Face ID to open Værksted." With no biometry it asks for the passcode; with no workspace
	/// name it opens "Maskin".
	static func subtitle(_ biometry: String?, _ workspace: String?) -> String {
		let name = workspace?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
		let target = name.isEmpty ? "Maskin" : name
		return biometry.map { "Use \($0) to open \(target)." } ?? "Enter your passcode to open \(target)."
	}

	var body: some View {
		VStack(spacing: MaskinSpace.s9) {
			BrandMark(size: 56)
			if isLocked {
				Text("Maskin is locked")
					.maskinText(.largeTitle)
					.foregroundStyle(MaskinColor.ink)
					.accessibilityAddTraits(.isHeader)
				Text(lastAttemptFailed ? "Couldn't unlock. Try again." : Self.subtitle(biometryName, workspaceName))
					.maskinText(.body)
					.foregroundStyle(MaskinColor.ink4)
					.multilineTextAlignment(.center)
				Button(biometryName.map { "Unlock with \($0)" } ?? "Unlock with passcode", action: onUnlock)
					.buttonStyle(PrimaryActionButtonStyle())
					.disabled(isAuthenticating)
					.frame(maxWidth: 280)
			}
		}
		.padding(.horizontal, MaskinSpace.s12)
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.background(MaskinColor.surface)
		// Take over the screen for assistive tech too: the content below is not reachable.
		.accessibilityElement(children: .contain)
	}
}

extension View {
	/// Hides this view behind the lock screen whenever the controller says to. The content stays
	/// mounted (no state lost) but is hidden from rendering and VoiceOver.
	func appLockCover(_ lock: AppLockController?, workspaceName: String? = nil) -> some View {
		modifier(AppLockCover(lock: lock, workspaceName: workspaceName))
	}
}

private struct AppLockCover: ViewModifier {
	let lock: AppLockController?
	var workspaceName: String?
	@Environment(\.scenePhase) private var scenePhase

	func body(content: Content) -> some View {
		let covered = lock?.shouldCoverContent ?? false
		content
			.opacity(covered ? 0 : 1)
			.accessibilityHidden(covered)
			.overlay {
				if let lock, covered {
					AppLockView(
						isLocked: lock.isLocked, isAuthenticating: lock.isAuthenticating,
						lastAttemptFailed: lock.lastAttemptFailed,
						biometryName: lock.biometryName, workspaceName: workspaceName,
						onUnlock: { Task { await lock.unlock() } })
				}
			}
			.onChange(of: scenePhase, initial: true) { _, phase in
				switch phase {
				case .active: lock?.scenePhaseChanged(.active)
				case .inactive: lock?.scenePhaseChanged(.inactive)
				case .background: lock?.scenePhaseChanged(.background)
				@unknown default: break
				}
			}
			// Prompt as soon as the app is in front and locked; a cancel waits for the button.
			.task(id: (lock?.isLocked ?? false) && scenePhase == .active) {
				if lock?.isLocked == true, scenePhase == .active { await lock?.unlock() }
			}
	}
}
