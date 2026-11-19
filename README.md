# Web App Interattiva — Serata sulle Tecniche di Memoria

Applicazione statica HTML/CSS/JS (zero build step, pronta per **GitHub Pages** + **Neon Postgres**) composta da due interfacce:

1. **App Partecipanti Smartphone** ([`index.html`](./index.html)): somministra Test A (iniziale a freddo), Test B (parallelo post-tecniche) e Round 3 (ritest post-pausa) con timer automatico sezione per sezione, protezione anti-reload e auto-correzione istantanea (`88 Ricordo + 12 Comprensione = 100`).
2. **Regia Live Proiettabile** ([`dashboard.html`](./dashboard.html)): console per il formatore protetta da PIN con dati live per categoria, confronto Round `1 → 2 → 3`, dettaglio sulle 6 prove (incluso `Vocaboli nuovi appresi`), generatore QR Code inline proiettabile a tutto schermo ed export CSV.

---

## Struttura della cartella `web_app/`

| File / Cartella | Ruolo |
|---|---|
| [`index.html`](./index.html), [`css/app.css`](./css/app.css), [`js/test-runner.js`](./js/test-runner.js), [`js/scoring.js`](./js/scoring.js), [`js/storage.js`](./js/storage.js) | App mobile-first per gli smartphone dei partecipanti |
| [`dashboard.html`](./dashboard.html), [`css/dashboard.css`](./css/dashboard.css), [`js/dashboard.js`](./js/dashboard.js) | Regia Live proiettabile con 4 tab e modalità tutto schermo |
| [`config.js`](./config.js) | Configurazione centrale (endpoint Neon, `defaultSession`, `demoPin`, `appBaseUrl`) |
| [`js/neon-client.js`](./js/neon-client.js) | Connettore Neon Data API + Neon Auth anonimo con coda offline (`stm_pending_queue_v1`) e fallback Demo in `localStorage` (`stm_demo_submissions_v1`) |
| [`js/qrcode-gen.js`](./js/qrcode-gen.js) | Generatore QR Code puro JS conforme a ISO/IEC 18004 (ECC M, Byte UTF-8, versioni 1–12, output SVG) |
| [`data/test_A.json`](./data/test_A.json), [`data/test_B.json`](./data/test_B.json) | Configurazione completa delle 6 prove di Test A e Test B |
| `assets/svg/test_A/*.svg`, `assets/svg/test_B/*.svg` | Strutture chimiche corrette e distrattori per i quesiti visivi |
| [`neon/setup_neon.sql`](./neon/setup_neon.sql), [`neon/guida_setup_neon.md`](./neon/guida_setup_neon.md) | Script SQL Postgres 17 (RLS + funzioni RPC con hash PIN `bcrypt`) e guida al setup |

---

## Avvio rapido in Locale (Modalità Demo)

Con [`config.js`](./config.js) impostato ai valori predefiniti (`neonDataApiUrl: ""`), l'app opera automaticamente in **Modalità Demo Locale** salvando le consegne in `localStorage`:

```powershell
cd e:\Progetti\serata_tecniche_memoria\web_app
python -m http.server 8000
```

Poi apri nel browser:
- **Regia Live:** `http://localhost:8000/dashboard.html` (PIN demo predefinito: **`1234`** — usa il pulsante **"Popola dati demo"** nella header per caricare 18 consegne realistiche su Round 1, 2 e 3).
- **App Partecipanti:** `http://localhost:8000/?session=SERATA-1&test=A&round=1&mode=full`

---

## Parametri URL supportati da `index.html`

| Parametro | Valori | Default | Descrizione |
|---|---|---|---|
| `session` | Testo (es. `SERATA-1`) | `APP_CONFIG.defaultSession` | Codice identificativo della serata |
| `test` | `A` \| `B` | `A` | Batteria da somministrare (`test_A.json` o `test_B.json`) |
| `round` | `1` \| `2` \| `3` | `1` | Numero del round nella serata |
| `mode` | `full` \| `recall` | `full` | `full`: Studio + Risposta; `recall`: salta lo studio (usato per il Ritest post-pausa) |

Esempi tipici della serata:
1. **Round 1 (a freddo):** `?session=SERATA-1&test=A&round=1&mode=full`
2. **Round 2 (post-tecniche):** `?session=SERATA-1&test=B&round=2&mode=full`
3. **Round 3 (ritest post-pausa):** `?session=SERATA-1&test=B&round=3&mode=recall`

---

## Deploy in Produzione (GitHub Pages + Neon Postgres)

Segui la guida dettagliata in [`neon/guida_setup_neon.md`](./neon/guida_setup_neon.md) per:
1. Creare il progetto **Neon Postgres 17** e abilitare **Neon Auth (Anonymous)** + **Neon Data API**;
2. Eseguire [`neon/setup_neon.sql`](./neon/setup_neon.sql) sostituendo il PIN `'1234'` con il tuo PIN personale;
3. Configurare i domini **CORS** per GitHub Pages;
4. Inserire `neonDataApiUrl`, `neonAuthUrl` e `appBaseUrl` in [`config.js`](./config.js) e fare push su GitHub.
