import Foundation

#if canImport(LocalAuthentication) && (os(iOS) || os(macOS))
	import LocalAuthentication

	/// `LAPolicy.deviceOwnerAuthentication`: biometrics, with the device passcode as the fallback.
	/// Same API on iOS and macOS (Touch ID, or the login password on a Mac without it).
	public struct LocalAuthenticator: AppLockAuthenticating {
		public init() {}

		public var availability: AppLockAvailability {
			let context = LAContext()
			var error: NSError?
			guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
				return .unavailable
			}
			// Biometry type is only populated after canEvaluatePolicy.
			switch context.biometryType {
			case .faceID: return .biometric(name: "Face ID")
			case .touchID: return .biometric(name: "Touch ID")
			case .opticID: return .biometric(name: "Optic ID")
			default: return .passcodeOnly
			}
		}

		public func authenticate(reason: String) async -> AppLockResult {
			let context = LAContext()
			var error: NSError?
			guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
				return .unavailable
			}
			do {
				let ok = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
				return ok ? .success : .failed
			} catch {
				return .failed
			}
		}
	}
#else
	/// Platforms without LocalAuthentication (tv, watch): the lock is never offered.
	public struct LocalAuthenticator: AppLockAuthenticating {
		public init() {}
		public var availability: AppLockAvailability { .unavailable }
		public func authenticate(reason: String) async -> AppLockResult { .unavailable }
	}
#endif
