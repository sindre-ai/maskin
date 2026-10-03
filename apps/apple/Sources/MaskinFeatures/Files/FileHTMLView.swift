import MaskinCore
import MaskinDesign
import SwiftUI
import WebKit

/// Asks the page which element sits under a point, so a pin records the selector an agent can act
/// on (the web does the same through `postMessage`). Runs in the app's own content world, so the
/// page's scripts can neither see nor answer it.
@MainActor
final class HTMLProbe {
	weak var webView: WKWebView?

	private static let script = """
		var el = document.elementFromPoint(x * window.innerWidth, y * window.innerHeight);
		if (!el) { return null; }
		var sel;
		if (el.id) { sel = '#' + CSS.escape(el.id); }
		else {
			var t = el.tagName.toLowerCase();
			var cs = Array.from(el.classList).slice(0, 2).map(function (c) { return '.' + CSS.escape(c); }).join('');
			sel = cs ? t + cs : t;
		}
		var r = el.getBoundingClientRect();
		return { selector: sel, x: r.left / window.innerWidth, y: r.top / window.innerHeight,
			w: r.width / window.innerWidth, h: r.height / window.innerHeight };
		"""

	func element(at point: FilePoint) async -> (selector: String, bounds: FileBounds)? {
		guard let webView else { return nil }
		let result = try? await webView.callAsyncJavaScript(
			Self.script, arguments: ["x": point.x, "y": point.y], in: nil, contentWorld: .defaultClient)
		guard let dict = result as? [String: Any], let selector = dict["selector"] as? String else { return nil }
		func number(_ key: String) -> Double { (dict[key] as? NSNumber)?.doubleValue ?? 0 }
		return (selector, FileBounds(x: number("x"), y: number("y"), w: number("w"), h: number("h")))
	}
}

/// An HTML file rendered like the web's sandboxed preview, with numbered review pins on top.
/// In annotate mode a tap on the page drops a pin; tapping a pin opens it.
struct FileHTMLView: View {
	let html: String
	let revision: Int
	let name: String
	let annotations: [FileAnnotation]
	let draft: FileAnnotation?
	let isAnnotating: Bool
	let probe: HTMLProbe
	var onPlace: (FilePoint) -> Void = { _ in }
	var onSelect: (FileAnnotation) -> Void = { _ in }

	@Environment(\.horizontalSizeClass) private var sizeClass

	private var height: CGFloat { sizeClass == .regular ? 720 : 560 }
	private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous) }

	var body: some View {
		GeometryReader { geo in
			ZStack(alignment: .topLeading) {
				HTMLWebView(html: html, revision: revision, probe: probe)
					.accessibilityLabel("Preview of \(name)")
				if isAnnotating {
					Color.clear
						.contentShape(Rectangle())
						.gesture(
							SpatialTapGesture().onEnded { tap in
								guard geo.size.width > 0, geo.size.height > 0 else { return }
								onPlace(
									FilePoint(x: tap.location.x / geo.size.width, y: tap.location.y / geo.size.height)
										.clamped)
							}
						)
						.accessibilityLabel("Tap to place a pin")
						.accessibilityAddTraits(.isButton)
					ForEach(annotations) { annotation in
						if let position = annotation.position {
							FilePinMarker(number: annotation.pinNumber ?? 0, isDraft: false)
								.position(x: position.x * geo.size.width, y: position.y * geo.size.height)
								.onTapGesture { onSelect(annotation) }
						}
					}
					if let draft, let position = draft.position {
						FilePinMarker(number: draft.pinNumber ?? 0, isDraft: true)
							.position(x: position.x * geo.size.width, y: position.y * geo.size.height)
							.transition(.scale.combined(with: .opacity))
					}
				}
			}
			.animation(MaskinMotion.standard, value: draft?.id)
		}
		.frame(height: height)
		.background(MaskinSurface.cardInset2)
		.clipShape(shape)
		.overlay(shape.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.overlay(alignment: .bottom) {
			if isAnnotating {
				Text("Tap the page to drop a pin")
					.maskinText(.caption)
					.foregroundStyle(MaskinColor.ink2)
					.padding(.horizontal, MaskinSpace.s9)
					.padding(.vertical, MaskinSpace.s4)
					.maskinGlassCapsule()
					.padding(MaskinSpace.s9)
					.allowsHitTesting(false)
			}
		}
	}
}

/// A numbered pin. The visible disc is 28pt; the hit area is the full 44pt touch minimum.
struct FilePinMarker: View {
	let number: Int
	let isDraft: Bool

	var body: some View {
		Text(number > 0 ? String(number) : "•")
			.maskinText(.caption)
			.foregroundStyle(MaskinSurface.onInverse)
			.frame(width: MaskinSpace.s13, height: MaskinSpace.s13)
			.background(isDraft ? MaskinColor.accentStrong : MaskinColor.accent, in: Circle())
			.overlay(Circle().strokeBorder(MaskinSurface.card, lineWidth: 2))
			.shadow(color: MaskinColor.overlayDim, radius: 6, y: 2)
			.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
			.contentShape(Circle())
			.accessibilityLabel(isDraft ? "New pin" : "Pin \(number)")
			.accessibilityAddTraits(.isButton)
	}
}
