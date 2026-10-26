import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// An agent's ask for a secret it doesn't have (the web's `KeychainRequestCard`). The person types
/// the key, or the username and password, into the card and it goes straight to the encrypted
/// vault: the value never passes through the agent or the message. It is shared with the agents in
/// this chat. Saving stops the agent's idle session and the reply message starts a fresh one that
/// has the credential in its environment.
struct KeychainRequestCard: View {
	let request: KeychainCredentialRequest
	let messageCreatedAt: Date?
	/// The agents in this chat: all may use it unless one is unticked.
	let agents: [ChatParticipant]
	/// Posts the person's reply into the chat; it is hidden from the chat, as on the web.
	let onReply: (String, ChatSendMetadata) -> Void

	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var name: String
	@State private var secret = ""
	@State private var username = ""
	@State private var password = ""
	@State private var unselected: Set<String> = []
	@State private var busy = false
	@State private var error: String?
	@State private var savedName: String?
	@State private var stillRunning = false

	init(
		request: KeychainCredentialRequest, messageCreatedAt: Date?, agents: [ChatParticipant],
		onReply: @escaping (String, ChatSendMetadata) -> Void
	) {
		self.request = request
		self.messageCreatedAt = messageCreatedAt
		self.agents = agents
		self.onReply = onReply
		_name = State(initialValue: request.suggestedName ?? "")
	}

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s6) {
			if let savedName {
				HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
					Image(systemName: "lock.fill").foregroundStyle(MaskinColor.ink4).accessibilityHidden(true)
					Text("Saved \(savedName) to the Keychain.").maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
				}
				.accessibilityElement(children: .combine)
				if stillRunning {
					Text("The agent is still running without it. Stop it from the chat, then send a message to start it again with the credential.")
						.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
			} else {
				form
			}
		}
		.padding(MaskinSpace.s8)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: shape)
		.overlay(shape.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.padding(.top, MaskinSpace.s3)
		.accessibilityElement(children: .contain)
		.task(id: request.sessionID) {
			guard let source = source() else { return }
			if let earlier = await source.savedName(for: request, after: messageCreatedAt) { savedName = earlier }
		}
	}

	private var shape: RoundedRectangle {
		RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
	}

	private var isLogin: Bool { request.kind == .login }

	@ViewBuilder
	private var form: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			Text(isLogin ? "Add a login to your Keychain" : "Add a key to your Keychain")
				.maskinText(.headline).foregroundStyle(MaskinColor.ink)
			Text(
				(request.hint.map { $0 + " " } ?? "")
					+ "You type it here and it goes straight to your encrypted vault. The agent never sees it in the chat."
			)
			.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			.fixedSize(horizontal: false, vertical: true)
		}
		field("Name") {
			TextField("e.g. e-conomic", text: $name)
				.plainInput()
		}
		if isLogin {
			field("Username") {
				TextField("Username", text: $username)
					.plainInput().textContentType(.username)
			}
			field("Password") {
				SecureField("Password", text: $password).textContentType(.password)
			}
		} else {
			field("Key") {
				SecureField("Paste the key", text: $secret).textContentType(.password)
			}
		}
		if agents.count > 1 {
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				Text("Who can use it").maskinText(.microLabel).foregroundStyle(MaskinColor.ink4)
				ForEach(agents) { agent in
					Toggle(agent.name, isOn: binding(for: agent.id))
						.maskinText(.subhead).foregroundStyle(MaskinColor.ink2)
				}
			}
		}
		if let message = error ?? nameProblem {
			Text(message).maskinText(.caption).foregroundStyle(MaskinColor.ink3)
		}
		Button {
			MaskinHaptics.play(.light)
			Task { await save() }
		} label: {
			Text(busy ? "Saving…" : "Save to Keychain")
				.maskinText(.subhead).fontWeight(.semibold)
				.foregroundStyle(MaskinSurface.onInverse)
				.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
				.background(MaskinSurface.inverse, in: Capsule())
				.opacity(canSave ? 1 : 0.35)
		}
		.buttonStyle(.maskinPressed(.shrink))
		.disabled(!canSave)
	}

	private func field<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			Text(title).maskinText(.microLabel).foregroundStyle(MaskinColor.ink4)
			content()
				.maskinText(.body)
				.padding(.horizontal, MaskinSpace.s6)
				.frame(minHeight: MaskinSpace.touchMin)
				.background(MaskinSurface.grouped, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
		}
	}

	private func binding(for id: String) -> Binding<Bool> {
		Binding(
			get: { !unselected.contains(id) },
			set: { on in if on { unselected.remove(id) } else { unselected.insert(id) } })
	}

	private var selectedIDs: [String] { agents.map(\.id).filter { !unselected.contains($0) } }

	private var nameProblem: String? {
		name.trimmingCharacters(in: .whitespaces).isEmpty ? nil : KeychainCredentialName.problem(name)
	}

	private var hasValue: Bool {
		isLogin ? !username.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty : !secret.isEmpty
	}

	private var canSave: Bool {
		!busy && hasValue && !selectedIDs.isEmpty && !name.trimmingCharacters(in: .whitespaces).isEmpty
			&& nameProblem == nil
	}

	private func source() -> KeychainCapturing? {
		guard let runtime, let workspaceID = runtime.environment.workspaceId else { return nil }
		let env = runtime.environment
		return APIKeychainCaptureSource(
			client: env.client, workspaceID: workspaceID, baseURL: env.baseURL, clientSource: env.clientSource,
			credentials: env.auth.credentialsProvider)
	}

	private func helper() -> HelperSessionReplying? {
		guard let runtime, let workspaceID = runtime.environment.workspaceId else { return nil }
		return APIHelperSessionSource(client: runtime.environment.client, workspaceID: workspaceID)
	}

	private func save() async {
		guard canSave, let source = source() else { return }
		busy = true
		error = nil
		defer { busy = false }
		let displayName = name.trimmingCharacters(in: .whitespacesAndNewlines)
		let value: KeychainCredentialInput.Value =
			isLogin
			? .login(username: username.trimmingCharacters(in: .whitespaces), password: password)
			: .apiKey(secret)
		do {
			let relaunched = try await source.save(
				KeychainCredentialInput(displayName: displayName, value: value, agentIDs: selectedIDs), for: request)
			// The value is gone from the screen the moment it is saved.
			secret = ""
			password = ""
			username = ""
			savedName = displayName
			if relaunched {
				let reply = request.savedReply(name: displayName)
				if request.replyToSession {
					do {
						try await helper()?.continueSession(sessionID: request.sessionID, content: reply)
					} catch {
						// The credential is saved; only the agent's restart failed.
						stillRunning = true
					}
				} else {
					onReply(reply, ChatSendMetadata(hiddenFromChat: true))
				}
			} else {
				// The idle session could not be stopped, so it still has no credential.
				stillRunning = true
			}
		} catch let failure as KeychainAccessError {
			error = failure.message
		} catch {
			self.error = "Couldn't save. Check the name and the value, then try again."
		}
	}
}

private extension View {
	/// No auto-capitalisation or correction (iOS only; the modifiers don't exist on macOS).
	@ViewBuilder
	func plainInput() -> some View {
		#if os(iOS)
		self.textInputAutocapitalization(.never).autocorrectionDisabled()
		#else
		self.autocorrectionDisabled()
		#endif
	}
}
