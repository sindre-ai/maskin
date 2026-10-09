import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The full-screen brief: a sequence of slides (the daily briefing as text, then each loop's HTML
/// pages) under a wrapper that owns the pacing. Segmented progress on top, tap the right or left
/// half to move, hold to pause, swipe down or the close button to leave. Each slide is marked
/// seen as it is reached. The slides themselves render through the same sandboxed web view as
/// every other presented page.
struct BriefViewer: View {
	let environment: AppEnvironment
	let stories: StoriesStore
	let sequence: BriefSequence
	let close: () -> Void

	@State private var playback: BriefPlayback
	@State private var fullPage: LoopOutput?
	@State private var dragY: CGFloat = 0
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
	@Environment(\.scenePhase) private var scenePhase
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	private static let swipeToClose: CGFloat = 120

	init(environment: AppEnvironment, stories: StoriesStore, sequence: BriefSequence, close: @escaping () -> Void) {
		self.environment = environment
		self.stories = stories
		self.sequence = sequence
		self.close = close
		_playback = State(
			initialValue: BriefPlayback(
				durations: sequence.slides.map(BriefSequence.duration(of:)), startIndex: sequence.startIndex))
	}

	private var card: StoryCard? {
		sequence.slides.indices.contains(playback.index) ? sequence.slides[playback.index] : nil
	}

	var body: some View {
		GeometryReader { proxy in content(proxy) }
	}

	private func content(_ proxy: GeometryProxy) -> some View {
		ZStack {
			MaskinGradient.briefViewer.ignoresSafeArea()
			if let card {
				VStack(spacing: MaskinSpace.s7) {
					header(card)
					slide(card)
						.contentShape(Rectangle())
						.gesture(taps(width: proxy.size.width))
						.onLongPressGesture(minimumDuration: 0.2, perform: {}, onPressingChanged: { pressing in
							if pressing { playback.hold() } else { playback.release() }
						})
						.accessibilityHidden(true)
					actions(card)
				}
				.padding(.horizontal, MaskinSpace.s9)
				.padding(.vertical, MaskinSpace.s7)
			}
		}
		.offset(y: dragY)
		.background { arrowKeys }
		.simultaneousGesture(swipeDown)
		.preferredColorScheme(.dark)
		.accessibilityElement(children: .contain)
		.accessibilityAction(.escape, close)
		.task(id: autoAdvances) { await runClock() }
		.onChange(of: playback.index, initial: true) { _, _ in
			guard let card else { return }
			stories.markSeen(card)
			AccessibilityNotification.Announcement("\(playback.position). \(card.headline)").post()
		}
		.onChange(of: playback.isFinished) { _, finished in if finished { close() } }
		.onChange(of: fullPage) { _, page in
			if page == nil { playback.release() } else { playback.hold() }
		}
		.onChange(of: scenePhase) { _, phase in
			if phase == .active { playback.release() } else { playback.hold() }
		}
		.sheet(item: $fullPage) { output in
			OutcomePresenter(environment: environment, output: output, sourceName: card?.unit ?? "")
		}
	}

	// MARK: Pacing

	private var autoAdvances: Bool { !reduceMotion && !voiceOver }

	/// Feeds real elapsed time to the state machine. Off entirely when slides only change on a tap.
	private func runClock() async {
		playback.autoAdvances = autoAdvances
		guard autoAdvances else { return }
		let clock = ContinuousClock()
		var last = clock.now
		while !Task.isCancelled {
			try? await Task.sleep(for: .milliseconds(50))
			let now = clock.now
			let elapsed = last.duration(to: now)
			last = now
			playback.tick(Double(elapsed.components.seconds) + Double(elapsed.components.attoseconds) / 1e18)
		}
	}

	// MARK: Keyboard

	/// Left and right arrows move between slides for a hardware keyboard (iPad, Mac); Esc is the
	/// Close button's cancel shortcut. Zero-size so they take no layout and VoiceOver skips them.
	private var arrowKeys: some View {
		HStack {
			Button("Previous") { playback.previous() }.keyboardShortcut(.leftArrow, modifiers: [])
			Button("Next") { playback.next() }.keyboardShortcut(.rightArrow, modifiers: [])
		}
		.frame(width: 0, height: 0)
		.opacity(0)
		.accessibilityHidden(true)
	}

	// MARK: Gestures

	private func taps(width: CGFloat) -> some Gesture {
		SpatialTapGesture().onEnded { value in
			// The slide is inset equally on both sides, so the screen's midpoint is the slide's.
			if value.location.x < (width - 2 * MaskinSpace.s9) / 2 { playback.previous() } else { playback.next() }
		}
	}

	private var swipeDown: some Gesture {
		DragGesture(minimumDistance: 24)
			.onChanged { value in
				guard value.translation.height > 0, abs(value.translation.height) > abs(value.translation.width)
				else { return }
				playback.hold()
				if !reduceMotion { dragY = value.translation.height }
			}
			.onEnded { value in
				if value.translation.height > Self.swipeToClose,
					abs(value.translation.height) > abs(value.translation.width)
				{
					close()
				} else {
					withAnimation(reduceMotion ? nil : MaskinMotion.spring) { dragY = 0 }
					playback.release()
				}
			}
	}

	// MARK: Chrome

	private func header(_ card: StoryCard) -> some View {
		VStack(spacing: MaskinSpace.s5) {
			HStack(spacing: MaskinSpace.s2) {
				ForEach(0..<playback.count, id: \.self) { segment in
					ProgressSegment(fill: playback.fill(ofSegment: segment))
				}
			}
			.frame(height: MaskinSpace.s2)
			HStack(spacing: MaskinSpace.s5) {
				if card.loopID == nil {
					ChiefOfStaffTile(size: MaskinSpace.s14 + MaskinSpace.s3)
				} else {
					ActorAvatar(name: card.unit, kind: .agent, size: MaskinSpace.s14 + MaskinSpace.s3)
				}
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					Text(card.headline)
						.font(MaskinTypeface.sans(MaskinFontSize.t17, weight: MaskinFontWeight.w650))
						.foregroundStyle(Color.white)
						.lineLimit(1)
					Text("\(card.unit) \u{00B7} \(Self.clock(BriefSequence.duration(of: card)))")
						.font(MaskinTypeface.sans(MaskinFontSize.t14))
						.foregroundStyle(MaskinColor.patina100.opacity(0.7))
						.lineLimit(1)
				}
				Spacer(minLength: 0)
				Button(action: close) {
					Image(systemName: "xmark")
						.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold))
						.foregroundStyle(Color.white)
						.frame(width: MaskinSpace.s14 + MaskinSpace.s3, height: MaskinSpace.s14 + MaskinSpace.s3)
						.background(Color.white.opacity(0.16), in: Circle())
						.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
						.contentShape(Circle())
				}
				.buttonStyle(.maskinPressed)
				.keyboardShortcut(.cancelAction)
				.accessibilityLabel("Close")
			}
		}
		// One element for VoiceOver: where we are, adjustable to move through the slides.
		.accessibilityElement(children: .combine)
		.accessibilityLabel("Briefing, \(playback.position)")
		.accessibilityValue("\(card.unit). \(card.headline)")
		.accessibilityAdjustableAction { direction in
			switch direction {
			case .increment: playback.next()
			case .decrement: playback.previous()
			@unknown default: break
			}
		}
		.accessibilityAction(named: "Close", close)
	}

	/// "0:25": a slide's length as a clock.
	private static func clock(_ seconds: TimeInterval) -> String {
		let total = Int(seconds.rounded())
		return "\(total / 60):" + String(format: "%02d", total % 60)
	}

	@ViewBuilder
	private func slide(_ card: StoryCard) -> some View {
		switch card.content {
		case .briefing(let headline, let script):
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.s9) {
					Text(headline).maskinText(.largeTitle).foregroundStyle(MaskinColor.patina50)
					Text(script).maskinText(.body).foregroundStyle(MaskinColor.patina100)
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(.vertical, MaskinSpace.s9)
			}
			.scrollBounceBehavior(.basedOnSize)
			.id(card.id)
		case .page(let output):
			BriefPageSlide(environment: environment, output: output) { loading in
				playback.setWaiting(loading)
			}
			.id(card.id)
		}
	}

	@ViewBuilder
	private func actions(_ card: StoryCard) -> some View {
		HStack(spacing: MaskinSpace.s5) {
			Button { tellMeMore(card) } label: {
				HStack {
					Text("Ask about this")
						.font(MaskinTypeface.sans(MaskinFontSize.t17, weight: MaskinFontWeight.w650))
					Spacer(minLength: 0)
					Image(systemName: "chevron.right")
						.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold))
						.foregroundStyle(MaskinColor.patina100.opacity(0.6))
						.accessibilityHidden(true)
				}
				.foregroundStyle(Color.white)
				.padding(.horizontal, MaskinSpace.s10)
				.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin + MaskinSpace.s9)
				.background(Color.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 26, style: .continuous))
				.overlay(
					RoundedRectangle(cornerRadius: 26, style: .continuous)
						.strokeBorder(Color.white.opacity(0.18), lineWidth: 1))
				.contentShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
			}
			.buttonStyle(.maskinPressed(.shrink))
			if case .page(let output) = card.content {
				Button { fullPage = output } label: {
					Image(systemName: "arrow.up.forward.square")
						.font(MaskinTypeface.sans(MaskinFontSize.t17, weight: .semibold))
						.foregroundStyle(Color.white)
						.frame(width: MaskinSpace.touchMin + MaskinSpace.s9, height: MaskinSpace.touchMin + MaskinSpace.s9)
						.background(Color.white.opacity(0.1), in: Circle())
						.overlay(Circle().strokeBorder(Color.white.opacity(0.18), lineWidth: 1))
				}
				.buttonStyle(.maskinPressed(.shrink))
				.accessibilityLabel("Open page")
				.accessibilityHint("Opens the page so you can scroll and use it")
			}
		}
	}

	private func tellMeMore(_ card: StoryCard) {
		let text = BriefSequence.tellMeMore(about: card)
		close()
		runtime?.buildInChat(text)
	}
}

