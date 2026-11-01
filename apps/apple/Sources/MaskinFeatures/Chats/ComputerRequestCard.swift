import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// An agent asking the person to act on its own computer (the web's `ComputerRequestCard`): a 2FA
/// prompt, a CAPTCHA, a confirmation. It says what to do; Done hands control back by posting a
/// hidden message, which is what wakes the agent.
///
/// On iPhone, Open computer shows the agent's live computer in the app. Elsewhere it opens the chat
/// in the browser, where its card shows the computer. Done works from either place.
struct ComputerRequestCard: View {
	let request: ComputerRequest
	/// The agent that raised the request: whose computer this is.
	let agentID: String
	let agentName: String
	let conversationID: String
	let messageID: Int?
	var answered: ChatCardAnswer.Outcome?
	let onReply: (String, ChatSendMetadata) -> Void

	#if !os(iOS)
	@Environment(\.openURL) private var openURL
	#endif
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	#if os(iOS)
	@State private var showComputer = false
	#endif
	@State private var doneNow = false
	@State private var busy = false
	@State private var error: String?

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s6) {
			if doneNow || answered == .done {
				RequestCardSettled(symbol: "desktopcomputer", text: "Handed back to \(agentName).")
			} else {
				VStack(alignment: .leading, spacing: MaskinSpace.s2) {
					Text("\(agentName) needs your help on its computer")
						.maskinText(.headline).foregroundStyle(MaskinColor.ink)
						.fixedSize(horizontal: false, vertical: true)
					Text(request.task).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
						.fixedSize(horizontal: false, vertical: true)
				}
				if let error { Text(error).maskinText(.caption).foregroundStyle(MaskinColor.ink3) }
				VStack(spacing: MaskinSpace.s4) {
					#if os(iOS)
					if runtime != nil {
						RequestCardButton(title: "Open computer", primary: true) { showComputer = true }
					}
					RequestCardButton(title: "Done", primary: runtime == nil, disabled: busy) { Task { await done() } }
					#else
					if let url = webChatURL {
						RequestCardButton(title: "Open computer in browser", primary: true) { openURL(url) }
					}
					RequestCardButton(title: "Done", primary: webChatURL == nil, disabled: busy) { Task { await done() } }
					#endif
				}
			}
		}
		.requestCardFrame()
		#if os(iOS)
		.fullScreenCover(isPresented: $showComputer) {
			if let runtime {
				ComputerScreen(
					agentName: agentName, agentID: agentID, environment: runtime.environment,
					onDone: { Task { await done() } })
			}
		}
		#endif
	}

	#if !os(iOS)
	/// This chat on the web, where the card draws the agent's live computer.
	private var webChatURL: URL? {
		guard let runtime, let workspaceID = runtime.environment.workspaceId else { return nil }
		return SettingsServices(environment: runtime.environment).webBaseURL
			.appendingPathComponent(workspaceID).appendingPathComponent("chats").appendingPathComponent(conversationID)
	}
	#endif

	private func done() async {
		let card = messageID.map { ChatCardAnswer(messageID: $0, outcome: .done) }
		guard request.replyToSession else {
			doneNow = true
			onReply(ComputerRequest.doneMessage, ChatSendMetadata(hiddenFromChat: true, cardAnswer: card))
			return
		}
		guard let card, let runtime, let workspaceID = runtime.environment.workspaceId else {
			error = "Couldn't tell the agent. Try again."
			return
		}
		busy = true
		error = nil
		defer { busy = false }
		do {
			try await APIHelperSessionSource(client: runtime.environment.client, workspaceID: workspaceID)
				.sendInput(sessionID: request.sessionID, content: ComputerRequest.doneMessage, cardAnswer: card)
			doneNow = true
		} catch let failure as KeychainAccessError {
			error = failure.message
		} catch {
			self.error = "Couldn't tell the agent. Try again."
		}
	}
}
