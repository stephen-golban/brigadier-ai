import { Component, type ReactNode } from "react";

/** Keep the native supervisor alive when React cannot render the interface. */
export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main role="alert" className="flex min-h-screen flex-col items-center justify-center gap-4 bg-canvas p-8 text-text">
        <h1 className="text-xl font-semibold">Brigadier couldn’t display this view</h1>
        <p className="max-w-md text-center text-text-secondary">
          Reload the interface to reconnect to your sessions. Running work continues in the background.
        </p>
        <button type="button" className="rounded-lg border border-current px-4 py-2" onClick={() => window.location.reload()}>
          Reload interface
        </button>
      </main>
    );
  }
}
