import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Where Home can send the wearer.
enum WatchRoute: Hashable {
	case decisions
	case conversation
}

/// A tap target that opens the system's dictation and keyboard, and hands back what was said. The
/// label is what the wearer sees; a transparent text field lies over it, so one tap anywhere on the
/// label starts dictating. (Live voice, where the watch listens by itself, is a later step.)
struct WatchDictate<Label: View>: View {
	let accessibility: String
	let send: @MainActor (String) -> Void
	@ViewBuilder let label: () -> Label
	@State private var draft = ""

	var body: some View {
		label()
			.overlay {
				TextField("", text: $draft)
					.opacity(0.02)
					.accessibilityLabel(accessibility)
					.onSubmit {
						let text = draft
						draft = ""
						send(text)
					}
			}
	}
}

/// Home: the Chief of Staff one tap away by voice, and what waits on the wearer one tap away under it.
struct WatchAskHome: View {
	let store: ForYouStore?
	let watch: MaskinWatchStore
	let ask: @MainActor (String) -> Void

	private var count: Int {
		if let store, !store.entries.isEmpty { return store.needsCount }
		return watch.needsCount
	}

	var body: some View {
		VStack(spacing: MaskinSpace.s3) {
			Text("Chief of Staff").font(WatchType.caption()).foregroundStyle(MaskinColor.ink4)
			WatchDictate(accessibility: "Ask Chief of Staff", send: ask) {
				WatchMicGlyph(size: WatchMetrics.mic)
			}
			Text("Ask anything").font(WatchType.action()).foregroundStyle(MaskinColor.ink)
			NavigationLink(value: WatchRoute.decisions) {
				Text(WatchConversation.pill(count: count))
					.font(WatchType.row()).foregroundStyle(MaskinColor.ink)
					.frame(maxWidth: .infinity, minHeight: WatchMetrics.target)
					.background(MaskinSurface.fillStrong, in: Capsule())
					.contentShape(Capsule())
			}
			.buttonStyle(.plain)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.padding(.horizontal, MaskinSpace.s1)
	}
}

/// The microphone button: an inverse circle with a capsule for a glyph.
struct WatchMicGlyph: View {
	let size: CGFloat

	var body: some View {
		Circle()
			.fill(MaskinSurface.inverse)
			.frame(width: size, height: size)
			.overlay {
				Capsule()
					.fill(MaskinSurface.onInverse)
					.frame(width: WatchMetrics.micGlyph.width, height: WatchMetrics.micGlyph.height)
			}
			.contentShape(Circle())
	}
}

/// The conversation, whichever turn it is on: thinking, the answer, or a problem.
struct WatchConversationScreen: View {
	let conversation: WatchConversationStore
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		Group {
			switch conversation.phase {
			case .idle:
				// Done was tapped: the screen is on its way out.
				Color.clear
			case .thinking:
				WatchThinking(conversation: conversation)
			case .answered:
				if let answer = conversation.answer {
					WatchAnswer(conversation: conversation, answer: answer)
				}
			case .failed(let message):
				WatchWeakSignal(message: message, conversation: conversation)
			}
		}
		.containerBackground(for: .navigation) { WatchBackdrop() }
		.navigationBarBackButtonHidden(conversation.phase == .thinking)
		.onChange(of: conversation.phase) { _, phase in
			if phase == .idle { dismiss() }
		}
	}
}

/// Three dots while the Chief of Staff works, and what was asked underneath.
private struct WatchThinking: View {
	let conversation: WatchConversationStore
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var lit = false

