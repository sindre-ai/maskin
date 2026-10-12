import CoreGraphics
import Foundation
import ImageIO
import MaskinCore
import MaskinDesign
import SwiftUI
import Testing
import UniformTypeIdentifiers

@testable import MaskinFeatures

private struct Fixed: Authenticating {
	var signUpResult: Result<SignUpResult, SignUpError> = .failure(.emailTaken)
	func login(email: String, password: String) async throws -> LoginResult { throw AuthError.invalidCredentials }
	func signUp(name: String, email: String, password: String, idempotencyKey: String) async throws
		-> SignUpResult
	{ try signUpResult.get() }
}

@MainActor
private func write<V: View>(_ view: V, name: String, width: CGFloat, dark: Bool) throws {
	let height: CGFloat = width > 500 ? 1000 : 874
	let framed = view
		.frame(width: width, height: height)
		.environment(\.colorScheme, dark ? .dark : .light)
	let renderer = ImageRenderer(content: framed)
	renderer.scale = 2
	guard let image = renderer.cgImage else { throw CocoaError(.fileWriteUnknown) }
	let dir = URL(
		fileURLWithPath: ProcessInfo.processInfo.environment["AUTH_SNAPSHOT_DIR"] ?? NSTemporaryDirectory())
	try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
	let url = dir.appendingPathComponent("auth-\(name)-\(Int(width))-\(dark ? "dark" : "light").png")
	let dest = try #require(CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil))
	CGImageDestinationAddImage(dest, image, nil)
	#expect(CGImageDestinationFinalize(dest))
}

@MainActor
@Suite("Auth snapshots")
struct AuthSnapshotTests {
	private func auth() -> AuthSession {
		AuthSession(authenticator: Fixed(), store: InMemorySecretStore(), firstUse: InMemoryFirstUseStore())
	}

	private let legal = AuthConfig(
		termsURL: URL(string: "https://example.com/terms"), privacyURL: URL(string: "https://example.com/privacy"))

	@Test("renders sign-in, sign-up, errors and first use at phone and iPad widths, light and dark")
	func render() async throws {
		for width: CGFloat in [402, 820] {
			for dark in [false, true] {
				let signIn = AuthScreenModel(config: legal)
				try write(AuthView(auth: auth(), model: signIn), name: "signin", width: width, dark: dark)

				let filled = AuthScreenModel(config: legal)
				filled.email = "sam@example.com"
				filled.password = "hunter2!"
				let failing = auth()
				await failing.signIn(email: "sam@example.com", password: "x")
				try write(AuthView(auth: failing, model: filled), name: "signin-error", width: width, dark: dark)

				let up = AuthScreenModel(mode: .createAccount, config: legal)
				try write(AuthView(auth: auth(), model: up), name: "signup", width: width, dark: dark)

				let bad = AuthScreenModel(mode: .createAccount, config: legal)
				bad.name = "Sam"
				bad.email = "sam@example"
				bad.touch(.email)
				bad.password = "short"
				bad.touch(.password)
				try write(AuthView(auth: auth(), model: bad), name: "signup-invalid", width: width, dark: dark)

				let taken = AuthScreenModel(mode: .createAccount, config: legal)
				taken.name = "Sam"; taken.email = "sam@example.com"; taken.password = "correct-horse"
				let takenAuth = auth()
				await taken.submit(auth: takenAuth)
				try write(AuthView(auth: takenAuth, model: taken), name: "signup-taken", width: width, dark: dark)

				for (name, readiness) in [("ready", FirstUseReadiness.ready), ("setup", .settingUp)] {
					try write(
						FirstUseView(
							name: "Sam Krum", readiness: readiness, hasWelcomeChat: name == "ready",
							onOpenWelcome: {}, onContinue: {}, onRetry: {}),
						name: "firstuse-\(name)", width: width, dark: dark)
				}
			}
		}
	}
}
