import { Component, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource/silkscreen/400.css';
import '@fontsource/silkscreen/700.css';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

/**
 * One malformed card or file payload used to white-screen the PWA, which on a phone means a dead app until a hard
 * reload. The boundary keeps the failure to a screen: the thread itself is fine, so "Try again" re-renders and only
 * "Reload" touches the page.
 */
class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error('[web] render failed', error);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="crash" role="alert">
        <h1>That screen didn’t load.</h1>
        <p>Nothing is lost: the thread, your tasks and your files all live on the Mac. Reloading or trying again is safe.</p>
        <div className="crash-actions">
          <button className="btn btn-primary" onClick={() => this.setState({ failed: false })}>
            Try again
          </button>
          <button className="btn btn-ghost" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(
  <Boundary>
    <App />
  </Boundary>,
);
