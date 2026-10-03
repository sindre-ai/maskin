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

	static func colors(seed: String, kind: ActorAvatar.Kind) -> MaskinColorPair {
		let i = paletteIndex(seed: seed, kind: kind)
		switch kind {
		case .agent: return agentPalette[i]
		case .human: return MaskinStatus.colors(for: humanPaletteKeys[i])
		}
	}
}

/// Avatar showing initials on a stable per-actor tint. People are circles in the web's ten-colour
/// palette; agents are characters: their own geometry in one of the `agent-*` swatches.
public struct ActorAvatar: View {
	public enum Kind: Sendable { case human, agent }

	private let name: String
	private let kind: Kind
	private let size: CGFloat
	private let seed: String
	private let working: Bool

	/// - Parameters:
	///   - seed: stable id for colour selection (defaults to the name).
	///   - working: show the violet "agent is running" ring.
	public init(
		name: String, kind: Kind = .human, size: CGFloat = MaskinSpace.s12 + MaskinSpace.s3 + MaskinSpace.s3,
		seed: String? = nil, working: Bool = false
	) {
		self.name = name
		self.kind = kind
		self.size = size
		self.seed = seed ?? name
		self.working = working
	}

	private var shape: AgentShape { kind == .agent ? ActorIdentity.agentShape(seed: seed) : .circle }

	public var body: some View {
		let colors = ActorIdentity.colors(seed: seed, kind: kind)
		let shape = shape
		Text(ActorIdentity.initials(for: name))
			.font(MaskinTypeface.sans(size * (shape == .circle ? 0.4 : 0.36), weight: .semibold, relativeTo: .caption))
			.minimumScaleFactor(0.6)
			.foregroundStyle(colors.fg)
			.frame(width: size, height: size)
			.background(colors.bg, in: shape)
			.overlay {
				if working { WorkingRing(shape: shape) }
			}
			.accessibilityElement(children: .ignore)
			.accessibilityLabel(working ? "\(name), working" : name)
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
			shape.strokeBorder(MaskinColor.accent, lineWidth: MaskinSpace.s1)
			if !reduceMotion {
				shape
					.strokeBorder(MaskinColor.accent.opacity(0.35), lineWidth: MaskinSpace.s1)
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
