import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// An agent's ask for access to an integration that is connected but not allowed for it (the web's
/// `IntegrationAccessRequestCard`). Allow sets the agent's access on the server, the same as
/// Settings → Integrations, stops its idle session and posts a short hidden message that starts a
/// fresh one. Not now only tells the agent. Whether it was allowed is read from the integration
/// list, so a card scrolled back to says so.
struct IntegrationAccessCard: View {
	let request: IntegrationAccessRequest
	let agentID: String
	/// Who asked, for "For Chief of Staff" and the settled line. Nil reads "this agent".
	var agentName: String?
	/// The card's own message id, so a decline can be recorded against it.
	let messageID: Int?
	var answered: ChatCardAnswer.Outcome?
	let onReply: (String, ChatSendMetadata) -> Void

	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var state: IntegrationAccessState = .unknown
	@State private var busy = false
	@State private var error: String?
	@State private var declinedNow = false
	@State private var allowedNow = false
	@State private var stillRunning = false
	/// What the person will grant: the ask, or lower. Nil until they touch the picker.
	@State private var chosenLevel: IntegrationAccessRequest.Level?

	private var level: IntegrationAccessRequest.Level { chosenLevel ?? request.level }

	private var declined: Bool { declinedNow || answered == .declined }

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s6) {
			if let line = settledLine {
				RequestCardSettled(symbol: "key.fill", text: line)
				if stillRunning {
					Text("The agent is still running with its old access. Stop it from the chat, then send a message to start it again.")
						.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
			} else {
				VStack(alignment: .leading, spacing: MaskinSpace.s2) {
					Text("Allow \(request.displayName)?")
						.maskinText(.headline).foregroundStyle(MaskinColor.ink)
						.fixedSize(horizontal: false, vertical: true)
					Text("For \(agentName ?? "this agent")")
						.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
					if let reason = request.reason, !reason.isEmpty {
						Text(reason).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
							.fixedSize(horizontal: false, vertical: true)
					}
				}
				accessRows
				if let error { Text(error).maskinText(.caption).foregroundStyle(MaskinColor.ink3) }
				VStack(spacing: MaskinSpace.s4) {
					RequestCardButton(title: "Allow", primary: true, disabled: busy) { Task { await allow() } }
					RequestCardButton(title: "Not now", disabled: busy) { decline() }
				}
			}
		}
		.requestCardFrame()
		.task(id: request.integrationID) { await refresh() }
	}

	/// How much and how long, as two rows. The level can be lowered to Read before Allow.
	private var accessRows: some View {
		VStack(spacing: 0) {
			HStack(spacing: MaskinSpace.s4) {
				Text("Access").maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
				Spacer(minLength: 0)
				if request.choosableLevels.count > 1 {
					Picker("Access", selection: Binding(get: { level }, set: { chosenLevel = $0 })) {
						ForEach(request.choosableLevels, id: \.self) { Text($0.label).tag($0) }
					}
					.pickerStyle(.segmented)
					.fixedSize()
				} else {
					Text(level.label).maskinText(.subhead).foregroundStyle(MaskinColor.ink)
				}
			}
			.frame(minHeight: MaskinSpace.touchMin)
			Rectangle().fill(MaskinSurface.separator).frame(height: 1)
			HStack(spacing: MaskinSpace.s4) {
				Text("Lasts").maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
				Spacer(minLength: 0)
				Text("Until you remove it").maskinText(.subhead).foregroundStyle(MaskinColor.ink)
			}
			.frame(minHeight: MaskinSpace.touchMin)
		}
		.padding(.horizontal, MaskinSpace.s6)
		.background(MaskinSurface.grouped, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
	}

	private var settledLine: String? {
		if allowedNow || state == .allowed {
			return request.allowedLine(agentName: agentName)
		}
		if declined { return request.declinedLine(agentName: agentName) }
		if state == .gone { return "\(request.displayName) is no longer connected." }
		return nil
	}

	private func source() -> (IntegrationAccessing, HelperSessionReplying)? {
		guard let runtime, let workspaceID = runtime.environment.workspaceId else { return nil }
		let client = runtime.environment.client
		return (
			APIIntegrationAccessSource(client: client, workspaceID: workspaceID),
			APIHelperSessionSource(client: client, workspaceID: workspaceID)
		)
	}

	private func refresh() async {
		guard let (access, _) = source() else { return }
		state = await access.state(for: request, agentID: agentID)
	}

	private func allow() async {
		guard let (access, helper) = source() else { return }
		busy = true
		error = nil
		defer { busy = false }
		do {
			let granted = request.with(level: level)
			let result = try await access.allow(granted)
			allowedNow = true
			if result.changed, !result.relaunched {
				// The idle session could not be stopped, so it still has the old access.
				stillRunning = true
				return
			}
			let reply = granted.allowedReply(changed: result.changed)
			if request.replyToSession {
				do {
					// Stopped to take the new access, so its follow-up carries on; not stopped, so write into it.
					if result.changed {
						try await helper.continueSession(sessionID: request.sessionID, content: reply)
					} else {
						// Not stopped, so write into the running helper. Without the card's message id there is
						// nothing to record the answer against: say so rather than skip it and look done.
						guard let messageID else { throw KeychainAccessError("Couldn't tell the agent.") }
						try await helper.sendInput(
							sessionID: request.sessionID, content: reply,
							cardAnswer: ChatCardAnswer(messageID: messageID, outcome: .done))
					}
				} catch {
					stillRunning = true
				}
			} else {
				onReply(reply, ChatSendMetadata(hiddenFromChat: true))
			}
		} catch let failure as KeychainAccessError {
			error = failure.message
		} catch {
			self.error = "Couldn't allow it. Try again."
		}
	}

	private func decline() {
		let card = messageID.map { ChatCardAnswer(messageID: $0, outcome: .declined) }
		guard request.replyToSession else {
			declinedNow = true
			onReply(request.declinedReply, ChatSendMetadata(hiddenFromChat: true, cardAnswer: card))
			return
		}
		guard let card, let (_, helper) = source() else {
			error = "Couldn't tell the agent. Try again."
			return
		}
		busy = true
		error = nil
		Task {
			defer { busy = false }
			do {
				try await helper.sendInput(sessionID: request.sessionID, content: request.declinedReply, cardAnswer: card)
				declinedNow = true
			} catch let failure as KeychainAccessError {
				error = failure.message
			} catch {
				self.error = "Couldn't tell the agent. Try again."
			}
		}
	}
}
