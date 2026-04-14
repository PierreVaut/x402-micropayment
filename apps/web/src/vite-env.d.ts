/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEFAULT_API_BASE: string;
  readonly VITE_BASE_RPC: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
