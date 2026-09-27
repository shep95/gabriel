//
// PrivacyScreen.swift
// bitchat
//
// This is free and unencumbered software released into the public domain.
// For more information, see <https://unlicense.org>
//

#if os(iOS)
import UIKit

/// Covers the window while the app is not frontmost, so the snapshot iOS takes
/// for the app switcher shows a placeholder instead of the open conversation.
///
/// The cover is added on `willResignActive` and removed on `didBecomeActive`.
/// Both are deliberately UIKit notifications rather than SwiftUI's `scenePhase`:
/// the snapshot is captured shortly after `willResignActive`, and adding an
/// opaque subview to the window synchronously in that callback is the only way
/// to guarantee it is in the render tree before the capture. A SwiftUI overlay
/// driven by state may not have been laid out yet.
///
/// Panic wipe separately deletes any snapshots already on disk; this keeps new
/// ones from containing anything worth deleting.
final class PrivacyScreen {
    static let shared = PrivacyScreen()

    private var cover: UIView?
    private var observers: [NSObjectProtocol] = []

    private init() {}

    /// Idempotent: repeated calls do not stack observers.
    ///
    /// `queue: nil` is required, not incidental. Passing an `OperationQueue`
    /// would enqueue the handler to run in a later runloop turn, which the
    /// snapshot can beat; with no queue the block runs synchronously on the
    /// thread that posted the notification — the main thread, for UIApplication
    /// lifecycle notifications.
    func install() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        observers = [
            center.addObserver(
                forName: UIApplication.willResignActiveNotification,
                object: nil,
                queue: nil
            ) { _ in
                PrivacyScreen.shared.show()
            },
            center.addObserver(
                forName: UIApplication.didBecomeActiveNotification,
                object: nil,
                queue: nil
            ) { _ in
                PrivacyScreen.shared.hideUnlessCaptured()
            },
            // Screen recording, mirroring and AirPlay set `isCaptured`. A
            // screenshot cannot be intercepted by an app, but a recording
            // can at least be starved: the cover stays up for as long as the
            // screen is being captured, and comes down when it stops.
            center.addObserver(
                forName: UIScreen.capturedDidChangeNotification,
                object: nil,
                queue: nil
            ) { _ in
                if PrivacyScreen.isCaptured {
                    PrivacyScreen.shared.show(reason: .captured)
                } else {
                    PrivacyScreen.shared.hideUnlessCaptured()
                }
            }
        ]
        if Self.isCaptured {
            show(reason: .captured)
        }
    }

    enum Reason { case background, captured }

    /// `UIScreen.main` is deprecated; the screen that matters is the one the
    /// key window is on.
    private static var isCaptured: Bool {
        activeWindow()?.screen.isCaptured ?? false
    }

    private func show(reason: Reason = .background) {
        guard cover == nil, let window = Self.activeWindow() else { return }

        // Opaque rather than a blur: blurred large text can stay partly
        // legible, and the snapshot is stored on disk.
        let view = UIView(frame: window.bounds)
        view.backgroundColor = .systemBackground
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]

        let label = UILabel()
        label.text = reason == .captured ? "bitchat · hidden while the screen is being recorded" : "bitchat"
        label.numberOfLines = 0
        label.textAlignment = .center
        label.font = .monospacedSystemFont(ofSize: 22, weight: .medium)
        label.textColor = .secondaryLabel
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24)
        ])

        window.addSubview(view)
        cover = view
    }

    private func hideUnlessCaptured() {
        guard !Self.isCaptured else { return }
        cover?.removeFromSuperview()
        cover = nil
    }

    private static func activeWindow() -> UIWindow? {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ??
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first
    }
}
#endif
