/**
 * Configurazione centrale della Web App (Smartphone + Regia Live).
 *
 * Modalità Demo Locale:
 *   Lascia `neonDataApiUrl` e `neonAuthUrl` vuoti ("").
 *   I risultati vengono salvati in `localStorage` sullo stesso browser
 *   e il PIN della dashboard è `demoPin` ("1234").
 *
 * Modalità Produzione (Neon Postgres + Data API):
 *   Compila `neonDataApiUrl` e `neonAuthUrl` seguendo `neon/guida_setup_neon.md`,
 *   imposta eventualmente `appBaseUrl` con l'URL pubblico di GitHub Pages
 *   (es. "https://mariodaeda.github.io/serata-tecniche-memoria-web/").
 */
export const APP_CONFIG = {
  neonDataApiUrl: "",
  neonAuthUrl: "",
  defaultSession: "SERATA-1",
  demoPin: "1234",
  dashboardRefreshMs: 4000,
  appBaseUrl: ""
};
