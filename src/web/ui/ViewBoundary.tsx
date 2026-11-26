import { Component, Suspense, type ReactNode } from "react";
import { ViewLoadError, reloadOnce } from "../lazyView.js";

interface Props {
  readonly fallback: ReactNode;
  readonly children: ReactNode;
}

/**
 * Holds lazy views. While one loads it shows `fallback`; if the import failed twice it reloads
 * the page once (a new deploy has replaced the files this tab knows) and shows `fallback` until
 * then, rather than leaving a blank page.
 */
export class ViewBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  /** A different view under the boundary is a fresh try: the fallback does not outlast the view that failed. */
  override componentDidUpdate(prev: Props): void {
    if (this.state.failed && prev.children !== this.props.children) this.setState({ failed: false });
  }

  override componentDidCatch(error: unknown): void {
    if (!(error instanceof ViewLoadError)) return;
    if (typeof sessionStorage === "undefined") return;
    reloadOnce(sessionStorage, () => window.location.reload());
  }

  override render(): ReactNode {
    if (this.state.failed) return this.props.fallback;
    return <Suspense fallback={this.props.fallback}>{this.props.children}</Suspense>;
  }
}
