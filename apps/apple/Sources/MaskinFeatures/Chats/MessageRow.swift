import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// A day separator or system divider line.
struct ThreadDivider: View {
	let label: String
	var body: some View {
		HStack(spacing: MaskinSpace.s5) {
			line
			Text(label).maskinText(.caption).foregroundStyle(MaskinColor.ink4).lineLimit(1)
			line
		}
		.padding(.vertical, MaskinSpace.s4)
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isHeader)
	}

	private var line: some View {
		Rectangle().fill(MaskinSurface.line).frame(height: 1)
	}
}

/// Files a message cites (read-only chips: name and size, never an id).
struct MessageAttachments: View {
	let attachments: [ChatAttachmentRef]
	var alignment: HorizontalAlignment = .leading

	var body: some View {
		if !attachments.isEmpty {
			ChipFlow {
				ForEach(attachments) { file in
					HStack(spacing: MaskinSpace.s3) {
						Image(systemName: (file.mimeType ?? "").hasPrefix("image/") ? "photo" : "doc")
							.foregroundStyle(MaskinColor.ink3).accessibilityHidden(true)
						Text(file.name ?? "Attachment").maskinText(.caption).foregroundStyle(MaskinColor.ink)
							.lineLimit(1).truncationMode(.middle)
						if let size = ChatByteFormat.string(file.sizeBytes) {
							Text(size).maskinText(.microLabel).foregroundStyle(MaskinColor.ink4)
						}
					}
					.padding(.horizontal, MaskinSpace.s5)
					.frame(minHeight: MaskinSpace.s12 + MaskinSpace.s4, alignment: .leading)
					.frame(maxWidth: 260, alignment: .leading)
					.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.btnLg, style: .continuous))
					.overlay(
						RoundedRectangle(cornerRadius: MaskinRadius.btnLg, style: .continuous)
							.strokeBorder(MaskinSurface.line, lineWidth: 1))
					.accessibilityElement(children: .combine)
					.accessibilityLabel("Attachment \(file.name ?? "file")")
				}
			}
		}
	}
}

/// "You mentioned Relay" / "Mentioned Relay, Sam".
struct MentionLine: View {
	let names: [String]
	let isOwn: Bool

	var body: some View {
		if !names.isEmpty {
			HStack(spacing: MaskinSpace.s2) {
				Image(systemName: "at").accessibilityHidden(true)
				Text("\(isOwn ? "You mentioned" : "Mentioned") \(names.joined(separator: ", "))")
					.lineLimit(2)
			}
			.maskinText(.caption)
			.foregroundStyle(MaskinColor.accentFgStrong)
			.accessibilityElement(children: .combine)
		}
	}
}

/// One message. Own messages are a right-aligned inverse plate; everyone else's (people and
/// agents) sit left on the page with an avatar, agents rendered as markdown. An agent's question
/// renders as tappable options under its text.
struct MessageRow: View {
	let message: ChatMessage
	let isOwn: Bool
	let showsAuthor: Bool
	var mentionNames: [String] = []
	/// What the human picked, once this question has been answered.
	var questionAnswers: [ChatQuestionAnswer.Answer]?
	let onRetrySend: () -> Void
	let onDiscard: () -> Void
	let onRetryAgent: () -> Void
	var onAnswer: ([Int: [String]]) -> Void = { _ in }

	var body: some View {
		Group {
			if isOwn { own } else { other }
		}
		.contextMenu { actions }
		.accessibilityActions {
			if !message.content.isEmpty {
				Button("Copy message") { Clipboard.copy(message.content) }
			}
			if message.isFailed {
				Button("Retry sending", action: onRetrySend)
				Button("Delete message", action: onDiscard)
			}
			if message.isErrorReply { Button("Try again", action: onRetryAgent) }
			if canReadAloud { Button(readAloudTitle, action: toggleReadAloud) }
		}
	}

	// MARK: Read aloud

	private var canReadAloud: Bool { !message.content.isEmpty && !message.isFailed }
	private var isReading: Bool { SpeechReader.shared.isSpeaking(message.id) }
	private var readAloudTitle: String { isReading ? "Stop reading" : "Read aloud" }

	private func toggleReadAloud() {
		if isReading {
			SpeechReader.shared.stop()
		} else {
			SpeechReader.shared.speak(markdown: message.content, id: message.id)
		}
	}

	// MARK: Actions

