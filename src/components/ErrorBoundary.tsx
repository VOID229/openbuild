// A React tree that throws while rendering unmounts everything, which used to leave a blank page
// with nothing to click and no clue what happened. Show the failure and a way back instead: chats
// and settings live on the server, so a reload recovers all of it.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface State {
  error?: Error;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("OpenBuild crashed while rendering", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="home">
        <div className="home-center">
          <p>
            OpenBuild hit an error showing this page ({error.message || "unknown error"}). Your threads and settings are
            safe on the server — reload to pick up where you left off.
          </p>
          <button type="button" className="btn" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
