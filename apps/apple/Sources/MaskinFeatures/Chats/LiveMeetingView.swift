import MaskinAPI
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The full-screen live meeting: a dark sheet with the lead agent, a running clock and the call's
/// controls. Voice comes from the real microphone and speaker through `LiveVoiceController`; the
/// agent's words are the replies that arrive in the chat. Nothing here is scripted.
struct LiveMeetingScreen: View {
	let request: LiveMeetingRequest
	let environment: AppEnvironment
	let onClose: () -> Void

	@State private var phase: Phase = .connecting

	private enum Phase {
		case connecting
		case ready(LiveMeetingSession, ownsChat: Bool)
		case failed(String)
	}

	var body: some View {
		ZStack {
			MaskinColor.surface.ignoresSafeArea()
			switch phase {
			case .connecting:
				VStack(spacing: MaskinSpace.s7) {
					ProgressView()
					Text("Connecting").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				}
			case .ready(let session, let ownsChat):
				LiveMeetingContent(
					session: session, environment: environment, ownsChat: ownsChat, onClose: onClose)
			case .failed(let message):
				VStack(spacing: MaskinSpace.s9) {
					Text(message).maskinText(.body).foregroundStyle(MaskinColor.ink3)
						.multilineTextAlignment(.center)
					Button("Close", action: onClose).buttonStyle(.borderedProminent)
				}
				.padding(MaskinSpace.s14)
			}
		}
		.preferredColorScheme(.dark)
		.task { await prepare() }
	}

	private func prepare() async {
		guard case .connecting = phase else { return }
		switch request {
		case .thread(let chat, let lead):
			phase = .ready(
				LiveMeetingSession(
					kind: .adHoc, chat: chat, lead: lead, makePorts: LiveMeetingSession.devicePorts),
				ownsChat: false)
		case .dailyBriefing:
			do {
				let (chat, lead) = try await BriefingChat.open(environment: environment)
				phase = .ready(
					LiveMeetingSession(
						kind: .dailyBriefing, chat: chat, lead: lead, makePorts: LiveMeetingSession.devicePorts),
					ownsChat: true)
			} catch {
				phase = .failed((error as? BriefingChat.Failure)?.message ?? error.localizedDescription)
			}
		}
	}
}

/// The Chief of Staff conversation the daily briefing runs in: the existing "Daily briefing" chat,
/// or a new one the first time.
@MainActor
enum BriefingChat {
	static let title = "Daily briefing"

	struct Failure: Error {
		let message: String
	}

	static func open(environment: AppEnvironment) async throws -> (ChatStore, ChatParticipant) {
		guard let workspaceID = environment.workspaceId, let session = environment.auth.session else {
			throw Failure(message: "Choose a workspace first.")
		}
		let source = APIChatsSource(client: environment.client, workspaceID: workspaceID)
		let list = ConversationsStore(api: source, events: nil, cache: nil)
		await list.loadActors()
		guard let chief = list.actors.first(where: \.isChiefOfStaff) else {
			throw Failure(message: "This workspace has no Chief of Staff to brief you.")
		}
		await list.refresh()
		let existing = list.conversations.first {
			$0.title == title && $0.participants.contains { $0.id == chief.id }
		}
		let conversationID: String
		if let existing {
			conversationID = existing.id
		} else {
			conversationID = try await list.create(
				title: title, participantIDs: [chief.id], firstMessage: nil
			).id
		}
		let chat = ChatStore(
			conversationID: conversationID, currentActorID: session.actorId,
			currentActorName: session.name, api: source,
			queue: ChatsRuntime.shared(environment: environment).queue, events: environment.events,
			cache: environment.snapshotCache)
		return (chat, chief.participant)
	}
}

private struct LiveMeetingContent: View {
	let session: LiveMeetingSession
	let environment: AppEnvironment
	let ownsChat: Bool
	let onClose: () -> Void

	@State private var showInvite = false
	@State private var showPullUp = false
	@State private var actors: [ChatActor] = []
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Environment(\.openURL) private var openURL

	private let avatarSize = MaskinSpace.s14 * 3 + MaskinSpace.s9
	private let buttonSize = MaskinSpace.s14 * 2 - MaskinSpace.s3