	@ViewBuilder
	private var actions: some View {
		if !message.content.isEmpty {
			Button { Clipboard.copy(message.content) } label: { Label("Copy", systemImage: "doc.on.doc") }
			ShareLink(item: message.content) { Label("Share", systemImage: "square.and.arrow.up") }
			if canReadAloud {
				Button(action: toggleReadAloud) {
					Label(readAloudTitle, systemImage: isReading ? "speaker.slash" : "speaker.wave.2")
				}
			}
		}
		if message.isFailed {
			Button(action: onRetrySend) { Label("Retry", systemImage: "arrow.clockwise") }
			Button(role: .destructive, action: onDiscard) { Label("Delete", systemImage: "trash") }
		}
		if message.isErrorReply {
			Button(action: onRetryAgent) { Label("Try again", systemImage: "arrow.clockwise") }
		}
	}

	// MARK: Own

	private var own: some View {
		VStack(alignment: .trailing, spacing: MaskinSpace.s2) {
			Text(message.content)
				.maskinText(.body)
				.foregroundStyle(MaskinSurface.onInverse)
				.multilineTextAlignment(.leading)
				.padding(.horizontal, MaskinSpace.s8)
				.padding(.vertical, MaskinSpace.s6)
				.background(
					MaskinSurface.inverse,
					in: UnevenRoundedRectangle(
						topLeadingRadius: MaskinRadius.hero, bottomLeadingRadius: MaskinRadius.hero,
						bottomTrailingRadius: MaskinRadius.tag2, topTrailingRadius: MaskinRadius.hero,
						style: .continuous)
				)
				.opacity(message.isPending && !message.isFailed ? 0.6 : 1)
				.overlay(alignment: .topLeading) {
					if message.isFailed {
						UnevenRoundedRectangle(
							topLeadingRadius: MaskinRadius.hero, bottomLeadingRadius: MaskinRadius.hero,
							bottomTrailingRadius: MaskinRadius.tag2, topTrailingRadius: MaskinRadius.hero,
							style: .continuous
						)
						.strokeBorder(MaskinColor.danger, lineWidth: 1.5)
					}
				}
				.textSelection(.enabled)
			MessageAttachments(attachments: message.attachments, alignment: .trailing)
			MentionLine(names: mentionNames, isOwn: true)
			statusLine
		}
		.frame(maxWidth: .infinity, alignment: .trailing)
		.padding(.leading, MaskinSpace.s14 * 2)
		.accessibilityElement(children: .contain)
		.accessibilityLabel("You: \(message.content)")
	}

	@ViewBuilder
	private var statusLine: some View {
		switch message.status {
		case .sent:
			EmptyView()
		case .sending:
			Text("Sending…").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
		case .waiting(let reason):
			HStack(spacing: MaskinSpace.s2) {
				Image(systemName: "clock").accessibilityHidden(true)
				Text("Queued · \(reason)")
			}
			.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
		case .failed(let reason):
			VStack(alignment: .trailing, spacing: 0) {
				HStack(spacing: MaskinSpace.s4) {
					Image(systemName: "exclamationmark.circle.fill").foregroundStyle(MaskinColor.danger)
						.accessibilityHidden(true)
					Text("Not sent").foregroundStyle(MaskinColor.danger)
					Button("Retry", action: onRetrySend).buttonStyle(.plain)
						.foregroundStyle(MaskinColor.accentFgStrong)
						.frame(minWidth: MaskinSpace.touchMin, minHeight: MaskinSpace.touchMin)
						.contentShape(Rectangle())
						.accessibilityHint(reason)
					Button("Delete", role: .destructive, action: onDiscard).buttonStyle(.plain)
						.foregroundStyle(MaskinColor.ink4)
						.frame(minWidth: MaskinSpace.touchMin, minHeight: MaskinSpace.touchMin)
						.contentShape(Rectangle())
				}
				Text(reason).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
					.multilineTextAlignment(.trailing)
			}
			.maskinText(.caption)
		}
	}

	// MARK: Others

