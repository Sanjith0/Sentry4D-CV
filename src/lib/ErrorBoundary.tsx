import { Component, type ReactNode } from "react";

interface Props {
  fallback: ReactNode;
  onError?: (error: Error) => void;
  children: ReactNode;
}

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("[Sentry3D]", error);
    this.props.onError?.(error);
  }
  render() {
    return this.state.error ? this.props.fallback : this.props.children;
  }
}