	var body: some View {
		VStack(spacing: MaskinSpace.s9) {
			Text(session.kind.label).maskinText(.microLabel).foregroundStyle(MaskinColor.ink4)
				.padding(.top, MaskinSpace.s11)
			Spacer(minLength: 0)
			stage
			Spacer(minLength: 0)
			if session.captionsOn { captions }
			controls
		}
		.padding(.horizontal, MaskinSpace.s9)
		.padding(.bottom, MaskinSpace.s9)
		.task {
			if ownsChat { await session.chat.start() }
			session.begin()
		}
		.onChange(of: session.chat.messages.map(\.id)) { _, _ in session.messagesChanged() }
		.onChange(of: session.chat.participants.map(\.id)) { _, _ in session.messagesChanged() }
		.onDisappear {
			session.end()
			if ownsChat { session.chat.stop() }
		}
		.sheet(isPresented: $showInvite) { invitePicker }
		.sheet(isPresented: $showPullUp) { pullUpPicker }
	}

	// MARK: Stage

	private var stage: some View {
		VStack(spacing: MaskinSpace.s7) {
			ZStack {
				ForEach(0..<3, id: \.self) { ring in
					Circle()
						.stroke(MaskinColor.accent.opacity(0.35 - Double(ring) * 0.1), lineWidth: MaskinSpace.s1)
						.frame(width: avatarSize + CGFloat(ring + 1) * MaskinSpace.s13 * 1.2)
						.scaleEffect(pulse(ring))
						.animation(
							reduceMotion || session.voice.phase != .speaking
								? nil : .easeInOut(duration: 1.2).repeatForever().delay(Double(ring) * 0.2),
							value: session.voice.phase)
				}
				ActorAvatar(
					name: session.lead.name, kind: session.lead.kind == .agent ? .agent : .human,
					size: avatarSize, seed: session.lead.id, working: session.voice.phase == .thinking)
			}
			.frame(height: avatarSize + MaskinSpace.s13 * 1.2 * 6)
			Text(session.lead.name).maskinText(.title).foregroundStyle(MaskinColor.ink)
			TimelineView(.periodic(from: .now, by: 1)) { context in
				Text(LiveMeetingFormat.duration(session.elapsed(at: context.date)))
					.maskinText(.mono).foregroundStyle(MaskinColor.ink4)
			}
			Text(statusLine).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				.multilineTextAlignment(.center)
			if !session.guests.isEmpty { guestChips }
		}
		.onTapGesture { if session.voice.phase == .speaking { session.voice.interrupt() } }
		.accessibilityElement(children: .combine)
	}

	private func pulse(_ ring: Int) -> CGFloat {
		session.voice.phase == .speaking && !reduceMotion ? 1.06 : 1
	}

	private var statusLine: String {
		if let failure = session.voice.failure { return failure }
		if session.voice.isMuted { return "Microphone off" }
		switch session.voice.phase {
		case .listening: return session.voice.transcript.isEmpty ? "Listening" : session.voice.transcript
		case .thinking: return "\(session.lead.name) is working on it"
		case .speaking: return "Tap to interrupt"
		}
	}

