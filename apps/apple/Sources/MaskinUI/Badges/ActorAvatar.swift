import MaskinDesign
import SwiftUI

/// Pure identity logic for avatars, kept apart from the view so it can be tested.
public enum ActorIdentity {
	/// Up to two letters: first letters of the first two words, or the first two of a single
	/// word. Punctuation and bracketed qualifiers never reach the glyph. "?" when empty.
	public static func initials(for name: String) -> String {
		let words = name.split(whereSeparator: \.isWhitespace).map {
			String($0.filter { $0.isLetter || $0.isNumber })
		}.filter { !$0.isEmpty }
		switch words.count {
		case 0: return "?"
		case 1:
			let word = words[0]
			return String(word.prefix(2)).uppercased()
		default:
			return (String(words[0].prefix(1)) + String(words[1].prefix(1))).uppercased()
		}
	}

	/// djb2-xor, identical to the web's `hashString`, so a given actor gets the same colour
	/// on every client. (Swift's `hashValue` is randomised per process, so it cannot be used.)
	public static func bucketHash(_ input: String) -> UInt32 {
		var hash: UInt32 = 5381
		for unit in input.utf16 {
			hash = ((hash << 5) &+ hash) ^ UInt32(unit)
		}
		return hash
	}

	/// The web's ten human-avatar identities, as `--st-*` token keys.
	static let humanPaletteKeys = [
		"in_progress", "active", "signal", "clustered", "in_review",
		"validated", "qualified", "scored", "processing", "proposed",
	]
	static let agentPalette: [MaskinColorPair] = [
		MaskinColorPair(bg: MaskinColor.agentRelayTint, fg: MaskinColor.agentRelayFg),
		MaskinColorPair(bg: MaskinColor.agentCompassTint, fg: MaskinColor.agentCompassFg),
		MaskinColorPair(bg: MaskinColor.agentForgeTint, fg: MaskinColor.agentForgeFg),
		MaskinColorPair(bg: MaskinColor.agentSentinelTint, fg: MaskinColor.agentSentinelFg),
		MaskinColorPair(bg: MaskinColor.agentQuillTint, fg: MaskinColor.agentQuillFg),
	]

	public static func paletteIndex(seed: String, kind: ActorAvatar.Kind) -> Int {
		let count = kind == .agent ? agentPalette.count : humanPaletteKeys.count
		return Int(bucketHash(seed.isEmpty ? "?" : seed) % UInt32(count))
	}

	/// One glyph per agent identity swatch (Relay, Compass, Forge, Sentinel, Quill), so an agent
	/// reads as an agent at a glance and keeps its own mark across clients.
	static let agentSymbols = ["paperplane.fill", "safari.fill", "hammer.fill", "shield.fill", "pencil.line"]

	public static func agentSymbol(seed: String) -> String {
		agentSymbols[paletteIndex(seed: seed, kind: .agent)]
	}

	/// The agent's geometry: with the colour, 25 distinct looks, stable per agent on every client.
	public static func agentShape(seed: String) -> AgentShape {
		let h = bucketHash(seed.isEmpty ? "?" : seed)
		return AgentShape.allCases[Int((h / UInt32(agentPalette.count)) % UInt32(AgentShape.allCases.count))]
	}

}

/// Avatar showing initials on the Patina avatar gradient. People are circles; agents are characters:
/// their own geometry (and glyph) per identity, all in the one brand colour.
public struct ActorAvatar: View {
	public enum Kind: Sendable { case human, agent }

	private let name: String
	private let kind: Kind
	private let size: CGFloat
	private let seed: String
	private let mood: AgentMood

	/// - Parameters:
	///   - seed: stable id for colour selection (defaults to the name).
	///   - working: show the Patina "agent is running" ring.
	public init(
		name: String, kind: Kind = .human, size: CGFloat = MaskinSpace.s12 + MaskinSpace.s3 + MaskinSpace.s3,
		seed: String? = nil, working: Bool = false, mood: AgentMood? = nil
	) {
		self.name = name
		self.kind = kind
		self.size = size
		self.seed = seed ?? name
		self.mood = mood ?? (working ? .working : .idle)
	}

	private var accessibilityName: String {
		switch mood {
		case .idle: name
		case .working: "\(name), working"
		case .waiting: "\(name), needs you"
		case .failed: "\(name), last run failed"
		case .paused: "\(name), paused"
		}
	}

	private var shape: AgentShape { kind == .agent ? ActorIdentity.agentShape(seed: seed) : .circle }
	private var working: Bool { mood == .working }
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var bobbing = false
	@State private var swaying = false

