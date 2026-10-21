import MaskinCore

#if os(iOS) || os(macOS)
	import AuthenticationServices
	import Foundation

	#if os(iOS)
		import UIKit
	#else
		import AppKit
	#endif

	/// `ASWebAuthenticationSession` behind `WebAuthenticating`.
	///
	/// `prefersEphemeralWebBrowserSession` is false on purpose. The sheet then shares Safari's
	/// cookies, so someone already signed in to Slack, GitHub or LinkedIn there doesn't retype
	/// passwords or redo two-factor, and passkeys work. What it costs: the provider sees a
	/// browser it already knows, and those cookies persist after the connect. That is the same
	/// footing as connecting from the web app, and the OAuth state binding doesn't depend on it
	/// (the server sets its cookie inside this same sheet). Flip the constant to true for a
	/// private, throwaway browser if review prefers that over convenience.
	struct SystemWebAuthenticator: WebAuthenticating {
		static let prefersEphemeralWebBrowserSession = false

		@MainActor
		func authenticate(url: URL, callbackScheme: String) async throws -> URL {
			let context = PresentationContext()
			return try await withCheckedThrowingContinuation { continuation in
				let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) {
					callbackURL, error in
					Task { @MainActor in Self.active = nil }
					if let callbackURL {
						continuation.resume(returning: callbackURL)
					} else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
						continuation.resume(throwing: WebAuthenticationError.cancelled)
					} else {
						continuation.resume(throwing: WebAuthenticationError.unavailable)
					}
				}
				session.presentationContextProvider = context
				session.prefersEphemeralWebBrowserSession = Self.prefersEphemeralWebBrowserSession
				// Held until the completion handler runs.
				Self.active = (session, context)
				if !session.start() {
					Self.active = nil
					continuation.resume(throwing: WebAuthenticationError.unavailable)
				}
			}
		}

		@MainActor private static var active: (ASWebAuthenticationSession, PresentationContext)?

		private final class PresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
			@MainActor
			func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
				#if os(iOS)
					let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
						.first { $0.activationState == .foregroundActive }
					return scene?.keyWindow ?? scene?.windows.first ?? ASPresentationAnchor()
				#else
					return NSApplication.shared.keyWindow ?? ASPresentationAnchor()
				#endif
			}
		}
	}
#else
	/// watchOS and tvOS have no sign-in sheet worth offering here; connecting stays on the web.
	struct SystemWebAuthenticator: WebAuthenticating {
		@MainActor
		func authenticate(url: URL, callbackScheme: String) async throws -> URL {
			throw WebAuthenticationError.unavailable
		}
	}
#endif
