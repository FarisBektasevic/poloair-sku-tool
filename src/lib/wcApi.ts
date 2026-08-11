// Sloj za komunikaciju sa poloair.rs WooCommerce preko n8n webhook-a.
// Čitanje kataloga ide kroz poseban "batch" endpoint (poloair-sku-catalog) koji server-side
// sakuplja sve proizvode + sve varijacije i vrati ih u JEDNOM odgovoru — brže i pouzdanije
// nego 50+ pojedinačnih poziva iz browsera. Pisanje (PUT) i dalje ide kroz opšti wc-api-proxy.

const PROXY_URL: string = import.meta.env.VITE_N8N_WC_PROXY_URL;
const CATALOG_URL: string = import.meta.env.VITE_N8N_CATALOG_URL;
const GITHUB_SYNC_URL: string = import.meta.env.VITE_N8N_GITHUB_SYNC_URL;

export type WcVariationAttribute = { id: number; name: string; slug: string; option: string };

export type WcVariation = {
  id: number;
  sku: string;
  attributes: WcVariationAttribute[];
};

export type WcProduct = {
  id: number;
  name: string;
  type: 'simple' | 'variable' | string;
  sku: string;
  status: string;
};

export type ProductRow = {
  id: number;
  name: string;
  type: string;
  sku: string;
  hasSku: boolean;
};

export type VariationRow = {
  productId: number;
  productName: string;
  variationId: number;
  variationLabel: string;
  sku: string;
  hasSku: boolean;
};

export type CatalogItem =
  | { kind: 'simple'; product: ProductRow }
  | { kind: 'variable'; product: ProductRow; variations: VariationRow[] };

class ProxyError extends Error {}

async function proxyCall(
  method: 'GET' | 'PUT',
  path: string,
  body: Record<string, unknown> = {},
  opts: { retries?: number; retryDelayMs?: number; timeoutMs?: number } = {},
): Promise<unknown> {
  if (!PROXY_URL) {
    throw new ProxyError('VITE_N8N_WC_PROXY_URL nije podešen (.env fajl).');
  }
  const retries = opts.retries ?? 4;
  const retryDelayMs = opts.retryDelayMs ?? 2500;
  const timeoutMs = opts.timeoutMs ?? 60000;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(PROXY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, path, body }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        throw new ProxyError(`HTTP ${res.status}`);
      }
      const text = await res.text();
      if (!text.trim()) {
        throw new ProxyError('Prazan odgovor sa servera');
      }
      return JSON.parse(text);
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new ProxyError('Nepoznata greška');
}

type CatalogVariation = { id: number; sku: string; label: string };
type CatalogProduct = { id: number; name: string; type: string; sku: string; variations: CatalogVariation[] };
type CatalogPayload = { generated: string; count: number; items: CatalogProduct[] };

function toItems(payload: CatalogPayload): CatalogItem[] {
  return payload.items
    .filter((p) => p.type === 'simple' || p.type === 'variable')
    .map((p): CatalogItem => {
      const product: ProductRow = { id: p.id, name: p.name, type: p.type, sku: p.sku || '', hasSku: !!p.sku };
      if (p.type === 'simple') return { kind: 'simple', product };
      return {
        kind: 'variable',
        product,
        variations: (p.variations || []).map((v) => ({
          productId: p.id,
          productName: p.name,
          variationId: v.id,
          variationLabel: v.label,
          sku: v.sku || '',
          hasSku: !!v.sku,
        })),
      };
    });
}

// Učita katalog SA GITHUB-A (raw fajl, main grana) — ne sa lokalnog diska/build-a. Ovo je
// bitno: kad se SKU sačuva, app commit-uje novo stanje na GitHub (vidi syncSkuToGithub ispod);
// ako bismo čitali lokalni /catalog.json, refresh bi i dalje pokazivao staro stanje dok se
// projekat ponovo ne build-uje. Čitanjem direktno sa GitHub-a, svaki refresh vidi PRAVO
// najnovije stanje, bez obzira gde je app deployovan.
const GITHUB_RAW_CATALOG_URL =
  'https://raw.githubusercontent.com/FarisBektasevic/poloair-sku-tool/main/public/catalog.json';

