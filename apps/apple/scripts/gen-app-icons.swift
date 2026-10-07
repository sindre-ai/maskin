#!/usr/bin/env swift
// Generates the Maskin app icons: the Patina brand icon (board "Maskin iOS Brand Directions" 4a) is a
// white open-stroke "M" (path M14 54 V18 L32 40 L50 18 V54 on a 64 grid, stroke 9, square caps, mitre
// joins, ~58% of the tile) on a 160deg gradient: light #3a8c82 -> #276a62, dark #1c2321 -> #0d1110,
// tinted = white M on grey (the system re-tints it). The launch screen keeps the older #FAFAF8-on-
// #111110 mark (viewBox 80x80, `drawMark`).
//
//   swift apps/apple/scripts/gen-app-icons.swift
//
// Writes into the asset catalogs under apps/apple/Apps/. Idempotent; commit the PNGs it produces.
//   - iOS: opaque full-bleed 1024x1024 in light, dark and tinted appearances; watchOS: the light one.
//   - macOS: a 824/1024 rounded plate with a soft shadow at 16...1024 px (macOS does not mask).
//   - launch screen: transparent mark (LaunchMark) + LaunchBackground colour for iOS and tvOS.
//   - tvOS: layered brand assets (back Patina gradient, front white M on transparent) + top shelf images.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let background = CGColor(srgbRed: 0x11 / 255, green: 0x11 / 255, blue: 0x10 / 255, alpha: 1)
let glyph = CGColor(srgbRed: 0xFA / 255, green: 0xFA / 255, blue: 0xF8 / 255, alpha: 1)

/// Draws the mark inside `rect` (the 80x80 viewBox is mapped onto it, y flipped to match SVG).
func drawMark(_ ctx: CGContext, in rect: CGRect) {
	let s = rect.width / 80
	func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
		CGPoint(x: rect.minX + x * s, y: rect.minY + (80 - y) * s)
	}
	ctx.setStrokeColor(glyph)
	ctx.setLineWidth(6 * s)
	ctx.setLineCap(.square)
	ctx.setLineJoin(.miter)
	ctx.setMiterLimit(10)
	ctx.beginPath()
	ctx.move(to: p(17, 60))
	ctx.addLine(to: p(17, 20))
	ctx.addLine(to: p(40, 46))
	ctx.addLine(to: p(63, 20))
	ctx.addLine(to: p(63, 60))
	ctx.strokePath()
}


// MARK: - Patina brand icon

