import Foundation
import MaskinCore
import Observation

/// The "Forgot password" sheet's state, separate from the view so every transition is testable.
/// The link in the email opens the web reset page, so the app only asks for the email.
@MainActor
@Observable
final class ForgotPasswordModel {
	enum Phase: Equatable {
		case editing
		case sending
		/// Shown for any email the server accepted, so it never says whether an account exists.
		case sent
		case failed(String)
	}

	static let sentMessage = "If that email has an account, we sent a link."

	var email: String {
		didSet { if email != oldValue, case .failed = phase { phase = .editing } }
	}
	private(set) var phase: Phase = .editing
	private let send: @MainActor (String) async throws -> Void

	init(email: String = "", send: @escaping @MainActor (String) async throws -> Void) {
		self.email = email
		self.send = send
	}

	var trimmedEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }

	/// Cheap shape check, as on the sign-in form; the server is the authority.
	var canSubmit: Bool {
		let e = trimmedEmail
		return e.contains("@") && !e.hasPrefix("@") && !e.hasSuffix("@")
	}

	var isSending: Bool { phase == .sending }

	func submit() async {
		guard canSubmit, phase != .sending, phase != .sent else { return }
		phase = .sending
		do {
			try await send(trimmedEmail)
			phase = .sent
		} catch let error as PasswordResetError {
			phase = .failed(error.message)
		} catch {
			phase = .failed(PasswordResetError.network(error.localizedDescription).message)
		}
	}
}

extension ForgotPasswordModel: Identifiable {}

extension PasswordResetError {
	/// Plain-language text for the inline error under the field.
	var message: String {
		switch self {
		case .rateLimited:
			"Too many attempts. Wait a few minutes and try again."
		case .server(let status):
			"Maskin is having trouble right now (error \(status)). Try again in a moment."
		case .network:
			"Can't reach Maskin. Check your connection and try again."
		}
	}
}