	public var body: some View {
		let shape = shape
		let isPlatform = kind == .agent && isMaskinPlatformAgent(name: name)
		avatarFace(shape: shape, isPlatform: isPlatform)
			.opacity(mood == .paused ? 0.55 : 1)
			.overlay {
				if working { WorkingRing(shape: isPlatform ? .roundedSquare : shape) }
			}
			.overlay(alignment: .topTrailing) {
				if kind == .agent {
					AgentMoodBadge(mood: mood, size: max(8, size * 0.26))
						.offset(x: size * 0.04, y: -size * 0.04)
				}
			}
			// A working agent is busy: it hops and sways a little, on two out-of-step rhythms so the
			// motion never looks mechanical.
			.offset(y: working && bobbing && !reduceMotion ? -size * 0.07 : 0)
			.rotationEffect(.degrees(working && swaying && !reduceMotion ? 5 : (working && !reduceMotion ? -5 : 0)))
			.onChange(of: working, initial: true) { _, isWorking in
				guard isWorking, !reduceMotion else {
					bobbing = false
					swaying = false
					return
				}
				withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) { bobbing = true }
				withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) { swaying = true }
			}
			.accessibilityElement(children: .ignore)
			.accessibilityLabel(accessibilityName)
	}

	/// The face: the logo tile for the Maskin platform agent, otherwise initials on the avatar gradient.
	@ViewBuilder
	private func avatarFace(shape: AgentShape, isPlatform: Bool) -> some View {
		if isPlatform {
			MaskinLogoTile(size: size)
		} else {
			Text(ActorIdentity.initials(for: name))
				.font(MaskinTypeface.sans(size * (shape == .circle ? 0.4 : 0.36), weight: .semibold, relativeTo: .caption))
				.minimumScaleFactor(0.6)
				.foregroundStyle(MaskinColor.avFg)
				.frame(width: size, height: size)
				.background {
					// A touch of depth so a character reads as an object, not a flat chip.
					shape.fill(MaskinGradient.avatar)
						.overlay(
							shape.fill(
								LinearGradient(
									colors: [Color.white.opacity(0.22), .clear], startPoint: .top, endPoint: .center))
						)
						.overlay(shape.strokeBorder(MaskinColor.avFg.opacity(0.12), lineWidth: 1))
				}
		}
	}
}

#Preview("Avatars — light") { AvatarGallery().preferredColorScheme(.light) }
#Preview("Avatars — dark") { AvatarGallery().preferredColorScheme(.dark) }

private struct AvatarGallery: View {
	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			HStack {
				ForEach(["Sindre Ahl", "Magnus", "Linker (Sigrid)", ""], id: \.self) { ActorAvatar(name: $0) }
			}
			HStack {
				ForEach(["Relay", "Compass", "Forge", "Sentinel", "Quill"], id: \.self) {
					ActorAvatar(name: $0, kind: .agent)
				}
				ActorAvatar(name: "Forge", kind: .agent, working: true)
			}
			HStack {
				ForEach(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"], id: \.self) {
					ActorAvatar(name: "Agent \($0)", kind: .agent, seed: $0)
				}
			}
			HStack {
				ActorAvatar(name: "Relay", kind: .agent, mood: .waiting)
				ActorAvatar(name: "Compass", kind: .agent, mood: .failed)
				ActorAvatar(name: "Forge", kind: .agent, mood: .paused)
			}
		}
		.padding(MaskinSpace.s9)
		.background(MaskinSurface.grouped)
	}
}


/// The ring around an agent that is working. It breathes (a slow swell and fade) so a running
/// agent reads as present rather than as a static badge; still under Reduce Motion.
struct WorkingRing: View {
	let shape: AgentShape
	@Environment(\.accessibilityReduceMotion) private var reduceMotion
	@State private var breathing = false

	var body: some View {
		ZStack {
			shape.strokeBorder(MaskinColor.sig, lineWidth: MaskinSpace.s1)
			if !reduceMotion {
				shape
					.strokeBorder(MaskinColor.sig.opacity(0.35), lineWidth: MaskinSpace.s1)
					.scaleEffect(breathing ? 1.3 : 1)
					.opacity(breathing ? 0 : 1)
			}
		}
		.onAppear {
			guard !reduceMotion else { return }
			withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) { breathing = true }
		}
		.accessibilityHidden(true)
	}
}

/// The geometries agents take. Each is a soft-cornered shape that still holds two initials.
public enum AgentShape: CaseIterable, Sendable, InsettableShape {
	case circle, roundedSquare, hexagon, octagon, pentagon

	var sides: Int {
		switch self {
		case .circle: 0
		case .roundedSquare: 4
		case .hexagon: 6
		case .octagon: 8
		case .pentagon: 5
		}
	}

	public func path(in rect: CGRect) -> Path { inset(by: 0).path(in: rect) }

	public func inset(by amount: CGFloat) -> some InsettableShape {
		InsetAgentShape(shape: self, inset: amount)
	}
}

private struct InsetAgentShape: InsettableShape {
	let shape: AgentShape
	var inset: CGFloat

	func inset(by amount: CGFloat) -> InsetAgentShape {
		InsetAgentShape(shape: shape, inset: inset + amount)
	}

	func path(in rect: CGRect) -> Path {
		let rect = rect.insetBy(dx: inset, dy: inset)
		switch shape {
		case .circle:
			return Circle().path(in: rect)
		case .roundedSquare:
			return RoundedRectangle(cornerRadius: rect.width * 0.3, style: .continuous).path(in: rect)
		default:
			return polygon(sides: shape.sides, in: rect, cornerRadius: rect.width * 0.12)
		}
	}

	/// A regular polygon with rounded corners, point up (flat top for even sides).
	private func polygon(sides: Int, in rect: CGRect, cornerRadius: CGFloat) -> Path {
		let center = CGPoint(x: rect.midX, y: rect.midY)
		let radius = min(rect.width, rect.height) / 2
		let rotation = sides.isMultiple(of: 2) ? Double.pi / Double(sides) : -Double.pi / 2
		let points = (0..<sides).map { i -> CGPoint in
			let angle = rotation + 2 * Double.pi * Double(i) / Double(sides)
			return CGPoint(x: center.x + radius * CGFloat(cos(angle)), y: center.y + radius * CGFloat(sin(angle)))
		}
		var path = Path()
		for i in 0..<sides {
			let previous = points[(i + sides - 1) % sides]
			let current = points[i]
			let next = points[(i + 1) % sides]
			let start = CGPoint(x: (previous.x + current.x) / 2, y: (previous.y + current.y) / 2)
			if i == 0 { path.move(to: start) } else { path.addLine(to: start) }
			path.addArc(tangent1End: current, tangent2End: next, radius: cornerRadius)
		}
		path.closeSubpath()
		return path
	}
}