/// One segment of the progress strip: a faint track with solid white filling it.
private struct ProgressSegment: View {
	let fill: Double

	var body: some View {
		GeometryReader { proxy in
			Capsule().fill(Color.white.opacity(0.25))
				.overlay(alignment: .leading) {
					Capsule().fill(Color.white)
						.frame(width: proxy.size.width * min(max(fill, 0), 1))
				}
				.clipShape(Capsule())
		}
		.accessibilityHidden(true)
	}
}

/// A loop page as one slide: loaded through the same file store the outcome presenter uses and
/// drawn in the same locked-down web view (no scripts' network, no navigation). Not interactive
/// here, so taps belong to the viewer; "Open page" hands it to the full presenter to scroll.
private struct BriefPageSlide: View {
	let output: LoopOutput
	let loading: (Bool) -> Void
	@State private var store: FileStore

	init(environment: AppEnvironment, output: LoopOutput, loading: @escaping (Bool) -> Void) {
		self.output = output
		self.loading = loading
		_store = State(
			initialValue: FileStore(
				fileId: output.id,
				remote: APIFilesRemote(
					client: environment.client, credentials: environment.auth.credentialsProvider)))
	}

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: MaskinRadius.cardXl * 2, style: .continuous)
		Group {
			switch store.phase {
			case .idle, .loading:
				ProgressView().tint(MaskinPatina.viewerAccent).frame(maxWidth: .infinity, maxHeight: .infinity)
			case .failed:
				Text("Couldn't open this page")
					.maskinText(.subhead).foregroundStyle(MaskinColor.patina100)
					.frame(maxWidth: .infinity, maxHeight: .infinity)
			case .loaded:
				if let file = store.file, file.kind == .html {
					PresentedHTMLView(
						html: store.text ?? file.text ?? "", revision: store.contentRevision, isInteractive: false)
				} else {
					Text(output.name).maskinText(.subhead).foregroundStyle(MaskinColor.patina100)
						.frame(maxWidth: .infinity, maxHeight: .infinity)
				}
			}
		}
		.clipShape(shape)
		.task {
			loading(true)
			await store.load()
			loading(false)
		}
		.onDisappear { loading(false) }
	}
}