	var body: some View {
		VStack(spacing: MaskinSpace.gapLoose) {
			HStack(spacing: MaskinSpace.gapDefault) {
				ForEach(0..<3, id: \.self) { index in
					Circle()
						.fill(MaskinColor.sigHi)
						.frame(width: WatchMetrics.dot, height: WatchMetrics.dot)
						.opacity(reduceMotion ? 1 : (lit ? 1 : 0.25))
						.animation(
							reduceMotion
								? nil : .easeInOut(duration: 1).repeatForever().delay(Double(index) * 0.2),
							value: lit)
				}
			}
			.accessibilityHidden(true)
			Text(conversation.isWaitingToSend ? "QUEUED" : "THINKING")
				.font(WatchType.microMono()).tracking(0.8)
				.foregroundStyle(MaskinColor.ink4)
			Text(conversation.heard)
				.font(WatchType.caption()).foregroundStyle(MaskinColor.ink3)
				.multilineTextAlignment(.center).lineLimit(3)
			if conversation.isWaitingToSend {
				Text("Sends when you're back.").font(WatchType.caption()).foregroundStyle(MaskinColor.sigHi)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.onAppear { lit = true }
	}
}

/// What the Chief of Staff said: spoken when the sound would go to headphones, always readable.
private struct WatchAnswer: View {
	let conversation: WatchConversationStore
	let answer: ChatMessage
	@State private var speaker = BriefingSpeaker(title: "Chief of Staff")
	@State private var muted = false
	/// Speech is only for headphones: a reply read out loud on a wrist speaker is read out loud to
	/// the room.
	@State private var speechAllowed = BriefingSpeaker.outputIsHeadphones

	private var text: String { WatchBriefingText.plain(answer.content) }

	private var othersWorking: [ChatParticipant] {
		guard let thread = conversation.thread else { return [] }
		return thread.chat.presences().map(\.agent).filter {
			$0.id != thread.chiefID && $0.id != thread.chat.currentActorID
		}
	}

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				HStack(spacing: MaskinSpace.gapDefault) {
					WatchTile(name: "Chief of Staff")
					Text("Chief of Staff").font(WatchType.name()).foregroundStyle(MaskinColor.ink).lineLimit(1)
				}
				Text(WatchConversation.stateLabel(speaking: speaker.isSpeaking, muted: muted, speechAllowed: speechAllowed))
					.font(WatchType.microMono()).tracking(0.8)
					.foregroundStyle(MaskinColor.sigHi)
				Text(text).font(WatchType.body()).foregroundStyle(MaskinColor.ink)
				if !othersWorking.isEmpty { workingChip }
				controls
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.horizontal, MaskinSpace.s1)
		}
		.task(id: answer.id) {
			muted = false
			speechAllowed = BriefingSpeaker.outputIsHeadphones
			if speechAllowed { speaker.speak(text) }
		}
		.onDisappear { speaker.stop() }
	}

	/// Others are working on it: tap to see who and doing what.
	private var workingChip: some View {
		NavigationLink {
			WatchBehindTheScenes(conversation: conversation)
		} label: {
			HStack(spacing: MaskinSpace.gapDefault) {
				HStack(spacing: -MaskinSpace.s3) {
					WatchTile(name: "Chief of Staff")
					ForEach(othersWorking.prefix(2)) { agent in WatchTile(name: agent.name) }
				}
				Text("Working").font(WatchType.row()).foregroundStyle(MaskinColor.ink)
				Spacer(minLength: 0)
			}
			.padding(.horizontal, MaskinSpace.s7)
			.frame(maxWidth: .infinity, minHeight: WatchMetrics.target)
			.background(MaskinSurface.fillStrong, in: Capsule())
			.contentShape(Capsule())
		}
		.buttonStyle(.plain)
	}

	@ViewBuilder
	private var controls: some View {
		WatchDictate(accessibility: "Reply to Chief of Staff", send: conversation.ask) {
			WatchCapsule(title: "Reply", prominent: true, font: WatchType.action())
		}
		if speechAllowed {
			Button {
				if speaker.isSpeaking {
					speaker.stop()
					muted = true
				} else {
					muted = false
					speaker.speak(text)
				}
			} label: {
				WatchCapsule(title: speaker.isSpeaking ? "Stop" : (muted ? "Resume" : "Read aloud"))
			}
			.buttonStyle(.plain)
		}
		if WatchConversation.asksQuestion(answer.content) {
			NavigationLink {
				WatchQuickReplies(question: text, conversation: conversation)
			} label: { WatchCapsule(title: "Quick replies") }
				.buttonStyle(.plain)
		}
		WatchQuietButton(title: "Done") { conversation.reset() }
	}
}

