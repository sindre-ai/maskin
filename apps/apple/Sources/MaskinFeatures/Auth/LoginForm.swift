import Foundation
import MaskinCore

/// The sign-in form's state and rules, separate from the view so they're testable.
struct LoginForm: Equatable {
	var email = ""
	var password = ""

	var trimmedEmail: String { email.trimmingCharacters(in: .whitespacesAndNewlines) }

	/// Cheap shape check; the server is the authority. Catches an empty field or a missing `@`.
	var canSubmit: Bool {
		let e = trimmedEmail
		return e.contains("@") && !e.hasPrefix("@") && !e.hasSuffix("@") && !password.isEmpty
	}
}

extension LoginForm {
	static let sessionEndedMessage = "Your session ended. Sign in again to pick up where you left off."

	/// The calm notice shown above the form after the server ended the session. A real sign-in
	/// error takes its place (it is more specific), and a new attempt in flight hides it.
	static func sessionNotice(sessionExpired: Bool, lastError: AuthError?, isSigningIn: Bool) -> String? {
		sessionExpired && lastError == nil && !isSigningIn ? sessionEndedMessage : nil
	}
}

extension AuthError {
	/// Plain-language text for the inline error under the form.
	var message: String {
		switch self {
		case .invalidCredentials:
			"That email and password don't match. Check them and try again."
		case .server(let status):
			"Maskin is having trouble right now (error \(status)). Try again in a moment."
		case .network:
			"Can't reach Maskin. Check your connection and try again."
		}
	}
}