	private var guestChips: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s4) {
				ForEach(session.guests) { guest in
					HStack(spacing: MaskinSpace.s3) {
						ActorAvatar(name: guest.name, kind: .agent, size: MaskinSpace.s12, seed: guest.id)
						Text(guest.name).maskinText(.caption).foregroundStyle(MaskinColor.ink2)
					}
					.padding(.horizontal, MaskinSpace.s5)
					.padding(.vertical, MaskinSpace.s2)
					.background(MaskinColor.surfaceAlt, in: Capsule())
				}
			}
		}
		.frame(maxWidth: .infinity)
	}

	private var captions: some View {
		Text(session.lastAgentWords ?? "Captions appear here when \(session.lead.name) speaks.")
			.maskinText(.subhead).foregroundStyle(MaskinColor.ink2)
			.lineLimit(6)
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(MaskinSpace.s8)
			.background(MaskinColor.surfaceMuted, in: RoundedRectangle(cornerRadius: MaskinRadius.panelXl))
			.padding(.bottom, MaskinSpace.s7)
	}

	// MARK: Controls

	private var controls: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s7) {
			control(
				session.voice.isMuted ? "Unmute" : "Mic",
				symbol: session.voice.isMuted ? "mic.slash.fill" : "mic.fill",
				active: session.voice.isMuted
			) { session.voice.toggleMute() }
			control("Invite", symbol: "person.badge.plus") {
				showInvite = true
				Task {
					let source = APIChatsSource(
						client: environment.client, workspaceID: environment.workspaceId ?? "")
					actors = (try? await source.actors()) ?? []
				}
			}
			control("Captions", symbol: "captions.bubble", active: session.captionsOn) {
				session.captionsOn.toggle()
			}
			control("Pull up", symbol: "doc.text.magnifyingglass") { showPullUp = true }
			control("End", symbol: "phone.down.fill", destructive: true) {
				MaskinHaptics.play(.medium)
				session.end()
				onClose()
			}
		}
	}

	private func control(
		_ title: String, symbol: String, active: Bool = false, destructive: Bool = false,
		action: @escaping () -> Void
	) -> some View {
		Button(action: action) {
			VStack(spacing: MaskinSpace.s3) {
				Image(systemName: symbol)
					.font(.system(size: MaskinFontSize.t19, weight: .medium))
					.foregroundStyle(destructive ? MaskinSurface.onInverse : (active ? MaskinSurface.onInverse : MaskinColor.ink))
					.frame(width: buttonSize, height: buttonSize)
					.background(
						destructive ? MaskinColor.danger : (active ? MaskinSurface.inverse : MaskinSurface.fillStrong),
						in: Circle())
				Text(title).maskinText(.caption).foregroundStyle(MaskinColor.ink3)
			}
			.frame(maxWidth: .infinity)
		}
		.buttonStyle(.plain)
		.accessibilityLabel(title)
	}

	// MARK: Pickers

	private var invitePicker: some View {
		NavigationStack {
			List {
				let candidates = session.invitable(from: actors)
				if candidates.isEmpty {
					Text("No one else to invite.").foregroundStyle(MaskinColor.ink4)
				}
				ForEach(candidates) { actor in
					Button {
						Task { await session.invite(actor) }
						showInvite = false
					} label: {
						HStack(spacing: MaskinSpace.s7) {
							ActorAvatar(name: actor.participant.name, kind: .agent, size: MaskinSpace.s13 + MaskinSpace.s3, seed: actor.id)
							Text(actor.participant.name).maskinText(.body).foregroundStyle(MaskinColor.ink)
						}
					}
				}
			}
			.navigationTitle("Invite")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showInvite = false } } }
		}
		.presentationDetents([.medium, .large])
	}

	private var pullUpPicker: some View {
		SearchScreen(environment: environment) { result in
			guard result.kind == .object, let workspaceID = environment.workspaceId else { return }
			session.pullUp(
				title: result.title, url: DeepLink.object(workspaceId: workspaceID, id: result.entityId).universalURL())
			showPullUp = false
		}
		.presentationDetents([.medium, .large])
	}
}

extension LiveMeetingSession {
	/// The real microphone and speaker.
	static func devicePorts(
		send: @escaping @MainActor (String) -> Void
	) -> LiveVoiceController.Ports {
		#if os(iOS)
		let dictation = Dictation()
		return LiveVoiceController.Ports(
			startListening: { onText in
				await dictation.start(onText: onText)
				if case .unavailable(let message) = dictation.state {
					dictation.clearError()
					return message
				}
				return nil
			},
			stopListening: { dictation.stop() },
			isListening: { dictation.isListening },
			speak: { id, markdown in SpeechReader.shared.enqueue(markdown: markdown, id: id) },
			stopSpeaking: { SpeechReader.shared.stop() },
			isSpeaking: { SpeechReader.shared.speakingID != nil },
			send: send)
		#else
		return LiveVoiceController.Ports(
			startListening: { _ in "Live calls need an iPhone or iPad." },
			stopListening: {}, isListening: { false },
			speak: { _, _ in }, stopSpeaking: {}, isSpeaking: { false }, send: send)
		#endif
	}
}
