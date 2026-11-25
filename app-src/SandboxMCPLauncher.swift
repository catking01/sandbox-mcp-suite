import AppKit
import Foundation

func showFailure(_ message: String) -> Never {
    let alert = NSAlert()
    alert.messageText = "Sandbox MCP 无法启动"
    alert.informativeText = message
    alert.alertStyle = .warning
    alert.addButton(withTitle: "好")
    alert.runModal()
    exit(1)
}

let bundleURL = Bundle.main.bundleURL
let repositoryURL = bundleURL.deletingLastPathComponent()
let serverURL = repositoryURL.appendingPathComponent("console/server.mjs")
guard FileManager.default.isReadableFile(atPath: serverURL.path) else {
    showFailure("找不到控制台入口：\(serverURL.path)\n请不要把 Sandbox MCP.app 从仓库目录单独移走。")
}

func supportsRuntime(_ candidate: String) -> Bool {
    guard FileManager.default.isExecutableFile(atPath: candidate) else { return false }
    let probe = Process()
    let pipe = Pipe()
    probe.executableURL = URL(fileURLWithPath: candidate)
    probe.arguments = ["--version"]
    probe.standardInput = FileHandle.nullDevice
    probe.standardOutput = pipe
    probe.standardError = FileHandle.nullDevice
    do { try probe.run() } catch { return false }
    let bytes = pipe.fileHandleForReading.readDataToEndOfFile()
    probe.waitUntilExit()
    guard probe.terminationStatus == 0,
          let text = String(data: bytes, encoding: .utf8) else { return false }
    let parts = text.trimmingCharacters(in: .whitespacesAndNewlines)
        .replacingOccurrences(of: "v", with: "").split(separator: ".")
    guard parts.count >= 2, let major = Int(parts[0]), let minor = Int(parts[1]) else { return false }
    return (major == 22 && minor >= 19) || (23...26).contains(major)
}

var candidates: [String] = []
if let configured = ProcessInfo.processInfo.environment["SANDBOX_MCP_NODE"], !configured.isEmpty {
    candidates = [configured]
} else {
    let pathEntries = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
    candidates.append(contentsOf: pathEntries.map { "\($0)/node" })
    candidates.append(contentsOf: ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"])
    let versionsRoot = "\(NSHomeDirectory())/.nvm/versions/node"
    if let versions = try? FileManager.default.contentsOfDirectory(atPath: versionsRoot) {
        for version in versions.sorted(by: { $0.compare($1, options: .numeric) == .orderedDescending }) {
            candidates.append("\(versionsRoot)/\(version)/bin/node")
        }
    }
}

guard let nodePath = candidates.first(where: supportsRuntime) else {
    showFailure("找不到 Node.js 22.19–26。请设置 SANDBOX_MCP_NODE，或先安装 Node.js。")
}

final class LauncherDelegate: NSObject, NSApplicationDelegate {
    private let child: Process
    private let consoleURL: URL
    private var terminationObserver: NSObjectProtocol?
    private var window: NSWindow?
    private var statusLabel: NSTextField?
    private var openButton: NSButton?

    init(child: Process, consoleURL: URL) {
        self.child = child
        self.consoleURL = consoleURL
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildWindow()
        terminationObserver = NotificationCenter.default.addObserver(
            forName: Process.didTerminateNotification,
            object: child,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.openButton?.isEnabled = false
            if self.child.terminationStatus == 0 {
                self.setStatus("控制台已停止。")
            } else {
                self.setStatus("控制台启动失败（退出码 \(self.child.terminationStatus)）。请检查端口 43127。")
            }
        }

        do {
            try child.run()
            setStatus("控制台正在启动…")
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in
                guard let self, self.child.isRunning else { return }
                self.openConsole()
                self.setStatus("控制台运行中：127.0.0.1:43127")
            }
        } catch {
            openButton?.isEnabled = false
            setStatus("启动 Node.js 失败：\(error.localizedDescription)")
        }
    }

    private func buildWindow() {
        let contentView = NSView()

        let titleLabel = NSTextField(labelWithString: "Sandbox MCP")
        titleLabel.font = .systemFont(ofSize: 24, weight: .semibold)

        let descriptionLabel = NSTextField(labelWithString: "本地权限控制台")
        descriptionLabel.textColor = .secondaryLabelColor

        let status = NSTextField(labelWithString: "准备启动…")
        status.maximumNumberOfLines = 2
        statusLabel = status

        let addressLabel = NSTextField(labelWithString: "http://127.0.0.1:43127/")
        addressLabel.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        addressLabel.textColor = .secondaryLabelColor

        let open = NSButton(title: "打开控制台", target: self, action: #selector(openConsole))
        open.bezelStyle = .rounded
        openButton = open

        let quit = NSButton(title: "关闭", target: self, action: #selector(quit))
        quit.bezelStyle = .rounded

        let buttonRow = NSStackView(views: [open, quit])
        buttonRow.orientation = .horizontal
        buttonRow.spacing = 10

        let stack = NSStackView(views: [titleLabel, descriptionLabel, status, addressLabel, buttonRow])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 28),
            stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -28),
            stack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -24),
            open.widthAnchor.constraint(equalToConstant: 120),
            quit.widthAnchor.constraint(equalToConstant: 80)
        ])

        let appWindow = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 500, height: 245),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        appWindow.title = "Sandbox MCP"
        appWindow.contentView = contentView
        appWindow.isReleasedWhenClosed = false
        appWindow.center()
        appWindow.makeKeyAndOrderFront(nil)
        window = appWindow
        NSApp.activate(ignoringOtherApps: true)
    }

    private func setStatus(_ message: String) {
        statusLabel?.stringValue = message
    }

    @objc private func openConsole() {
        if NSWorkspace.shared.open(consoleURL) {
            setStatus("已请求打开控制台：127.0.0.1:43127")
        } else {
            setStatus("无法自动打开浏览器，请再次点击“打开控制台”。")
        }
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if child.isRunning {
            child.terminate()
            child.waitUntilExit()
        }
        return .terminateNow
    }
}

let child = Process()
child.executableURL = URL(fileURLWithPath: nodePath)
child.arguments = [serverURL.path]
child.currentDirectoryURL = repositoryURL
child.environment = ProcessInfo.processInfo.environment
child.standardInput = FileHandle.nullDevice
child.standardOutput = FileHandle.nullDevice
child.standardError = FileHandle.nullDevice

let application = NSApplication.shared
application.setActivationPolicy(.regular)
let delegate = LauncherDelegate(child: child, consoleURL: URL(string: "http://127.0.0.1:43127/")!)
application.delegate = delegate
application.run()