export async function loadCatalogSnapshot(): Promise<{ items: CatalogItem[]; generated: string }> {
  const res = await fetch(`${GITHUB_RAW_CATALOG_URL}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new ProxyError(`Katalog nije dostupan na GitHub-u (HTTP ${res.status})`);
  const payload = (await res.json()) as CatalogPayload;
  return { items: toItems(payload), generated: payload.generated };
}

// Učita SVEŽ katalog uživo preko posebnog n8n batch endpointa — server-side sakupi sve
// proizvode + varijacije i vrati ih u JEDNOM odgovoru (jedan poziv iz browsera, ali samo
// izvršenje na n8n strani traje ~40-60s jer i dalje mora da pozove WooCommerce po proizvodu
// za varijacije). Koristi se samo na eksplicitan zahtev korisnika ("Osveži uživo").
export async function loadCatalogLive(onProgress?: (msg: string) => void): Promise<CatalogItem[]> {
  if (!CATALOG_URL) {
    throw new ProxyError('VITE_N8N_CATALOG_URL nije podešen (.env fajl).');
  }
  onProgress?.('Povlačim svež katalog sa sajta (može potrajati do minut)…');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150000);
  try {
    const res = await fetch(CATALOG_URL, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new ProxyError(`HTTP ${res.status}`);
    const payload = (await res.json()) as CatalogPayload;
    onProgress?.('Gotovo.');
    return toItems(payload);
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

// WC API proxy na grešku (npr. WooCommerce validacija) vraća [{ error: { description, message, ... } }]
// umesto proizvoda. Prepoznaj taj oblik i baci čitljivu poruku umesto tihog "sku se ne poklapa".
function extractWcError(resp: unknown): string | null {
  const obj = Array.isArray(resp) ? resp[0] : resp;
  const err = (obj as { error?: { description?: string; message?: string } } | undefined)?.error;
  if (!err) return null;
  return err.description || err.message || 'Nepoznata greška sa servera';
}

// Ažurira snapshot na GitHub-u (public/catalog.json) tako da sledeći refresh/otvaranje
// odmah pokaže upisan SKU, umesto starog snapshot-a. Greška ovde se NE prosleđuje dalje —
// WooCommerce upis je već uspeo, to je bitno; GitHub sync je "nice to have" perzistencija.
async function syncSkuToGithub(productId: number, sku: string, variationId?: number): Promise<void> {
  if (!GITHUB_SYNC_URL) return;
  try {
    await fetch(GITHUB_SYNC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId, variationId, sku }),
    });
  } catch (e) {
    // tiho ignorisano — sledeće "Osveži uživo" će svakako povući tačno stanje sa sajta
  }
}

export async function updateProductSku(productId: number, sku: string): Promise<{ ok: true; sku: string }> {
  const resp = await proxyCall('PUT', `products/${productId}`, { sku }, { retries: 3 });
  const wcError = extractWcError(resp);
  if (wcError) throw new ProxyError(wcError);
  const obj = Array.isArray(resp) ? resp[0] : resp;
  const actual = (obj as { sku?: string } | undefined)?.sku ?? '';
  if (actual !== sku) {
    throw new ProxyError(`Server je vratio drugačiji SKU (${actual || '—'}) od poslatog (${sku})`);
  }
  await syncSkuToGithub(productId, actual);
  return { ok: true, sku: actual };
}

export async function updateVariationSku(
  productId: number,
  variationId: number,
  sku: string,
): Promise<{ ok: true; sku: string }> {
  const resp = await proxyCall(
    'PUT',
    `products/${productId}/variations/${variationId}`,
    { sku },
    { retries: 3 },
  );
  const wcError = extractWcError(resp);
  if (wcError) throw new ProxyError(wcError);
  const obj = Array.isArray(resp) ? resp[0] : resp;
  const actual = (obj as { sku?: string } | undefined)?.sku ?? '';
  if (actual !== sku) {
    throw new ProxyError(`Server je vratio drugačiji SKU (${actual || '—'}) od poslatog (${sku})`);
  }
  await syncSkuToGithub(productId, actual, variationId);
  return { ok: true, sku: actual };
}