	private var other: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s6) {
			if showsAuthor {
				ActorAvatar(
					name: message.actorName, kind: message.author == .agent ? .agent : .human,
					size: MaskinSpace.s12 + MaskinSpace.s4, seed: message.actorID)
			} else {
				Color.clear.frame(width: MaskinSpace.s12 + MaskinSpace.s4, height: 1)
			}
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				if showsAuthor {
					HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
						Text(message.actorName).maskinText(.subhead).fontWeight(.semibold)
							.foregroundStyle(MaskinColor.ink)
						if message.author == .agent {
							Text("AGENT").maskinText(.microLabel).foregroundStyle(MaskinColor.ink5)
								.accessibilityHidden(true)
						}
						RelativeTime(message.createdAt, style: .clock)
							.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
					}
				}
				content
				if !message.questions.isEmpty {
					QuestionOptionsView(
						questions: message.questions, answers: questionAnswers, onSubmit: onAnswer)
				}
				MessageAttachments(attachments: message.attachments)
				MentionLine(names: mentionNames, isOwn: false)
				if message.isErrorReply {
					Button {
						onRetryAgent()
					} label: {
						Label("Try again", systemImage: "arrow.clockwise")
					}
					.buttonStyle(SecondaryActionButtonStyle())
					.fixedSize(horizontal: true, vertical: false)
					.padding(.top, MaskinSpace.s2)
				}
			}
			Spacer(minLength: MaskinSpace.s9)
		}
		.accessibilityElement(children: .contain)
	}

	@ViewBuilder
	private var content: some View {
		if message.author == .agent {
			MarkdownContent(message.content).textSelection(.enabled)
		} else {
			Text(message.content).maskinText(.body).foregroundStyle(MaskinColor.ink2).textSelection(.enabled)
		}
	}
}

enum Clipboard {
	static func copy(_ string: String) {
		#if canImport(UIKit)
		UIPasteboard.general.string = string
		#elseif canImport(AppKit)
		NSPasteboard.general.clearContents()
		NSPasteboard.general.setString(string, forType: .string)
		#endif
	}
}

/// "Relay is working · Reading the brief" with animated dots (static under Reduce Motion) and,
/// for a live run, a Stop control.
struct WorkingIndicator: View {
	let agent: ChatParticipant
	var activity: String?
	var onStop: (() -> Void)?
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	var body: some View {
		HStack(spacing: MaskinSpace.s5) {
			ActorAvatar(name: agent.name, kind: .agent, size: MaskinSpace.s12 + MaskinSpace.s4, seed: agent.id, working: true)
			VStack(alignment: .leading, spacing: 0) {
				HStack(spacing: MaskinSpace.s4) {
					Text("\(agent.name) is working").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
					dots
				}
				if let activity, !activity.isEmpty {
					Text(activity).maskinText(.caption).foregroundStyle(MaskinColor.ink5).lineLimit(2)
				}
			}
			Spacer(minLength: 0)
			if let onStop {
				Button(action: onStop) {
					Text("Stop").maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
						.padding(.horizontal, MaskinSpace.s7)
						.frame(minHeight: MaskinSpace.touchMin)
						.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
				.accessibilityLabel("Stop \(agent.name)")
			}
		}
		.accessibilityElement(children: .combine)
	}

	private var dots: some View {
		HStack(spacing: MaskinSpace.s1 + MaskinSpace.s1) {
			ForEach(0..<3, id: \.self) { i in
				Circle().fill(MaskinColor.ink5).frame(width: MaskinSpace.s3, height: MaskinSpace.s3)
					.phaseAnimator([0.35, 1.0], trigger: reduceMotion) { view, phase in
						view.opacity(reduceMotion ? 0.7 : phase)
					} animation: { _ in
						.easeInOut(duration: 0.6).delay(Double(i) * 0.15)
					}
			}
		}
		.accessibilityHidden(true)
	}
}

/// An agent that paused (or whose run was suspended): offer to continue it.
struct ResumeBanner: View {
	let agent: ChatParticipant
	let onResume: () -> Void

	var body: some View {
		HStack(spacing: MaskinSpace.s6) {
			Image(systemName: "pause.circle.fill").foregroundStyle(MaskinColor.ink4).accessibilityHidden(true)
			Text("\(agent.name) is paused").maskinText(.subhead).foregroundStyle(MaskinColor.ink2)
			Spacer(minLength: 0)
			Button(action: onResume) {
				Text("Resume").maskinText(.subhead).fontWeight(.semibold)
					.foregroundStyle(MaskinSurface.onInverse)
					.padding(.horizontal, MaskinSpace.s8)
					.frame(minHeight: MaskinSpace.touchMin - MaskinSpace.s3)
					.background(MaskinSurface.inverse, in: Capsule())
			}
			.buttonStyle(.plain)
			.accessibilityLabel("Resume \(agent.name)")
		}
		.padding(.horizontal, MaskinSpace.s8)
		.padding(.vertical, MaskinSpace.s4)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.accessibilityElement(children: .contain)
	}
}
