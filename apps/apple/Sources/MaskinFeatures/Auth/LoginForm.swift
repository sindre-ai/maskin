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
