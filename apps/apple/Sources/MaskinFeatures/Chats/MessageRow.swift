import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

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

/// One message. Own messages are a right-aligned inverse plate; everyone else's (people and
/// agents) sit left on the page with an avatar, agents rendered as markdown.
struct MessageRow: View {
	let message: ChatMessage
	let isOwn: Bool
	let showsAuthor: Bool
	let onRetrySend: () -> Void
	let onDiscard: () -> Void
	let onRetryAgent: () -> Void

	var body: some View {
		if isOwn { own } else { other }
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
				.opacity(message.status == .sending ? 0.6 : 1)
				.textSelection(.enabled)
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
		case .failed(let reason):
			HStack(spacing: MaskinSpace.s4) {
				Image(systemName: "exclamationmark.circle.fill").foregroundStyle(MaskinColor.danger)
					.accessibilityHidden(true)
				Text("Not sent").foregroundStyle(MaskinColor.danger)
				Button("Retry", action: onRetrySend).buttonStyle(.plain).foregroundStyle(MaskinColor.accentFgStrong)
					.accessibilityHint(reason)
				Button("Delete", role: .destructive, action: onDiscard).buttonStyle(.plain)
					.foregroundStyle(MaskinColor.ink4)
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

/// "Relay is working…" with animated dots; static under Reduce Motion.
struct WorkingIndicator: View {
	let agents: [ChatParticipant]
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	var body: some View {
		HStack(spacing: MaskinSpace.s5) {
			if let first = agents.first {
				ActorAvatar(name: first.name, kind: .agent, size: MaskinSpace.s12 + MaskinSpace.s4, seed: first.id, working: true)
			}
			Text(label).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			dots
			Spacer(minLength: 0)
		}
		.accessibilityElement(children: .ignore)
		.accessibilityLabel(label)
	}

	private var label: String {
		switch agents.count {
		case 0: "Working"
		case 1: "\(agents[0].name) is working"
		case 2: "\(agents[0].name) and \(agents[1].name) are working"
		default: "\(agents.count) agents are working"
		}
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
