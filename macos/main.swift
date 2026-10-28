import AppKit
import WebKit

final class FloatingPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class PanelController: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var panel: FloatingPanel!
    private var web: WKWebView!
    private var ready = false
    private var pending: [String: Any]?
    private var activeID: String?
    private var anchor = NSPoint.zero
    private var sourceApp: NSRunningApplication?
    private var localMonitor: Any?
    private var globalMonitor: Any?
    private var observer: NSObjectProtocol?
    private var input = Data()
    private var lastWidth: CGFloat = 408
    private var lastHeight: CGFloat = 200
    private let snapshotMode = CommandLine.arguments.contains("--snapshot")

    func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
        FileHandle.standardOutput.write(data + Data([10]))
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "panel")
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 408, height: 240), configuration: configuration)
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        panel = FloatingPanel(contentRect: web.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "bridge"
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentView = web
        let html = Bundle.main.resourceURL!.appendingPathComponent("popup.html")
        web.loadFileURL(html, allowingReadAccessTo: Bundle.main.resourceURL!)
        guard !snapshotMode else { startInput(); return }
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]) { [weak self] _ in self?.dismiss() }
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown]) { [weak self] event in
            guard let self = self else { return event }
            if event.type == .keyDown && event.keyCode == 53 { self.dismiss(); return nil }
            if event.type != .keyDown && !self.panel.frame.contains(NSEvent.mouseLocation) { self.dismiss() }
            return event
        }
        observer = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] notification in
            guard let self = self, let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            if app.processIdentifier != ProcessInfo.processInfo.processIdentifier && app.processIdentifier != self.sourceApp?.processIdentifier { self.dismiss() }
        }
        startInput()
    }

    private func startInput() {
        FileHandle.standardInput.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            DispatchQueue.main.async {
                guard let self = self else { return }
                if chunk.isEmpty { NSApp.terminate(nil); return }
                self.input.append(chunk)
                while let newline = self.input.firstIndex(of: 10) {
                    let line = self.input.prefix(upTo: newline)
                    self.input.removeSubrange(...newline)
                    if let command = try? JSONSerialization.jsonObject(with: line) as? [String: Any] { self.receive(command) }
                }
                if self.input.count > 1_000_000 { NSApp.terminate(nil) }
            }
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        ready = true
        emit(["type": "ready"])
        if let command = pending { pending = nil; receive(command) }
    }

    func script(_ name: String, _ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value), let json = String(data: data, encoding: .utf8) else { return }
        web.evaluateJavaScript("window.\(name)(\(json))", completionHandler: nil)
    }

    func receive(_ command: [String: Any]) {
        guard let type = command["type"] as? String else { return }
        if type == "quit" { NSApp.terminate(nil); return }
        if type == "show" {
            if !ready { pending = command; return }
            dismiss()
            activeID = command["id"] as? String
            anchor = NSEvent.mouseLocation
            sourceApp = NSWorkspace.shared.frontmostApplication
            lastWidth = 408
            lastHeight = 220
            position(width: lastWidth, height: lastHeight)
            script("updatePanel", command)
            panel.orderFrontRegardless()
            emit(["type": "shown", "id": activeID ?? ""])
        } else if command["id"] as? String == activeID {
            if type == "close" { dismiss() }
            else if type == "result" {
                script("updatePanel", command)
                if let index = CommandLine.arguments.firstIndex(of: "--snapshot"), CommandLine.arguments.count > index + 1 {
                    let path = CommandLine.arguments[index + 1]
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in
                        self?.web.takeSnapshot(with: nil) { image, error in
                            guard let image = image, let data = image.tiffRepresentation,
                                  let bitmap = NSBitmapImageRep(data: data), let png = bitmap.representation(using: .png, properties: [:]) else { return }
                            try? png.write(to: URL(fileURLWithPath: path))
                            self?.emit(["type": "snapshot", "path": path])
                        }
                    }
                }
            }
        }
    }

    func position(width requestedWidth: CGFloat, height: CGFloat) {
        let screen = NSScreen.screens.first(where: { $0.frame.contains(anchor) }) ?? NSScreen.main!
        let visible = screen.visibleFrame
        let width = min(max(300, requestedWidth), min(560, visible.width))
        let h = min(max(140, height), min(480, visible.height))
        let above = anchor.y + 14 + h <= visible.maxY
        let x = min(max(anchor.x - 38, visible.minX), visible.maxX - width)
        let y = above ? anchor.y + 14 : max(visible.minY, anchor.y - h - 14)
        panel.setFrame(NSRect(x: x, y: y, width: width, height: h), display: true)
        script("placePanel", ["placement": above ? "above" : "below"])
        lastWidth = width
        lastHeight = h
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let value = message.body as? [String: Any], value["id"] as? String == activeID, activeID != nil else { return }
        switch value["type"] as? String {
        case "close": dismiss()
        case "resize":
            let width = (value["width"] as? Double).map { CGFloat($0) } ?? lastWidth
            let height = (value["height"] as? Double).map { CGFloat($0) } ?? lastHeight
            if abs(width - lastWidth) > 1 || abs(height - lastHeight) > 1 { position(width: width, height: height) }
        case "copy":
            if let text = value["text"] as? String { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string) }
        default: break
        }
    }

    func dismiss() {
        guard let id = activeID else { return }
        activeID = nil
        panel.orderOut(nil)
        emit(["type": "closed", "id": id])
    }

    func applicationWillTerminate(_ notification: Notification) {
        FileHandle.standardInput.readabilityHandler = nil
        if let monitor = localMonitor { NSEvent.removeMonitor(monitor) }
        if let monitor = globalMonitor { NSEvent.removeMonitor(monitor) }
        if let observer = observer { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
    }
}

let app = NSApplication.shared
let controller = PanelController()
app.delegate = controller
app.run()
