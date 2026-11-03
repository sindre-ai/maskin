import Testing

@testable import MaskinFeatures

struct AppLockViewTests {
	@Test func subtitleNamesTheBiometryAndTheWorkspace() {
		#expect(AppLockView.subtitle("Face ID", "Værksted") == "Use Face ID to open Værksted.")
	}

	@Test func subtitleFallsBackToMaskinWithoutAWorkspace() {
		#expect(AppLockView.subtitle("Touch ID", nil) == "Use Touch ID to open Maskin.")
		#expect(AppLockView.subtitle("Touch ID", "  ") == "Use Touch ID to open Maskin.")
	}

	@Test func subtitleAsksForThePasscodeWithoutBiometry() {
		#expect(AppLockView.subtitle(nil, "Værksted") == "Enter your passcode to open Værksted.")
	}
}
