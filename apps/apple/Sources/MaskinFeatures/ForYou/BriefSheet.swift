import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// "Today's brief" as a dark pill at the top of the feed. Tapping it opens `BriefSheet`.
struct BriefPill: View {
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			HStack(spacing: MaskinSpace.s8) {
				Image(systemName: "text.alignleft")
					.font(.system(size: MaskinFontSize.t16, weight: .semibold))
					.frame(width: MaskinSpace.touchMin - MaskinSpace.s2, height: MaskinSpace.touchMin - MaskinSpace.s2)
					.background(ForYouPalette.briefPillForeground.opacity(0.14), in: RoundedRectangle(cornerRadius: MaskinRadius.panelXl - MaskinSpace.s1, style: .continuous))
					.accessibilityHidden(true)
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					Text("Today's brief").maskinText(.headline)
					Text("What changed while you were away").maskinText(.subhead).opacity(0.62)
				}
				Spacer(minLength: MaskinSpace.s3)
				Image(systemName: "chevron.right").opacity(0.45).accessibilityHidden(true)
			}
			.foregroundStyle(ForYouPalette.briefPillForeground)
			.padding(.horizontal, MaskinSpace.s9)
			.padding(.vertical, MaskinSpace.s8)
			.background(ForYouPalette.briefPill, in: RoundedRectangle(cornerRadius: MaskinRadius.hero + MaskinSpace.s2, style: .continuous))
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel("Today's brief")
		.accessibilityHint("Opens a summary of what changed")
	}
}

/// The brief as text. HOOK for later: audio playback ("Listen") belongs in this toolbar; it needs
/// the spoken-brief endpoint (`POST /api/briefing/spoken`) and a speech/audio player, neither of
/// which is wired yet.
struct BriefSheet: View {
	let state: BriefState
	let reload: () -> Void
	let done: () -> Void

	var body: some View {
		NavigationStack {
			ScrollView {
				content
					.padding(MaskinSpace.s9)
					.frame(maxWidth: 680, alignment: .leading)
					.frame(maxWidth: .infinity)
			}
			.background(MaskinSurface.grouped)
			.navigationTitle("Today's brief")
			#if os(iOS)
				.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .confirmationAction) { Button("Done", action: done) }
			}
		}
	}

	@ViewBuilder private var content: some View {
		switch state {
		case .idle, .loading:
			LoadingSkeleton(rows: 2)
		case .loaded(let brief):
			MarkdownContent(brief.markdown)
		case .failed(let message):
			EmptyState(symbol: "exclamationmark.triangle", title: "Couldn't load the brief", message: message) {
				Button("Try again", action: reload).buttonStyle(.secondaryAction)
			}
		}
	}
}
