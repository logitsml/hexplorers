import { Component, type ReactNode } from 'react';

/** Keeps a rendering error in one HUD piece from taking down the whole interface. */
/**
 * `onFail`: what else to do when the piece fails (the dialogs close theirs, so the HUD behind,
 * inert under it, isn't left frozen under a dialog that can't draw).
 */
export class ErrorBoundary extends Component<{ children: ReactNode; name: string; onFail?: () => void }, { failed: boolean }> {
  state = { failed: false };
  private retries = 0;
  private lastError = 0;

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`[ui:${this.props.name}]`, error);
    this.props.onFail?.();
    // Try again shortly rather than staying blank, backing off (up to every 10 s) so an
    // error that recurs on every render doesn't loop, but the piece always comes back once
    // the cause is gone.
    const now = performance.now();
    if (now - this.lastError > 20000) this.retries = 0;
    this.lastError = now;
    setTimeout(() => this.setState({ failed: false }), Math.min(10000, 500 * 2 ** this.retries++));
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
