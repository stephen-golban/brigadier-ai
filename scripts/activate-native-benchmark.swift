import AppKit
import Foundation

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
}
guard CommandLine.arguments.count == 2,
      let pid = Int32(CommandLine.arguments[1]), pid > 0 else {
    fail("usage: activate-pid PID", 64)
}
let deadline = ProcessInfo.processInfo.systemUptime + 10
var target: NSRunningApplication?
while ProcessInfo.processInfo.systemUptime < deadline {
    if let candidate = NSRunningApplication(processIdentifier: pid),
       !candidate.isTerminated, candidate.activationPolicy != .prohibited {
        target = candidate
        break
    }
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
}
guard let target else { fail("PID did not register as an activatable app", 2) }
let requested = target.activate(options: [.activateAllWindows])
var activeSince: TimeInterval?
while ProcessInfo.processInfo.systemUptime < deadline {
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
    if target.isTerminated { fail("target terminated", 3) }
    let now = ProcessInfo.processInfo.systemUptime
    if target.isActive && NSWorkspace.shared.frontmostApplication?.processIdentifier == pid {
        if activeSince == nil { activeSince = now }
        if now - activeSince! >= 0.25 {
            print("activated pid=\(pid) requestSent=\(requested)")
            exit(0)
        }
    } else { activeSince = nil }
}
fail("activation timeout pid=\(pid) requestSent=\(requested)", 4)
