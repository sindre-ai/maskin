import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// An agent's ask to use a credential from the Keychain (the web's `KeychainAccessRequestCard`).
/// Allow in this chat / Always allow / Not now. Whether it was already answered is read from the
/// credential's grants, so a card scrolled back to says so instead of offering the buttons again.
/// Allow stops the agent's idle session and the reply message starts a fresh one with the
/// credential in its environment; the agent never sees the value.
struct KeychainAccessCard: View {
	let request: KeychainAccessRequest
	let agentID: String
	let conversationID: String
	/// Posts the person's reply into the chat.
	let onReply: (String) -> Void

	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var state: KeychainAccessState = .unknown
	@State private var busy = false
	@State private var error: String?
	@State private var declined = false
	@State private var stillRunning = false

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s6) {
			if let line = settledLine {
				HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
					Image(systemName: "lock.fill").foregroundStyle(MaskinColor.ink4).accessibilityHidden(true)
					Text(line).maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
				}
				.accessibilityElement(children: .combine)
				if stillRunning {
					Text("The agent is still running without it. Stop it from the chat, then send a message to start it again with the credential.")
						.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
			} else {
				VStack(alignment: .leading, spacing: MaskinSpace.s2) {
					Text("Let this agent use \(request.credentialName)?")
						.maskinText(.headline).foregroundStyle(MaskinColor.ink)
						.fixedSize(horizontal: false, vertical: true)
					Text(explanation).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
						.fixedSize(horizontal: false, vertical: true)
				}
				if let error {
					Text(error).maskinText(.caption).foregroundStyle(MaskinColor.ink3)
				}
				VStack(spacing: MaskinSpace.s4) {
					choice("Allow in this chat", primary: true) { await allow(.chat) }
					choice("Always allow", primary: false) { await allow(.always) }
					choice("Not now", primary: false) { decline() }
				}
			}
		}
		.padding(MaskinSpace.s8)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: shape)
		.overlay(shape.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.padding(.top, MaskinSpace.s3)
		.accessibilityElement(children: .contain)
		.task(id: request.integrationID) { await refresh() }
	}

	private var shape: RoundedRectangle {
		RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
	}

	private var explanation: String {
		let hint = request.hint.map { $0 + " " } ?? ""
		return hint + "It stays in your encrypted vault and the agent never sees the value in the chat."
	}

	/// What to say once the card has been answered (or its credential is gone); nil while it asks.
	private var settledLine: String? {
		if declined { return "Declined \(request.credentialName)." }
		switch state {
		case .allowed(.chat): return "Allowed \(request.credentialName) for this agent in this chat only."
		case .allowed(.always):
			return "Allowed \(request.credentialName) for this agent. It stays until you remove it."
		case .gone: return "\(request.credentialName) is no longer in the Keychain."
		case .unknown, .ask: return nil
		}
	}

	private func choice(_ title: String, primary: Bool, action: @escaping () async -> Void) -> some View {
		Button {
			MaskinHaptics.play(.light)
			Task { await action() }
		} label: {
			Text(title)
				.maskinText(.subhead).fontWeight(.semibold)
				.foregroundStyle(primary ? MaskinSurface.onInverse : MaskinColor.ink)
				.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
				.background {
					if primary {
						Capsule().fill(MaskinSurface.inverse)
					} else {
						Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1)
					}
				}
				.opacity(busy ? 0.35 : 1)
		}
		.buttonStyle(.maskinPressed(.shrink))
		.disabled(busy)
	}

	private func source() -> KeychainAccessing? {
		guard let runtime, let workspaceID = runtime.environment.workspaceId else { return nil }
		return APIKeychainAccessSource(client: runtime.environment.client, workspaceID: workspaceID)
	}

	private func refresh() async {
		guard let source = source() else { return }
		state = await source.state(for: request, agentID: agentID, conversationID: conversationID)
	}

	private func allow(_ scope: KeychainAccessScope) async {
		guard let source = source() else { return }
		busy = true
		error = nil
		defer { busy = false }
		do {
			let relaunched = try await source.allow(request, scope: scope)
			state = .allowed(scope)
			if relaunched {
				onReply(request.allowedReply(scope: scope))
			} else {
				// The idle session could not be stopped, so it still lacks the credential.
				stillRunning = true
			}
		} catch let failure as KeychainAccessError {
			error = failure.message
		} catch {
			self.error = "Couldn't allow it. Try again."
		}
	}

	private func decline() {
		declined = true
		onReply(request.declinedReply)
	}
}
