import SkuTool from './pages/SkuTool';

export default function App() {
  return (
    <div className="crt">
      <header className="statusbar" aria-hidden>
        <div className="sb-left">
          <span className="sb-brand">POLOAIR<span className="sb-sep">//</span>SKU UNOS</span>
          <span className="sb-status">
            <span className="sb-dot" /> SYSTEM ACTIVE
          </span>
        </div>
        <div className="sb-right">
          <span className="sb-link">v1</span>
        </div>
      </header>

      <main className="terminal">
        <SkuTool />
      </main>
    </div>
  );
}
