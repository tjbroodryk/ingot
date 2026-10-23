// Ingot's menu bar item: whether the login service is running, and the
// buttons to start, stop and restart it. Built and installed by
// `bun run service install`; it drives the dev.ingotdb LaunchAgent through
// launchctl and polls the API's health route, nothing else.

import AppKit

let label = "dev.ingotdb"
let apiURL = URL(string: "http://localhost:3002/api/v1")!
let healthURL = URL(string: "http://127.0.0.1:3002/api/health")!
let dashboardURL = URL(string: "http://localhost:5174/")!
let home = FileManager.default.homeDirectoryForCurrentUser
let plist = home.appendingPathComponent("Library/LaunchAgents/\(label).plist")
let log = home.appendingPathComponent("Library/Logs/ingot/ingot.log")
let domain = "gui/\(getuid())"

enum State {
  /// The service is not loaded, and nothing answers.
  case stopped
  /// Loaded, but the API is not answering yet: Docker, Postgres, migrations, bun.
  case starting
  case running
  /// Something answers on the port, but not the service: a `bun run dev` in a terminal.
  case runningElsewhere

  var title: String {
    switch self {
    case .stopped: return "Ingot is stopped"
    case .starting: return "Ingot is starting…"
    case .running: return "Ingot is running"
    case .runningElsewhere: return "Ingot is running in a terminal"
    }
  }

  var lit: Bool { self == .running || self == .runningElsewhere }
}

@discardableResult
func launchctl(_ args: [String]) -> Int32 {
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
  process.arguments = args
  process.standardOutput = FileHandle.nullDevice
  process.standardError = FileHandle.nullDevice
  do {
    try process.run()
    process.waitUntilExit()
    return process.terminationStatus
  } catch {
    return -1
  }
}

func serviceLoaded() -> Bool { launchctl(["print", "\(domain)/\(label)"]) == 0 }

/// The site's icon — a cast bar seen end on and two rules under it — as a
/// template image so it takes the menu bar's colour. The coordinates are
/// `apps/ingot-app/src/app/icon.svg`'s 64-unit grid, cropped to the shapes.
/// Dimmed when ingot is not up.
func ingot(lit: Bool) -> NSImage {
  let scale: CGFloat = 0.45
  let image = NSImage(size: NSSize(width: 40 * scale, height: 36 * scale), flipped: true) { _ in
    let transform = AffineTransform(translationByX: -12, byY: -14)
    func fill(_ path: NSBezierPath, _ alpha: CGFloat) {
      path.transform(using: transform)
      path.transform(using: AffineTransform(scaleByX: scale, byY: scale))
      NSColor.black.withAlphaComponent((lit ? 1 : 0.35) * alpha).setFill()
      path.fill()
    }

    let bar = NSBezierPath()
    bar.move(to: NSPoint(x: 19, y: 14))
    bar.line(to: NSPoint(x: 45, y: 14))
    bar.line(to: NSPoint(x: 52, y: 30))
    bar.line(to: NSPoint(x: 12, y: 30))
    bar.close()
    fill(bar, 1)
    fill(NSBezierPath(rect: NSRect(x: 12, y: 38, width: 40, height: 4)), 1)
    fill(NSBezierPath(rect: NSRect(x: 12, y: 46, width: 28, height: 4)), 0.62)
    return true
  }
  image.isTemplate = true
  return image
}

final class Controller: NSObject, NSMenuDelegate {
  private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private var state: State = .stopped
  private var timer: Timer?

  func start() {
    item.button?.image = ingot(lit: false)
    item.button?.toolTip = "Ingot"
    let menu = NSMenu()
    menu.delegate = self
    item.menu = menu

    refresh()
    timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
      self?.refresh()
    }
  }

  /// launchctl answers in milliseconds; the health check is a local request
  /// with a short timeout. Both off the main thread all the same.
  func refresh() {
    DispatchQueue.global(qos: .utility).async {
      let loaded = serviceLoaded()
      var request = URLRequest(url: healthURL)
      request.timeoutInterval = 1.5
      URLSession.shared.dataTask(with: request) { _, response, _ in
        let healthy = (response as? HTTPURLResponse)?.statusCode == 200
        let next: State =
          healthy ? (loaded ? .running : .runningElsewhere) : (loaded ? .starting : .stopped)
        DispatchQueue.main.async { self.show(next) }
      }.resume()
    }
  }

  private func show(_ next: State) {
    state = next
    item.button?.image = ingot(lit: next.lit)
    item.button?.toolTip = next.title
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()

    let title = NSMenuItem(title: state.title, action: nil, keyEquivalent: "")
    title.isEnabled = false
    menu.addItem(title)
    if state.lit {
      let where_ = NSMenuItem(title: apiURL.absoluteString, action: nil, keyEquivalent: "")
      where_.isEnabled = false
      menu.addItem(where_)
    }
    menu.addItem(.separator())

    let installed = FileManager.default.fileExists(atPath: plist.path)
    let canStart = installed && state == .stopped
    let canStop = state == .running || state == .starting
    menu.addItem(entry("Start", #selector(startService), enabled: canStart))
    menu.addItem(entry("Stop", #selector(stopService), enabled: canStop))
    menu.addItem(entry("Restart", #selector(restartService), enabled: canStop))
    if !installed {
      let hint = NSMenuItem(title: "Run `bun run service install` first", action: nil, keyEquivalent: "")
      hint.isEnabled = false
      menu.addItem(hint)
    }

    menu.addItem(.separator())
    menu.addItem(entry("Open Dashboard", #selector(openDashboard), enabled: state.lit, key: "o"))
    menu.addItem(entry("Copy API URL", #selector(copyURL), enabled: true))
    menu.addItem(entry("Show Logs", #selector(showLogs), enabled: true))
    menu.addItem(.separator())
    menu.addItem(entry("Quit Menu", #selector(quit), enabled: true, key: "q"))
  }

  private func entry(_ title: String, _ action: Selector, enabled: Bool, key: String = "")
    -> NSMenuItem
  {
    let item = NSMenuItem(title: title, action: enabled ? action : nil, keyEquivalent: key)
    item.target = self
    item.isEnabled = enabled
    return item
  }

  /// Loads the agent again; it starts at once because it runs at load.
  @objc func startService() {
    launchctl(["bootstrap", domain, plist.path])
    show(.starting)
  }

  /// Unloads the agent, which stops it and keeps launchd from restarting it.
  /// The plist stays, so it starts again at the next login.
  @objc func stopService() {
    launchctl(["bootout", "\(domain)/\(label)"])
    show(.stopped)
  }

  @objc func restartService() {
    launchctl(["kickstart", "-k", "\(domain)/\(label)"])
    show(.starting)
  }

  @objc func openDashboard() { NSWorkspace.shared.open(dashboardURL) }

  @objc func copyURL() {
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    pasteboard.setString(apiURL.absoluteString, forType: .string)
  }

  @objc func showLogs() {
    let console = URL(fileURLWithPath: "/System/Applications/Utilities/Console.app")
    NSWorkspace.shared.open(
      [log], withApplicationAt: console, configuration: NSWorkspace.OpenConfiguration())
  }

  @objc func quit() { NSApp.terminate(nil) }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let controller = Controller()
controller.start()
app.run()
