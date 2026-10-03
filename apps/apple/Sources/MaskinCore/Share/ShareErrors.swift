import Foundation

/// Why a share did not go through, as a sentence the sheet can show. Carries no ids, tokens,
/// response bodies or shared content.
public enum ShareError: Error, Equatable, Sendable {
	/// No session in the shared keychain.
	case signedOut
	/// Signed in, but no workspace was ever chosen.
	case noWorkspace
	/// The keychain could not be read (device locked before first unlock, keychain error).
	case sessionUnreadable
	/// The server rejected the saved key: it was revoked or rotated.
	case sessionExpired
	case offline
	/// Nothing was shared that Maskin can take.
	case nothingToShare
	/// The server refused the content (a 4xx other than auth).
	case rejected
	case fileRejected(name: String)
	case server
	case unknown

	public var message: String {
		switch self {
		case .signedOut: "Open Maskin to sign in, then share again."
		case .noWorkspace: "Open Maskin and choose a workspace, then share again."
		case .sessionUnreadable: "Couldn't read your Maskin sign-in. Unlock your device or open Maskin."
		case .sessionExpired: "Your Maskin sign-in expired. Open Maskin to sign in again."
		case .offline: "You're offline. Your share is kept, so you can try again."
		case .nothingToShare: "There's nothing here Maskin can take."
		case .rejected: "Maskin couldn't accept this. Check the title and try again."
		case .fileRejected(let name): "Maskin couldn't accept \(name)."
		case .server: "Maskin had a problem on its side. Try again in a moment."
		case .unknown: "Something went wrong. Try again."
		}
	}

	/// Whether Retry can help. Signed-out and nothing-to-share need the user to act elsewhere.
	public var isRetryable: Bool {
		switch self {
		case .offline, .server, .unknown, .rejected, .fileRejected, .sessionUnreadable: true
		case .signedOut, .noWorkspace, .sessionExpired, .nothingToShare: false
		}
	}

	/// Whether the fix is in the main app (the sheet offers "Open Maskin").
	public var needsApp: Bool {
		switch self {
		case .signedOut, .noWorkspace, .sessionExpired: true
		default: false
		}
	}
}
