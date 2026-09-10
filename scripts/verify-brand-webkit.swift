// Render the self-contained SVG image in WKWebView, matching the native app's tauri scheme.
// Usage: swift scripts/verify-brand-webkit.swift public/brand/spark.svg /tmp/spark-webkit.png
import AppKit
import WebKit

final class BrandCheck: NSObject, WKURLSchemeHandler, WKNavigationDelegate {
    let svg: Data
    let output: String
    let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 256, height: 256), configuration: WKWebViewConfiguration())
    var window: NSWindow?
    init(svg: Data, output: String) {
        self.svg = svg
        self.output = output
        super.init()
    }
    func start() {
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(self, forURLScheme: "tauri")
        let view = WKWebView(frame: web.frame, configuration: configuration)
        view.navigationDelegate = self
        window = NSWindow(contentRect: view.frame, styleMask: .borderless, backing: .buffered, defer: false)
        window?.contentView = view
        window?.orderBack(nil)
        view.load(URLRequest(url: URL(string: "tauri://localhost/")!))
    }
    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let isSVG = urlSchemeTask.request.url!.path.hasSuffix(".svg")
        let html = "<html><head><style>html,body{margin:0;background:#181818}img{display:block}</style></head><body><img width='256' height='256' src='/brand/spark.svg'></body></html>"
        let data = isSVG ? svg : Data(html.utf8)
        urlSchemeTask.didReceive(URLResponse(url: urlSchemeTask.request.url!, mimeType: isSVG ? "image/svg+xml" : "text/html", expectedContentLength: data.count, textEncodingName: "utf-8"))
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }
    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            let config = WKSnapshotConfiguration()
            config.snapshotWidth = 256
            webView.takeSnapshot(with: config) { image, error in
                guard let data = image?.tiffRepresentation,
                      let bitmap = NSBitmapImageRep(data: data),
                      let png = bitmap.representation(using: .png, properties: [:]) else {
                    fputs("WKWebView snapshot failed: \(String(describing: error))\n", stderr)
                    exit(1)
                }
                do { try png.write(to: URL(fileURLWithPath: self.output)) }
                catch { fputs("\(error)\n", stderr); exit(1) }
                let samples: [(String, Int, Int, [Int])] = [
                    ("Upper gradient", 128, 80, [97, 144, 253]),
                    ("Lower gradient", 128, 210, [31, 59, 250]),
                    ("Chevron cutout", 99, 117, [24, 24, 24]),
                    ("Underscore cutout", 160, 157, [24, 24, 24]),
                    ("Outside", 4, 4, [24, 24, 24]),
                ]
                var passed = true
                for (name, x, y, expected) in samples {
                    var channels = [Int](repeating: 0, count: bitmap.samplesPerPixel)
                    bitmap.getPixel(&channels, atX: x * bitmap.pixelsWide / 256, y: y * bitmap.pixelsHigh / 256)
                    let actual = Array(channels.prefix(3))
                    let ok = zip(actual, expected).allSatisfy { abs($0 - $1) <= 3 }
                    passed = passed && ok
                    print("\(ok ? "PASS" : "FAIL") \(name): \(actual)")
                }
                exit(passed ? 0 : 1)
            }
        }
    }
}
guard CommandLine.arguments.count == 3 else { fputs("Usage: verify-brand-webkit.swift SVG OUTPUT_PNG\n", stderr); exit(2) }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let check = BrandCheck(svg: try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])), output: CommandLine.arguments[2])
DispatchQueue.main.async { check.start() }
DispatchQueue.main.asyncAfter(deadline: .now() + 20) { fputs("WKWebView verification timed out\n", stderr); exit(1) }
app.run()
