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
  neonDataApiUrl: "https://ep-fragrant-surf-bauvhgu5.apirest.c-8.eu-central-1.aws.neon.tech/neondb/rest/v1",
  neonAuthUrl: "https://ep-fragrant-surf-bauvhgu5.neonauth.c-8.eu-central-1.aws.neon.tech/neondb/auth",
  defaultSession: "SERATA-1",
  demoPin: "1234",
  dashboardRefreshMs: 4000,
  appBaseUrl: "https://mariodaeda.github.io/serata-tecniche-memoria-web/"
};