/// One-tap answers to a question the Chief of Staff asked, and Dictate for anything else.
private struct WatchQuickReplies: View {
	let question: String
	let conversation: WatchConversationStore
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.gapDefault) {
				Text(question).font(WatchType.caption()).foregroundStyle(MaskinColor.ink3).lineLimit(3)
				LazyVGrid(
					columns: [GridItem(.flexible(), spacing: MaskinSpace.gapDefault), GridItem(.flexible())],
					spacing: MaskinSpace.gapDefault
				) {
					ForEach(Array(WatchChat.quickReplies.enumerated()), id: \.offset) { index, reply in
						Button {
							conversation.ask(reply)
							dismiss()
						} label: { WatchCapsule(title: reply, prominent: index == 0, font: WatchType.row()) }
							.buttonStyle(.plain)
					}
				}
				WatchDictate(
					accessibility: "Dictate a reply",
					send: { text in
						conversation.ask(text)
						dismiss()
					}
				) { WatchCapsule(title: "Dictate") }
			}
			.padding(.horizontal, MaskinSpace.s1)
		}
		.containerBackground(for: .navigation) { WatchBackdrop() }
	}
}

/// The agents working on the wearer's behalf, read only, with a way to speak to the Chief of Staff.
private struct WatchBehindTheScenes: View {
	let conversation: WatchConversationStore
	@Environment(\.dismiss) private var dismiss

	private struct Row: Identifiable {
		let agent: ChatParticipant
		let status: String
		var id: String { agent.id }
	}

	private var rows: [Row] {
		guard let thread = conversation.thread else { return [] }
		return thread.chat.presences()
			.filter { $0.agent.id != thread.chiefID && $0.agent.id != thread.chat.currentActorID }
			.map { item in
				Row(
					agent: item.agent,
					status: WatchConversation.statusLine(
						activity: thread.chat.activity(for: item.agent.id), presence: item.presence))
			}
	}

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.gapDefault) {
				Text("Behind the scenes").font(WatchType.action()).foregroundStyle(MaskinColor.ink)
				if rows.isEmpty {
					Text("Nothing is running right now.").font(WatchType.caption()).foregroundStyle(MaskinColor.ink3)
				}
				ForEach(rows) { row in
					HStack(spacing: MaskinSpace.gapLoose) {
						WatchTile(name: row.agent.name)
						VStack(alignment: .leading, spacing: MaskinSpace.s1) {
							Text(row.agent.name).font(WatchType.row()).foregroundStyle(MaskinColor.ink).lineLimit(1)
							Text(row.status).font(WatchType.caption()).foregroundStyle(MaskinColor.ink4).lineLimit(2)
						}
						Spacer(minLength: 0)
					}
					.padding(.horizontal, MaskinSpace.s8).padding(.vertical, MaskinSpace.s7)
					.frame(maxWidth: .infinity, minHeight: WatchMetrics.target, alignment: .leading)
					.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
				}
				WatchDictate(
					accessibility: "Tell Chief of Staff",
					send: { text in
						conversation.ask(text)
						dismiss()
					}
				) { WatchCapsule(title: "Tell Chief of Staff", prominent: true) }
			}
			.padding(.horizontal, MaskinSpace.s1)
		}
		.containerBackground(for: .navigation) { WatchBackdrop() }
	}
}

/// The Chief of Staff couldn't be reached or didn't answer in time.
private struct WatchWeakSignal: View {
	let message: String
	let conversation: WatchConversationStore

	var body: some View {
		VStack(spacing: MaskinSpace.gapDefault) {
			Text("!")
				.font(WatchType.action()).foregroundStyle(MaskinColor.ink3)
				.frame(width: WatchMetrics.alert, height: WatchMetrics.alert)
				.overlay(Circle().strokeBorder(MaskinColor.ink4, lineWidth: WatchMetrics.ringStroke))
				.accessibilityHidden(true)
			Text("Couldn't answer").font(WatchType.question()).foregroundStyle(MaskinColor.ink)
			Text(message).font(WatchType.caption()).foregroundStyle(MaskinColor.ink3).multilineTextAlignment(.center)
			Button { conversation.ask(conversation.heard) } label: { WatchCapsule(title: "Try again", prominent: true) }
				.buttonStyle(.plain)
			WatchQuietButton(title: "Done") { conversation.reset() }
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.padding(.horizontal, MaskinSpace.s1)
	}
}