func rgb(_ hex: UInt32) -> CGColor {
	CGColor(
		srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
		blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
}

/// A CSS `linear-gradient(160deg, from, to)` filling the square `rect` (CSS gradient-line length rules).
func fillGradient(_ ctx: CGContext, in rect: CGRect, from: UInt32, to: UInt32, angle: Double = 160) {
	let r = angle * .pi / 180
	let dir = CGPoint(x: sin(r), y: -cos(r))  // y-down CSS space
	let len = rect.width * (abs(sin(r)) + abs(cos(r)))
	let c = CGPoint(x: rect.midX, y: rect.midY)
	// CSS y points down; CoreGraphics (unflipped) y points up.
	let start = CGPoint(x: c.x - dir.x * len / 2, y: c.y + dir.y * len / 2)
	let end = CGPoint(x: c.x + dir.x * len / 2, y: c.y - dir.y * len / 2)
	let g = CGGradient(
		colorsSpace: CGColorSpace(name: CGColorSpace.sRGB), colors: [rgb(from), rgb(to)] as CFArray,
		locations: [0, 1])!
	ctx.saveGState()
	ctx.clip(to: rect)
	ctx.drawLinearGradient(g, start: start, end: end, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
	ctx.restoreGState()
}

/// The brand M (64 grid, stroke 9) sized so its ink is `fraction` of the tile, centred on the path.
func drawBrandM(_ ctx: CGContext, in rect: CGRect, color: CGColor = rgb(0xFFFFFF), fraction: CGFloat = 0.58) {
	let s = rect.height * fraction / 45  // path ink is ~36 wide x 36 tall plus the 9 stroke
	func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
		CGPoint(x: rect.midX + (x - 32) * s, y: rect.midY - (y - 36) * s)
	}
	ctx.setStrokeColor(color)
	ctx.setLineWidth(9 * s)
	ctx.setLineCap(.square)
	ctx.setLineJoin(.miter)
	ctx.setMiterLimit(10)
	ctx.beginPath()
	ctx.move(to: p(14, 54))
	ctx.addLine(to: p(14, 18))
	ctx.addLine(to: p(32, 40))
	ctx.addLine(to: p(50, 18))
	ctx.addLine(to: p(50, 54))
	ctx.strokePath()
}

enum IconStyle {
	case light, dark, tinted
	var stops: (UInt32, UInt32) {
		switch self {
		case .light: (0x3A8C82, 0x276A62)
		case .dark: (0x1C2321, 0x0D1110)
		case .tinted: (0x3C3C3C, 0x1C1C1C)  // grey; the system applies the tint
		}
	}
}

func brandTile(_ size: Int, _ style: IconStyle) -> CGImage {
	render(size: size, opaque: true) { ctx, n in
		let rect = CGRect(x: 0, y: 0, width: n, height: n)
		fillGradient(ctx, in: rect, from: style.stops.0, to: style.stops.1)
		drawBrandM(ctx, in: rect)
	}
}

func render(size: Int, opaque: Bool, _ draw: (CGContext, CGFloat) -> Void) -> CGImage {
	render(width: size, height: size, opaque: opaque) { ctx, w, _ in draw(ctx, w) }
}

func render(width: Int, height: Int, opaque: Bool, _ draw: (CGContext, CGFloat, CGFloat) -> Void)
	-> CGImage
{
	let space = CGColorSpace(name: CGColorSpace.sRGB)!
	let info = opaque ? CGImageAlphaInfo.noneSkipLast : CGImageAlphaInfo.premultipliedLast
	let ctx = CGContext(
		data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
		bitmapInfo: info.rawValue)!
	ctx.interpolationQuality = .high
	ctx.setAllowsAntialiasing(true)
	draw(ctx, CGFloat(width), CGFloat(height))
	return ctx.makeImage()!
}

func write(_ image: CGImage, to path: String) {
	try! FileManager.default.createDirectory(
		atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
	let url = URL(fileURLWithPath: path)
	let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
	CGImageDestinationAddImage(dest, image, nil)
	guard CGImageDestinationFinalize(dest) else { fatalError("could not write \(path)") }
	print("wrote \(path)")
}

func macPlate(_ size: Int) -> CGImage {
	render(size: size, opaque: false) { ctx, n in
		let plate = n * 824 / 1024
		let inset = (n - plate) / 2
		let rect = CGRect(x: inset, y: inset, width: plate, height: plate)
		let radius = plate * 0.2237
		let path = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
		ctx.saveGState()
		ctx.setShadow(
			offset: CGSize(width: 0, height: -n * 8 / 1024), blur: n * 14 / 1024,
			color: CGColor(srgbRed: 0, green: 0, blue: 0, alpha: 0.30))
		ctx.setFillColor(rgb(IconStyle.light.stops.1))
		ctx.addPath(path)
		ctx.fillPath()
		ctx.restoreGState()
		ctx.saveGState()
		ctx.addPath(path)
		ctx.clip()
		fillGradient(ctx, in: rect, from: IconStyle.light.stops.0, to: IconStyle.light.stops.1)
		drawBrandM(ctx, in: rect)
		ctx.restoreGState()
	}
}

// Resolve paths relative to this script: apps/apple/scripts/ -> apps/apple/Apps/
let scriptDir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
let apps = scriptDir.deletingLastPathComponent().appendingPathComponent("Apps").path

let iosSet = "\(apps)/Maskin/Assets.xcassets/AppIcon.appiconset"
write(brandTile(1024, .light), to: "\(iosSet)/icon-1024.png")
write(brandTile(1024, .dark), to: "\(iosSet)/icon-1024-dark.png")
write(brandTile(1024, .tinted), to: "\(iosSet)/icon-1024-tinted.png")
write(brandTile(1024, .light), to: "\(apps)/MaskinWatch/Assets.xcassets/AppIcon.appiconset/icon-1024.png")
for px in [16, 32, 64, 128, 256, 512, 1024] {
	write(macPlate(px), to: "\(apps)/Maskin/Assets.xcassets/AppIcon.appiconset/mac-\(px).png")
}

// MARK: - Launch screen (iOS + tvOS)

/// The mark alone on a transparent background; the launch screen supplies the colour.
func markOnly(_ size: Int) -> CGImage {
	render(size: size, opaque: false) { ctx, n in drawMark(ctx, in: CGRect(x: 0, y: 0, width: n, height: n)) }
}

func writeJSON(_ json: String, to path: String) {
	try! FileManager.default.createDirectory(
		atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
	try! json.write(toFile: path, atomically: true, encoding: .utf8)
	print("wrote \(path)")
}

let info = #""info" : { "author" : "xcode", "version" : 1 }"#
// #111110 in both appearances; the launch screen is dark regardless of system theme.
let launchColor = """
	{ "colors" : [ { "color" : { "color-space" : "srgb", "components" :
	{ "alpha" : "1.000", "blue" : "0x10", "green" : "0x11", "red" : "0x11" } }, "idiom" : "universal" } ],
	  \(info) }
	"""
let launchMarkJSON = """
	{ "images" : [
	  { "filename" : "mark-120.png", "idiom" : "universal", "scale" : "1x" },
	  { "filename" : "mark-240.png", "idiom" : "universal", "scale" : "2x" },
	  { "filename" : "mark-360.png", "idiom" : "universal", "scale" : "3x" } ],
	  \(info) }
	"""
for catalog in ["Maskin", "MaskinTV"] {
	let base = "\(apps)/\(catalog)/Assets.xcassets"
	writeJSON(launchColor, to: "\(base)/LaunchBackground.colorset/Contents.json")
	writeJSON(launchMarkJSON, to: "\(base)/LaunchMark.imageset/Contents.json")
	for px in [120, 240, 360] { write(markOnly(px), to: "\(base)/LaunchMark.imageset/mark-\(px).png") }
}

// MARK: - tvOS brand assets

let tvBase = "\(apps)/MaskinTV/Assets.xcassets"
let brand = "\(tvBase)/AppIcon.brandassets"
writeJSON("{ \(info) }", to: "\(tvBase)/Contents.json")

func solid(_ w: Int, _ h: Int) -> CGImage {
	render(width: w, height: h, opaque: true) { ctx, w, h in
		fillGradient(ctx, in: CGRect(x: 0, y: 0, width: w, height: h), from: IconStyle.light.stops.0, to: IconStyle.light.stops.1)
	}
}

/// Mark centred, sized relative to the canvas height.
func tvMark(_ w: Int, _ h: Int, opaque: Bool) -> CGImage {
	render(width: w, height: h, opaque: opaque) { ctx, w, h in
		if opaque {
			fillGradient(ctx, in: CGRect(x: 0, y: 0, width: w, height: h), from: IconStyle.light.stops.0, to: IconStyle.light.stops.1)
		}
		drawBrandM(ctx, in: CGRect(x: 0, y: 0, width: w, height: h), fraction: 0.58)
	}
}

/// One imagestack layer: `<stack>/<Layer>.imagestacklayer/Content.imageset/{Contents.json, pngs}`.
func writeLayer(stack: String, layer: String, sizes: [(scale: String, w: Int, h: Int)], image: (Int, Int) -> CGImage) {
	let dir = "\(stack)/\(layer).imagestacklayer"
	writeJSON("{ \(info) }", to: "\(dir)/Contents.json")
	var entries: [String] = []
	for s in sizes {
		let file = "\(layer.lowercased())-\(s.w)x\(s.h).png"
		write(image(s.w, s.h), to: "\(dir)/Content.imageset/\(file)")
		entries.append(#"{ "filename" : "\#(file)", "idiom" : "tv", "scale" : "\#(s.scale)" }"#)
	}
	writeJSON("{ \"images\" : [ \(entries.joined(separator: ", ")) ], \(info) }", to: "\(dir)/Content.imageset/Contents.json")
}

func writeStack(name: String, sizes: [(scale: String, w: Int, h: Int)]) {
	let stack = "\(brand)/\(name).imagestack"
	writeJSON(
		#"{ "layers" : [ { "filename" : "Front.imagestacklayer" }, { "filename" : "Back.imagestacklayer" } ], \#(info) }"#,
		to: "\(stack)/Contents.json")
	writeLayer(stack: stack, layer: "Front", sizes: sizes) { tvMark($0, $1, opaque: false) }
	writeLayer(stack: stack, layer: "Back", sizes: sizes) { solid($0, $1) }
}

writeStack(name: "App Icon", sizes: [("1x", 400, 240), ("2x", 800, 480)])
writeStack(name: "App Icon - App Store", sizes: [("1x", 1280, 768)])

func writeShelf(name: String, w: Int, h: Int) {
	let dir = "\(brand)/\(name).imageset"
	write(tvMark(w, h, opaque: true), to: "\(dir)/shelf-\(w)x\(h).png")
	write(tvMark(w * 2, h * 2, opaque: true), to: "\(dir)/shelf-\(w * 2)x\(h * 2).png")
	writeJSON(
		#"{ "images" : [ { "filename" : "shelf-\#(w)x\#(h).png", "idiom" : "tv", "scale" : "1x" }, { "filename" : "shelf-\#(w * 2)x\#(h * 2).png", "idiom" : "tv", "scale" : "2x" } ], \#(info) }"#,
		to: "\(dir)/Contents.json")
}
writeShelf(name: "Top Shelf Image", w: 1920, h: 720)
writeShelf(name: "Top Shelf Image Wide", w: 2320, h: 720)

writeJSON(
	#"""
	{ "assets" : [
	  { "filename" : "App Icon - App Store.imagestack", "idiom" : "tv", "role" : "primary-app-icon", "size" : "1280x768" },
	  { "filename" : "App Icon.imagestack", "idiom" : "tv", "role" : "primary-app-icon", "size" : "400x240" },
	  { "filename" : "Top Shelf Image Wide.imageset", "idiom" : "tv", "role" : "top-shelf-image-wide", "size" : "2320x720" },
	  { "filename" : "Top Shelf Image.imageset", "idiom" : "tv", "role" : "top-shelf-image", "size" : "1920x720" } ],
	  "info" : { "author" : "xcode", "version" : 1 } }
	"""#,
	to: "\(brand)/Contents.json")

// MARK: - iOS AppIcon Contents.json (light + dark + tinted, plus the mac plates)

var macEntries: [String] = []
for (px, name) in [(16, 16), (32, 16), (32, 32), (64, 32), (128, 128), (256, 128), (256, 256), (512, 256), (512, 512), (1024, 512)] {
	let scale = px == name ? "1x" : "2x"
	macEntries.append(#"{ "filename": "mac-\#(px).png", "idiom": "mac", "scale": "\#(scale)", "size": "\#(name)x\#(name)" }"#)
}
let iosEntries = [
	#"{ "filename": "icon-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024" }"#,
	#"{ "appearances": [ { "appearance": "luminosity", "value": "dark" } ], "filename": "icon-1024-dark.png", "idiom": "universal", "platform": "ios", "size": "1024x1024" }"#,
	#"{ "appearances": [ { "appearance": "luminosity", "value": "tinted" } ], "filename": "icon-1024-tinted.png", "idiom": "universal", "platform": "ios", "size": "1024x1024" }"#,
]
writeJSON(
	"{ \"images\": [\n\t\t" + (iosEntries + macEntries).joined(separator: ",\n\t\t") + "\n\t],\n\t\"info\": { \"author\": \"xcode\", \"version\": 1 } }\n",
	to: "\(iosSet)/Contents.json")
