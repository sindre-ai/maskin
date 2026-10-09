import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Lock-screen widgets. The circular and inline ones are count-only. The rectangular one shows the
/// top ask and what the agent suggests, both marked `.privacySensitive()` so the system redacts
/// them while the device is locked (or always, per the user's lock-screen privacy setting).
enum LockKind: Sendable {
	case circular, rectangular, inline
}

struct LockScreenView: View {
	let entry: MaskinWidgetEntry
	let kind: LockKind

	var body: some View {
		switch kind {
		case .circular: CircularView(state: entry.state)
		case .inline: InlineView(state: entry.state)
		case .rectangular: RectangularView(state: entry.state)
		}
	}
}

private func decisionPhrase(_ n: Int) -> String {
	n == 1 ? "1 decision needs you" : "\(n) decisions need you"
}

/// "Forge suggests Ship it", or "Suggested: Ship it" when the sender could not be resolved.
private func suggestionLine(agent: String?, label: String) -> String {
	agent.map { "\($0) suggests \(label)" } ?? "Suggested: \(label)"
}

private struct CircularView: View {
	let state: WidgetState

	var body: some View {
		ZStack {
			switch state {
			case .content(let s) where !s.isEmpty:
				VStack(spacing: 0) {
					Text(s.needsCount > 99 ? "99+" : "\(s.needsCount)")
						.font(.system(size: 24, weight: .bold, design: .rounded))
						.minimumScaleFactor(0.6)
						.lineLimit(1)
					Image(systemName: "tray.full")
						.font(.system(size: 10, weight: .semibold))
				}
				.widgetAccentable()
				.accessibilityElement(children: .ignore)
				.accessibilityLabel(decisionPhrase(s.needsCount))
			case .content(let s):
				Image(systemName: s.unreadCount > 0 ? "bell.badge" : "checkmark")
					.font(.system(size: 22, weight: .semibold))
					.widgetAccentable()
					.accessibilityLabel(s.unreadCount > 0 ? "\(s.unreadLabel) unread" : "Nothing needs you")
			case .signedOut, .unavailable:
				MaskinMark()
					.stroke(style: MaskinMark.strokeStyle(side: 22))
					.frame(width: 22, height: 22)
					.widgetAccentable()
					.accessibilityLabel("Maskin")
			}
		}
	}
}

private struct RectangularView: View {
	let state: WidgetState

	var body: some View {
		VStack(alignment: .leading, spacing: 1) {
			HStack(spacing: 4) {
				MaskinMark()
					.stroke(style: MaskinMark.strokeStyle(side: 11))
					.frame(width: 11, height: 11)
				Text("MASKIN").font(.system(size: 10, weight: .semibold, design: .monospaced))
			}
			.widgetAccentable()
			switch state {
			case .content(let s) where !s.isEmpty:
				Text(decisionPhrase(s.needsCount)).font(.headline).lineLimit(1).minimumScaleFactor(0.8)
				if let top = s.top {
					Text(top.title).font(.caption).lineLimit(1).privacySensitive()
					if let suggestion = top.recommendedLabel {
						Text(suggestionLine(agent: top.agentName, label: suggestion))
							.font(.caption2).lineLimit(1).privacySensitive()
					}
				} else if s.unreadCount > 0 {
					Text("\(s.unreadLabel) unread").font(.caption)
				}
			case .content(let s):
				Text("Nothing needs you").font(.headline)
				if s.unreadCount > 0 { Text("\(s.unreadLabel) unread").font(.caption) }
			case .signedOut:
				Text("Open Maskin to sign in").font(.headline).lineLimit(2)
			case .unavailable:
				Text("Can't refresh").font(.headline)
				Text("Open Maskin").font(.caption)
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.accessibilityElement(children: .combine)
	}
}

private struct InlineView: View {
	let state: WidgetState

	var body: some View {
		switch state {
		case .content(let s) where !s.isEmpty:
			Label("Maskin: \(s.needsCount) need you", systemImage: "tray.full")
		case .content:
			Label("Maskin: all clear", systemImage: "checkmark")
		case .signedOut:
			Label("Open Maskin to sign in", systemImage: "person.crop.circle")
		case .unavailable:
			Label("Maskin: can't refresh", systemImage: "wifi.slash")
		}
	}
}
