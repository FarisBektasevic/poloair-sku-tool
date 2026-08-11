/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_N8N_WC_PROXY_URL: string;
  readonly VITE_N8N_CATALOG_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
