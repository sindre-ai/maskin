import Foundation
import MaskinCore
import Observation

/// The "Choose a new password" sheet's state, separate from the view so every transition is
/// testable. Mirrors the web page (`apps/web/src/routes/reset-password.tsx`): the same 8 character
/// floor as sign-up, the same two checks before anything is sent, the same wording.
@MainActor
@Observable
final class ResetPasswordModel {
	enum Phase: Equatable {
		case editing
		case saving
		/// The password was changed; the sheet closes and the person signs in with it.
		case done
		case failed(String)
	}

	static let minPasswordLength = 8
	static let tooShortMessage = "Password must be at least \(minPasswordLength) characters"
	static let mismatchMessage = "Passwords do not match"
	static let doneMessage = "Password changed. Sign in with it."

	var password = "" {
		didSet { if password != oldValue { clearProblem() } }
	}
	var confirmation = "" {
		didSet { if confirmation != oldValue { clearProblem() } }
	}
	private(set) var phase: Phase = .editing
	private let token: String
	private let reset: @MainActor (String, String) async throws -> Void

	init(token: String, reset: @escaping @MainActor (String, String) async throws -> Void) {
		self.token = token
		self.reset = reset
	}

	var isSaving: Bool { phase == .saving }

	/// Counted in UTF-16 units, as the server's `min(8)` counts them (same as `SignUpForm`).
	var canSubmit: Bool { !password.isEmpty && !confirmation.isEmpty && phase != .saving && phase != .done }

	var problem: String? {
		if case .failed(let message) = phase { return message }
		return nil
	}

	func submit() async {
		guard phase != .saving, phase != .done else { return }
		guard password.utf16.count >= Self.minPasswordLength else {
			phase = .failed(Self.tooShortMessage)
			return
		}
		guard password == confirmation else {
			phase = .failed(Self.mismatchMessage)
			return
		}
		phase = .saving
		do {
			try await reset(token, password)
			phase = .done
		} catch let error as PasswordResetError {
			phase = .failed(error.message)
		} catch {
			phase = .failed(PasswordResetError.network(error.localizedDescription).message)
		}
	}

	private func clearProblem() {
		if case .failed = phase { phase = .editing }
	}
}

extension ResetPasswordModel: Identifiable {}
