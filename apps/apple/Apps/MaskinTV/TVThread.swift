import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One conversation: the latest messages, then Dictate and a few quick replies. The system keyboard
/// on tvOS offers dictation from the Siri Remote's mic, so "Dictate" opens a text prompt that takes
/// spoken words; the chips cover the common answers without any input.
struct TVThread: View {
	@State private var chat: ChatStore
	@State private var composing = false
	@State private var draft = ""
	@Environment(\.dismiss) private var dismiss

	init(environment: AppEnvironment, conversationID: String) {
		let session = environment.auth.session
		_chat = State(
			initialValue: ChatStore(
				conversationID: conversationID, currentActorID: session?.actorId ?? "",
				currentActorName: session?.name ?? "You",
				api: APIChatsSource(client: environment.client, workspaceID: environment.workspaceId ?? ""),
				queue: ChatsRuntime.shared(environment: environment).queue, events: environment.events,
				cache: environment.snapshotCache))
	}

	private var recent: [ChatMessage] { WatchChat.recent(chat.messages, limit: 7) }

	var body: some View {
		VStack(alignment: .leading, spacing: 24) {
			header
			Spacer(minLength: 0)
			VStack(alignment: .leading, spacing: 20) {
				ForEach(recent) { message in bubble(message) }
				if let working = chat.workingAgents().first {
					Text("\(working.name) is working…").font(.system(size: 26)).foregroundStyle(MaskinColor.ink4)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			if let notice = chat.notice {
				Text(notice).font(.system(size: 26)).foregroundStyle(MaskinColor.danger)
			}
			HStack(spacing: 16) {
				Button { composing = true } label: {
					TVCapsuleLabel(title: "Dictate", prominent: true, symbol: "mic.fill", slim: true)
				}
				.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
				Button { composing = true } label: { TVCapsuleLabel(title: "Type", symbol: "keyboard", slim: true) }
					.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
				ForEach(Array(TVChat.quickReplies.enumerated()), id: \.offset) { _, phrase in
					Button { chat.send(phrase) } label: { TVCapsuleLabel(title: phrase, slim: true) }
						.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 48))
				}
				Spacer(minLength: 0)
				Button { dismiss() } label: {
					Label("Back", systemImage: "chevron.left").font(.system(size: 34, weight: .semibold))
						.foregroundStyle(MaskinColor.ink3).padding(.horizontal, 28).frame(minHeight: 72)
				}
				.buttonStyle(TVFocusStyle(scale: 1.05, cornerRadius: 36))
			}
		}
		.padding(.horizontal, 96)
		.padding(.top, 56)
		.padding(.bottom, 48)
		.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		.ignoresSafeArea()
		.alert("Reply", isPresented: $composing) {
			TextField("Say or type your reply", text: $draft)
			Button("Send") {
				let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
				draft = ""
				if !text.isEmpty { chat.send(text) }
			}
			Button("Cancel", role: .cancel) { draft = "" }
		}
		.task { await chat.start() }
		.onDisappear { chat.stop() }
	}

	private var header: some View {
		HStack(spacing: 24) {
			Text(chat.title == "Chief of Staff" ? "Co" : String(chat.title.split(separator: " ").prefix(2).compactMap(\.first)))
				.font(.system(size: 34, weight: .bold)).foregroundStyle(MaskinColor.avFg)
				.frame(width: 76, height: 76)
				.background(MaskinGradient.avatar, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
			Text(chat.title).font(.system(size: 48, weight: .bold)).lineLimit(1)
		}
	}

	private func bubble(_ message: ChatMessage) -> some View {
		let mine = message.actorID == chat.currentActorID
		return HStack {
			if mine { Spacer(minLength: 240) }
			VStack(alignment: .leading, spacing: 6) {
				Text(message.content).font(.system(size: 30)).lineLimit(5)
			}
			.padding(.horizontal, 28).padding(.vertical, 20)
			.foregroundStyle(mine ? MaskinSurface.onInverse : MaskinColor.ink)
			.background(mine ? MaskinSurface.inverse : MaskinSurface.fillStrong, in: RoundedRectangle(cornerRadius: 36, style: .continuous))
			if !mine { Spacer(minLength: 240) }
		}
	}
}

/// What the TV thread offers without any input.
enum TVChat {
	static let quickReplies = ["Yes", "No", "Thanks"]
}
