interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_INTEGRATION_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
