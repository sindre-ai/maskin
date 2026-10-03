#!/usr/bin/env swift
// Generates the Maskin app icons from the brand mark (apps/web/public/favicon.svg /
// maskin.io logo-mark.svg): an "M" stroked in #FAFAF8 on #111110, viewBox 80x80.
//
//   swift apps/apple/scripts/gen-app-icons.swift
//
// Writes into the asset catalogs under apps/apple/Apps/. Idempotent; commit the PNGs it produces.
//   - iOS + watchOS: one opaque, full-bleed 1024x1024 (the system applies the corner mask).
//   - macOS: a 824/1024 rounded plate with a soft shadow at 16...1024 px (macOS does not mask).
//   - launch screen: transparent mark (LaunchMark) + LaunchBackground colour for iOS and tvOS.
//   - tvOS: layered brand assets (back #111110, front mark on transparent) + top shelf images.
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

func fullBleed(_ size: Int) -> CGImage {
	render(size: size, opaque: true) { ctx, n in
		ctx.setFillColor(background)
		ctx.fill(CGRect(x: 0, y: 0, width: n, height: n))
		drawMark(ctx, in: CGRect(x: 0, y: 0, width: n, height: n))
	}
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
		ctx.setFillColor(background)
		ctx.addPath(path)
		ctx.fillPath()
		ctx.restoreGState()
		ctx.saveGState()
		ctx.addPath(path)
		ctx.clip()
		drawMark(ctx, in: rect)
		ctx.restoreGState()
	}
}

// Resolve paths relative to this script: apps/apple/scripts/ -> apps/apple/Apps/
let scriptDir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
let apps = scriptDir.deletingLastPathComponent().appendingPathComponent("Apps").path

write(fullBleed(1024), to: "\(apps)/Maskin/Assets.xcassets/AppIcon.appiconset/icon-1024.png")
write(fullBleed(1024), to: "\(apps)/MaskinWatch/Assets.xcassets/AppIcon.appiconset/icon-1024.png")
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
		ctx.setFillColor(background)
		ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
	}
}

/// Mark centred, sized relative to the canvas height.
func tvMark(_ w: Int, _ h: Int, opaque: Bool) -> CGImage {
	render(width: w, height: h, opaque: opaque) { ctx, w, h in
		if opaque {
			ctx.setFillColor(background)
			ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
		}
		let side = h * 0.9
		drawMark(ctx, in: CGRect(x: (w - side) / 2, y: (h - side) / 2, width: side, height: side))
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
