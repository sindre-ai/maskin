import Foundation
import MaskinCore
import Observation

/// The text shown above the primary button, if any: a calm notice or a real error.
enum AuthBanner: Equatable {
	case notice(String)
	case error(String)

	var text: String {
		switch self {
		case .notice(let t), .error(let t): t
		}
	}
}

/// The sign-in / create-account screen's state machine, separate from the view so every
/// transition is testable. The view owns focus and layout; this owns what the fields hold, which
/// mode is showing, what the server last said about each field, and what to show as the banner.
@MainActor
@Observable
final class AuthScreenModel {
	enum Mode: Equatable, CaseIterable, Sendable {
		case signIn, createAccount

		var title: String { self == .signIn ? "Sign in" : "Create account" }
	}

	enum Field: Hashable, Sendable { case name, email, password }

	private(set) var mode: Mode
	let config: AuthConfig

	var name = "" { didSet { if name != oldValue { fieldEdited(.name) } } }
	var email = "" { didSet { if email != oldValue { fieldEdited(.email) } } }
	var password = "" { didSet { if password != oldValue { fieldEdited(.password) } } }

	/// Fields the user has left (or tried to submit past): live hints appear only for these, so
	/// an empty form doesn't open covered in red.
	private(set) var touched: Set<Field> = []
	private(set) var serverFieldErrors: [Field: String] = [:]

	init(mode: Mode = .signIn, config: AuthConfig = .current) {
		self.config = config
		self.mode = config.signUpEnabled ? mode : .signIn
	}

	var signIn: LoginForm { LoginForm(email: email, password: password) }
	var signUp: SignUpForm { SignUpForm(name: name, email: email, password: password) }

	/// Fields in on-screen (and focus) order for the current mode.
	var fields: [Field] { mode == .signIn ? [.email, .password] : [.name, .email, .password] }

	func next(after field: Field) -> Field? {
		guard let i = fields.firstIndex(of: field), i + 1 < fields.count else { return nil }
		return fields[i + 1]
	}

	var canSubmit: Bool { mode == .signIn ? signIn.canSubmit : signUp.canSubmit }

	func switchTo(_ new: Mode) {
		guard new != mode, config.signUpEnabled || new == .signIn else { return }
		mode = new
		serverFieldErrors = [:]
		touched = []
	}

	func touch(_ field: Field) { touched.insert(field) }

	/// The hint under a field: the server's word on it if it just spoke, else our live check once
	/// the field has been visited. Sign-in never nags; it only sends what's typed.
	func message(for field: Field) -> String? {
		if let server = serverFieldErrors[field] { return server }
		guard mode == .createAccount, touched.contains(field) else { return nil }
		switch field {
		case .name: return signUp.nameProblem
		case .email: return signUp.emailProblem
		case .password: return signUp.passwordProblem
		}
	}

	/// The notice or error above the button. A real error beats the calm "session ended" notice,
	/// which also hides while a new attempt is in flight.
	func banner(for auth: AuthSession) -> AuthBanner? {
		switch mode {
		case .signIn:
			if let error = auth.lastError { return .error(error.message) }
			return LoginForm.sessionNotice(
				sessionExpired: auth.sessionExpired, lastError: auth.lastError,
				isSigningIn: auth.isSigningIn
			).map(AuthBanner.notice)
		case .createAccount:
			guard let error = auth.lastSignUpError else { return nil }
			// A known field's error is already shown under that field.
			if error == .emailTaken { return nil }
			if case .invalid(let fields) = error, fields.keys.contains(where: { Self.field(named: $0) != nil }) {
				return nil
			}
			return .error(error.message)
		}
	}

	func isBusy(_ auth: AuthSession) -> Bool { auth.isSigningIn || auth.isSigningUp }

	/// Submit the current mode's form. Returns whether a request was made (so the view knows
	/// whether to drop focus). A failed sign-up maps the server's per-field messages back to
	/// their fields; success flips the app root to the shell, so there is nothing to do after.
	@discardableResult
	func submit(auth: AuthSession) async -> Bool {
		guard !isBusy(auth) else { return false }
		touched.formUnion(fields)
		guard canSubmit else { return false }
		serverFieldErrors = [:]
		switch mode {
		case .signIn:
			await auth.signIn(email: signIn.trimmedEmail, password: password)
		case .createAccount:
			let form = signUp
			await auth.signUp(name: form.trimmedName, email: form.trimmedEmail, password: password)
			applyServerErrors(auth.lastSignUpError)
		}
		return true
	}

	private func applyServerErrors(_ error: SignUpError?) {
		switch error {
		case .emailTaken?:
			serverFieldErrors = [.email: "Email already exists."]
		case .invalid(let fields)?:
			serverFieldErrors = Dictionary(
				uniqueKeysWithValues: fields.compactMap { key, message in
					Self.field(named: key).map { ($0, message) }
				})
		default:
			break
		}
	}

	private func fieldEdited(_ field: Field) {
		serverFieldErrors[field] = nil
	}

	static func field(named key: String) -> Field? {
		switch key {
		case "name": .name
		case "email": .email
		case "password": .password
		default: nil
		}
	}
}
