import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// What the wearer sees once, after signing in: what the app is for, then a first question to try.
/// There is no microphone screen: dictation is the system's, and asks for its own permission.
struct WatchFirstRun: View {
	/// Set when the wearer finishes or asks something; remembered across launches.
	@Binding var done: Bool
	let ask: @MainActor (String) -> Void

	static let doneKey = "maskin.watch.firstRunDone.v1"
	/// The sentence offered to say. The wearer taps the mic and may say anything.
	static let sample = "What is holding up the webhook fix?"

	@State private var step = 0

	var body: some View {
		Group {
			if step == 0 { welcome } else { tryIt }
		}
		.containerBackground(for: .navigation) { WatchBackdrop() }
	}

	private var welcome: some View {
		VStack(spacing: MaskinSpace.gapLoose) {
			MaskinLogoTile(size: WatchMetrics.badge * 2).accessibilityHidden(true)
			Text("Maskin on your wrist").font(WatchType.title()).foregroundStyle(MaskinColor.ink)
				.multilineTextAlignment(.center)
			Text("Ask, decide and listen.").font(WatchType.caption()).foregroundStyle(MaskinColor.ink3)
			Button { step = 1 } label: { WatchCapsule(title: "Continue", prominent: true, font: WatchType.action()) }
				.buttonStyle(.plain)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.padding(.horizontal, MaskinSpace.s1)
	}

	private var tryIt: some View {
		VStack(spacing: MaskinSpace.gapLoose) {
			Text("Try saying").font(WatchType.caption()).foregroundStyle(MaskinColor.ink4)
			Text("\u{201C}\(Self.sample)\u{201D}")
				.font(WatchType.question()).foregroundStyle(MaskinColor.ink)
				.multilineTextAlignment(.center)
			WatchDictate(accessibility: "Ask Chief of Staff", send: ask) {
				WatchMicGlyph(size: WatchMetrics.mic)
			}
			WatchQuietButton(title: "Not now") { done = true }
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.padding(.horizontal, MaskinSpace.s1)
	}
}
