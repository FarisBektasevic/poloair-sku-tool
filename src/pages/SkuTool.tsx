import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  loadCatalogSnapshot,
  loadCatalogLive,
  updateProductSku,
  updateVariationSku,
  type CatalogItem,
} from '../lib/wcApi';

// ---------- Ravna lista redova (parent proizvod + po jedan red po varijaciji) ----------

type RowKind = 'simple' | 'variable-parent' | 'variation';

type Row = {
  key: string; // jedinstven: `${productId}` ili `${productId}:${variationId}`
  kind: RowKind;
  productId: number;
  productName: string;
  variationId: number | null;
  variationLabel: string;
  currentSku: string; // poslednje potvrđeno stanje na serveru
  hasSku: boolean;
};

function flatten(items: CatalogItem[]): Row[] {
  const rows: Row[] = [];
  for (const item of items) {
    if (item.kind === 'simple') {
      rows.push({
        key: `${item.product.id}`,
        kind: 'simple',
        productId: item.product.id,
        productName: item.product.name,
        variationId: null,
        variationLabel: '',
        currentSku: item.product.sku,
        hasSku: item.product.hasSku,
      });
    } else {
      rows.push({
        key: `${item.product.id}`,
        kind: 'variable-parent',
        productId: item.product.id,
        productName: item.product.name,
        variationId: null,
        variationLabel: '',
        currentSku: item.product.sku,
        hasSku: item.product.hasSku,
      });
      for (const v of item.variations) {
        rows.push({
          key: `${item.product.id}:${v.variationId}`,
          kind: 'variation',
          productId: item.product.id,
          productName: item.product.name,
          variationId: v.variationId,
          variationLabel: v.variationLabel,
          currentSku: v.sku,
          hasSku: v.hasSku,
        });
      }
    }
  }
  return rows;
}

// ---------- Stanje po redu (draft tekst + save status) ----------

type RowStatus = 'idle' | 'saving' | 'saved' | 'error';

type RowState = {
  draft: string;
  status: RowStatus;
  error?: string;
};

type SkuFilter = 'all' | 'with' | 'without';
type TypeFilter = 'all' | 'simple' | 'variable';

function SpinnerChar() {
  const FRAMES = ['|', '/', '-', '\\'];
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((x) => (x + 1) % FRAMES.length), 120);
    return () => clearInterval(id);
  }, []);
  return <span className="spinner">{FRAMES[i]}</span>;
}

