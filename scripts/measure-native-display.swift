import AppKit
import CoreVideo
let display = CGMainDisplayID()
var link: CVDisplayLink?
let created = CVDisplayLinkCreateWithCGDisplay(display, &link)
guard created == kCVReturnSuccess, let link else { fatalError("No display link") }
CVDisplayLinkSetOutputCallback(link, { _, _, _, _, _, _ in kCVReturnSuccess }, nil)
CVDisplayLinkStart(link)
Thread.sleep(forTimeInterval: 2)
let nominal = CVDisplayLinkGetNominalOutputVideoRefreshPeriod(link)
let actual = CVDisplayLinkGetActualOutputVideoRefreshPeriod(link)
let mode = CGDisplayCopyDisplayMode(display)
print("display=\(display) mode_hz=\(mode?.refreshRate ?? 0) nominal_value=\(nominal.timeValue) nominal_scale=\(nominal.timeScale) flags=\(nominal.flags) actual_seconds=\(actual) maximum_fps=\(NSScreen.main?.maximumFramesPerSecond ?? 0)")
CVDisplayLinkStop(link)
