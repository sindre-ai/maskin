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

/// "1 needs you" / "2 need you": the spec's lock-screen phrasing.
func needPhrase(_ n: Int) -> String {
	n == 1 ? "1 needs you" : "\(n) need you"
}

private struct CircularView: View {
	let state: WidgetState

	var body: some View {
		ZStack {
			switch state {
			case .content(let s) where !s.isEmpty:
				VStack(spacing: 0) {
					Text(s.needsCount > 99 ? "99+" : "\(s.needsCount)")
						.font(MaskinTypeface.sans(MaskinFontSize.t24, weight: MaskinFontWeight.w750, relativeTo: .title2))
						.minimumScaleFactor(0.6)
						.lineLimit(1)
					Text(s.needsCount == 1 ? "NEEDS YOU" : "NEED YOU")
						.font(MaskinTypeface.mono(MaskinFontSize.t9, weight: .semibold, relativeTo: .caption2))
						.minimumScaleFactor(0.7)
						.lineLimit(1)
				}
				.widgetAccentable()
				.accessibilityElement(children: .ignore)
				.accessibilityLabel(needPhrase(s.needsCount))
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
				Text("NEEDS YOU").font(MaskinTypeface.mono(MaskinFontSize.t10, weight: .semibold, relativeTo: .caption2))
			}
			.widgetAccentable()
			switch state {
			case .content(let s) where !s.isEmpty:
				if let top = s.top {
					// The next decision, two lines; redacted while the device is locked.
					Text(top.title)
						.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold, relativeTo: .footnote))
						.lineLimit(2)
						.privacySensitive()
					if s.needsCount > 1 {
						Text(needPhrase(s.needsCount)).font(MaskinTypeface.sans(MaskinFontSize.t11, relativeTo: .caption2)).lineLimit(1)
					}
				} else if s.unreadCount > 0 {
					Text(needPhrase(s.needsCount)).font(.headline).lineLimit(1)
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
			Label(needPhrase(s.needsCount), systemImage: "tray.full")
		case .content:
			Label("You\u{2019}re caught up", systemImage: "checkmark")
		case .signedOut:
			Label("Open Maskin to sign in", systemImage: "person.crop.circle")
		case .unavailable:
			Label("Maskin: can't refresh", systemImage: "wifi.slash")
		}
	}
}