export default function SkuTool() {
  const [loadPhase, setLoadPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadMsg, setLoadMsg] = useState('Povezujem se…');
  const [loadError, setLoadError] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [rowStates, setRowStates] = useState<Record<string, RowState>>({});
  const [snapshotGenerated, setSnapshotGenerated] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [skuFilter, setSkuFilter] = useState<SkuFilter>('all');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'err' } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  function applyItems(items: CatalogItem[]) {
    const flat = flatten(items);
    setRows(flat);
    const initial: Record<string, RowState> = {};
    for (const r of flat) initial[r.key] = { draft: r.currentSku, status: 'idle' };
    setRowStates(initial);
  }

  // Default: statičan snapshot (public/catalog.json) — učitava se trenutno, bez čekanja
  // na mrežne pozive. "Osveži uživo" dugme ide preko batch endpointa kad zatreba svež podatak.
  const fetchCatalog = useCallback(async () => {
    setLoadPhase('loading');
    setLoadError('');
    setLoadMsg('Učitavam katalog…');
    try {
      const { items, generated } = await loadCatalogSnapshot();
      applyItems(items);
      setSnapshotGenerated(generated);
      setLoadPhase('ready');
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Nepoznata greška pri učitavanju kataloga.');
      setLoadPhase('error');
    }
  }, []);

  async function refreshLive() {
    setRefreshing(true);
    try {
      const items = await loadCatalogLive((msg) => setLoadMsg(msg));
      applyItems(items);
      setSnapshotGenerated(new Date().toISOString());
      showToast('Katalog osvežen sa sajta', 'ok');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Greška pri osvežavanju';
      showToast(`Greška: ${msg}`, 'err');
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    fetchCatalog();
  }, [fetchCatalog]);

  function showToast(text: string, kind: 'ok' | 'err') {
    setToast({ text, kind });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }

  function setDraft(key: string, value: string) {
    setRowStates((prev) => ({ ...prev, [key]: { ...prev[key], draft: value, status: 'idle' } }));
  }

  async function saveRow(row: Row) {
    const state = rowStates[row.key];
    if (!state) return;
    const sku = state.draft.trim();
    if (!sku) {
      setRowStates((prev) => ({
        ...prev,
        [row.key]: { ...prev[row.key], status: 'error', error: 'SKU ne može biti prazan' },
      }));
      return;
    }
    setRowStates((prev) => ({ ...prev, [row.key]: { ...prev[row.key], status: 'saving', error: undefined } }));
    try {
      if (row.kind === 'variation' && row.variationId != null) {
        await updateVariationSku(row.productId, row.variationId, sku);
      } else {
        await updateProductSku(row.productId, sku);
      }
      setRowStates((prev) => ({ ...prev, [row.key]: { draft: sku, status: 'saved' } }));
      setRows((prev) =>
        prev.map((r) => (r.key === row.key ? { ...r, currentSku: sku, hasSku: true } : r)),
      );
      showToast(`Sačuvano: ${sku}`, 'ok');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Greška pri čuvanju';
      setRowStates((prev) => ({ ...prev, [row.key]: { ...prev[row.key], status: 'error', error: msg } }));
      showToast(`Greška: ${msg}`, 'err');
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (typeFilter === 'simple' && r.kind !== 'simple') return false;
      if (typeFilter === 'variable' && r.kind === 'simple') return false;
      if (skuFilter === 'with' && !r.hasSku) return false;
      if (skuFilter === 'without' && r.hasSku) return false;
      if (q) {
        const hay = `${r.productId} ${r.productName} ${r.variationLabel}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, skuFilter, typeFilter, query]);

  const stats = useMemo(() => {
    const total = rows.length;
    const withSku = rows.filter((r) => r.hasSku).length;
    const withoutSku = total - withSku;
    const products = new Set(rows.map((r) => r.productId)).size;
    return { total, withSku, withoutSku, products };
  }, [rows]);

  if (loadPhase === 'loading') {
    return (
      <div className="stack">
        <h1 className="title">
          SKU UNOS<span className="caret">_</span>
        </h1>
        <p className="subtitle">poloair.rs — masovan unos WooCommerce SKU kodova</p>
        <p className="loading-text">
          <SpinnerChar /> {loadMsg}
        </p>
      </div>
    );
  }

  if (loadPhase === 'error') {
    return (
      <div className="stack">
        <h1 className="title">
          SKU UNOS<span className="caret">_</span>
        </h1>
        <p className="subtitle">poloair.rs — masovan unos WooCommerce SKU kodova</p>
        <div className="error-msg">
          Ne mogu da učitam katalog: {loadError}
          <br />
          Ako je greška vezana za mrežu/CORS, otvori ovu stranicu u istoj mreži gde radi n8n proxy,
          ili proveri da li webhook dozvoljava pozive sa ovog sajta.
        </div>
        <button type="button" className="btn primary" onClick={fetchCatalog}>
          Pokušaj ponovo
        </button>
      </div>
    );
  }

  return (
    <div className="stack">
      <h1 className="title">
        SKU UNOS<span className="caret">_</span>
      </h1>
      <p className="subtitle">
        poloair.rs — masovan unos WooCommerce SKU kodova
        {snapshotGenerated && (
          <> · katalog od {new Date(snapshotGenerated).toLocaleString('sr-RS')}</>
        )}
      </p>

      <div className="stat-row">
        <div className="stat-tile">
          <div className="stat-label">Proizvoda</div>
          <div className="stat-value">{stats.products}</div>
        </div>
        <div className="stat-tile">
          <div className="stat-label">Redova (+ varijacije)</div>
          <div className="stat-value">{stats.total}</div>
        </div>
        <div className="stat-tile ok">
          <div className="stat-label">Sa SKU</div>
          <div className="stat-value">{stats.withSku}</div>
        </div>
        <div className="stat-tile warn">
          <div className="stat-label">Bez SKU</div>
          <div className="stat-value">{stats.withoutSku}</div>
        </div>
      </div>

      <div className="subnav" role="tablist" aria-label="Filter po SKU statusu">
        <button
          type="button"
          className={`seg ${skuFilter === 'all' ? 'active' : ''}`}
          onClick={() => setSkuFilter('all')}
        >
          [ SVI ]
        </button>
        <button
          type="button"
          className={`seg ${skuFilter === 'with' ? 'active' : ''}`}
          onClick={() => setSkuFilter('with')}
        >
          [ SA SKU ]
        </button>
        <button
          type="button"
          className={`seg ${skuFilter === 'without' ? 'active' : ''}`}
          onClick={() => setSkuFilter('without')}
        >
          [ BEZ SKU ]
        </button>
        <span style={{ width: 8 }} />
        <button
          type="button"
          className={`seg ${typeFilter === 'all' ? 'active' : ''}`}
          onClick={() => setTypeFilter('all')}
        >
          [ SVI TIPOVI ]
        </button>
        <button
          type="button"
          className={`seg ${typeFilter === 'simple' ? 'active' : ''}`}
          onClick={() => setTypeFilter('simple')}
        >
          [ SIMPLE ]
        </button>
        <button
          type="button"
          className={`seg ${typeFilter === 'variable' ? 'active' : ''}`}
          onClick={() => setTypeFilter('variable')}
        >
          [ VARIABLE ]
        </button>
      </div>

      <div className="toolbar">
        <input
          type="text"
          className="input"
          placeholder="pretraži po nazivu ili ID-u…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="button" className="btn" onClick={fetchCatalog} disabled={refreshing}>
          ↻ Osveži (lokalno)
        </button>
        <button type="button" className="btn primary" onClick={refreshLive} disabled={refreshing}>
          {refreshing ? (
            <>
              <SpinnerChar /> {loadMsg}
            </>
          ) : (
            '⇪ Osveži uživo sa sajta (~1 min)'
          )}
        </button>
      </div>

      <div className="sheet-wrap">
        <table className="sheet-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Naziv</th>
              <th>Tip</th>
              <th>SKU</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const state = rowStates[row.key] ?? { draft: row.currentSku, status: 'idle' as RowStatus };
              const dirty = state.draft.trim() !== row.currentSku;
              const rowClass = [
                row.kind === 'variable-parent' ? 'row-variable' : '',
                row.kind === 'variation' ? 'row-variation' : '',
                state.status === 'saving' ? 'row-saving' : '',
                state.status === 'saved' ? 'row-saved-ok' : '',
                state.status === 'error' ? 'row-saved-err' : '',
              ]
                .filter(Boolean)
                .join(' ');

              return (
                <tr key={row.key} className={rowClass}>
                  <td className="col-id">
                    {row.productId}
                    {row.variationId != null ? `:${row.variationId}` : ''}
                  </td>
                  <td className="col-name">
                    {row.kind === 'variation' ? row.variationLabel : row.productName}
                  </td>
                  <td>
                    {row.kind === 'simple' && <span className="type-tag">simple</span>}
                    {row.kind === 'variable-parent' && (
                      <span className="type-tag variable">variable (glavni)</span>
                    )}
                    {row.kind === 'variation' && <span className="type-tag variable">varijacija</span>}
                  </td>
                  <td className="col-sku">
                    <input
                      type="text"
                      className="input sku-input"
                      value={state.draft}
                      placeholder="npr. SZC1"
                      onChange={(e) => setDraft(row.key, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveRow(row);
                      }}
                      disabled={state.status === 'saving'}
                    />
                  </td>
                  <td className="col-status">
                    {state.status === 'saving' && (
                      <span className="loading-text">
                        <SpinnerChar /> čuvam…
                      </span>
                    )}
                    {state.status === 'saved' && <span className="badge ok">sačuvano</span>}
                    {state.status === 'error' && (
                      <span className="badge err" title={state.error}>
                        greška
                      </span>
                    )}
                    {state.status === 'idle' && row.hasSku && !dirty && (
                      <span className="badge mute">postavljeno</span>
                    )}
                    {state.status === 'idle' && !row.hasSku && !dirty && (
                      <span className="badge warn">bez SKU</span>
                    )}
                    {state.status === 'idle' && dirty && <span className="badge warn">izmenjeno</span>}
                  </td>
                  <td className="col-actions">
                    <button
                      type="button"
                      className="btn small primary"
                      disabled={state.status === 'saving' || !dirty}
                      onClick={() => saveRow(row)}
                    >
                      Sačuvaj
                    </button>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="dim" style={{ textAlign: 'center', padding: '20px' }}>
                  Nema redova za trenutni filter/pretragu.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {toast && <div className={`toast ${toast.kind === 'err' ? 'err' : ''}`}>{toast.text}</div>}
    </div>
  );
}
