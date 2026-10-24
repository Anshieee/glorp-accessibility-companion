import { DemoConsole } from "./components/DemoConsole";
import { McpSetup } from "./components/McpSetup";
import { ApiDocs } from "./components/ApiDocs";
import "./styles.css";

function TopBar() {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand">
          <span className="brand-name">Accessibility Companion</span>
          <span className="brand-tag">hosted hackathon demo — not production</span>
        </div>
        <div className="topbar-badges">
          <span className="badge">
            <a href="#api-docs" aria-label="API quickstart (on this page)">
              API quickstart
            </a>
          </span>
          <span className="badge">GET /healthz</span>
          <span className="badge warning">No login · selected automated checks</span>
        </div>
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <span>
        Detection powered by <a href="https://www.deque.com/axe/" target="_blank" rel="noopener noreferrer">axe-core</a>{" "}
        and <a href="https://playwright.dev/" target="_blank" rel="noopener noreferrer">Playwright</a>.
      </span>
      <span>Automated subset only — not a certification or full WCAG conformance guarantee.</span>
      <span>Working label: Accessibility Companion.</span>
    </footer>
  );
}

export default function App() {
  return (
    <>
      <a href="#main" className="skip-link">
        Skip to main content
      </a>
      <TopBar />
      <main id="main" className="app-shell">
        <div className="hero">
          <h1>Accessibility Companion</h1>
          <p className="lede">
            Automated accessibility checks on a rendered page, paired with baseline verification — so a coding agent can
            repair source and then confirm the same URL improved.
          </p>
          <div className="note-strip">
            <span>8 axe rules · 6 categories · one rendered page state · main document only.</span>
          </div>
        </div>
        <div className="layout">
          <DemoConsole />
          <div style={{ display: "grid", gap: "1.5rem" }}>
            <McpSetup />
            <ApiDocs />
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
