# Guida Setup Neon Postgres + Data API (Gratis & Serverless)

Questa guida spiega passo-passo come collegare la Web App della serata a un database **Neon Postgres** gratuito, in modo che tutti i partecipanti in sala possano inviare i risultati dal proprio smartphone e il formatore possa proiettarli live su `dashboard.html`.

> **Nota:** Se vuoi solo provare l'app o fare una demo sul tuo PC senza creare account esterni, non serve configurare Neon: lasciando vuoti gli URL in [`config.js`](../config.js) l'app funziona automaticamente in **Modalità Demo Locale** (salvataggio su `localStorage`, PIN `1234`).

---

## Prerequisiti
- Un account gratuito su [Neon](https://neon.tech)
- Il repository pubblicato su **GitHub Pages** (es. `https://mariodaeda.github.io/serata-tecniche-memoria-web/`)

---

## Passo 1 — Crea il progetto su Neon
1. Accedi alla **Neon Console** e clicca **New Project**.
2. Scegli un nome (es. `serata-tecniche-memoria`), **Postgres 17** e la region europea più vicina (es. **Frankfurt `eu-central-1`**).
3. Conferma la creazione del progetto.

---

## Passo 2 — Abilita Neon Auth (anonimo) e Neon Data API
> **Importante:** abilita questi due servizi **prima** di eseguire lo script SQL, perché creano i ruoli `anonymous` e `authenticated` usati dalle policy RLS.

1. Nel menu laterale del progetto Neon apri **Auth** (Neon Auth):
   - Abilita **Neon Auth**.
   - Attiva l'accesso **Anonymous** (consente ai telefoni dei partecipanti di ottenere un JWT anonimo temporaneo senza registrazione).
   - Copia l'**Auth URL** mostrato (es. `https://ep-...neonauth.eu-central-1.aws.neon.tech/neondb/auth`).
2. Nel menu laterale apri **Data API**:
   - Abilita **Data API** sul branch principale (`main`).
   - Copia il **Data API URL** (es. `https://ep-...apirest.eu-central-1.aws.neon.tech/neondb/rest/v1`).

---

## Passo 3 — Esegui `setup_neon.sql` nel Neon SQL Editor
1. Apri il file [`setup_neon.sql`](./setup_neon.sql) sul tuo editor.
2. **MODIFICA IL PIN FORMATORE:** trova la riga:
   ```sql
   VALUES ('dashboard_pin_hash', crypt('1234', gen_salt('bf')))
   ```
   e sostituisci `'1234'` con il tuo PIN personale riservato (es. `'784291'`).
3. Nel menu laterale di Neon apri **SQL Editor**, incolla l'intero contenuto modificato di `setup_neon.sql` e clicca **Run**.
4. Verifica che l'esecuzione termini senza errori. Lo script crea:
   - lo schema privato `app_private` (non esposto su Data API) con l'hash `bcrypt` del tuo PIN;
   - la tabella `public.test_submissions` con **Row-Level Security (RLS)** attiva: i partecipanti possono **solo inserire (`INSERT`)** la propria consegna, ma **non possono leggere (`SELECT`), modificare né cancellare** i risultati degli altri;
   - le funzioni `SECURITY DEFINER` `verify_dashboard_pin(p_pin)` e `get_dashboard_data(p_pin, p_session)` che restituiscono i dati alla dashboard solo dopo verifica del PIN.

---

## Passo 4 — Configura i domini CORS consentiti
Affinché i browser degli smartphone e il browser della Regia Live possano chiamare la Data API e Neon Auth da GitHub Pages:

1. Nella sezione **Data API → Settings / Allowed Origins (CORS)** aggiungi:
   - `https://mariodaeda.github.io` *(l'origine senza slash finale né path del repo)*
   - *(Opzionale per test locali)* `http://localhost:8000` e `http://127.0.0.1:8000`
2. Fai la stessa verifica nella sezione **Auth → Trusted Origins / CORS** aggiungendo `https://mariodaeda.github.io`.

---

## Passo 5 — Compila `web_app/config.js`
Apri [`../config.js`](../config.js) e incolla i due URL copiati al Passo 2 più l'URL base di GitHub Pages:

```js
export const APP_CONFIG = {
  neonDataApiUrl: "https://TUO-PROGETTO.apirest.eu-central-1.aws.neon.tech/neondb/rest/v1",
  neonAuthUrl: "https://TUO-PROGETTO.neonauth.eu-central-1.aws.neon.tech/neondb/auth",
  defaultSession: "SERATA-1",
  demoPin: "1234",
  dashboardRefreshMs: 4000,
  appBaseUrl: "https://mariodaeda.github.io/serata-tecniche-memoria-web/"
};
```

> **Nota sicurezza:** `neonDataApiUrl` e `neonAuthUrl` sono endpoint pubblici client-side pensati appositamente per essere esposti nel frontend. **Non inserire mai** la connection string Postgres (`postgresql://...` con password admin) né secret server-side dentro `config.js`!

---

## Passo 6 — Pubblica su GitHub Pages
1. Fai `git add`, `git commit` e `git push` del progetto su GitHub.
2. Nelle impostazioni del repository GitHub (**Settings → Pages**) verifica che GitHub Pages serva la cartella contenente `web_app/` (o la root pubblicata).
3. Apri `https://mariodaeda.github.io/serata-tecniche-memoria-web/dashboard.html`:
   - Dovrai vedere il badge verde **`Connesso a Neon Postgres`**.
   - Accedi con il tuo PIN personalizzato (verificando che `9999` venga rifiutato).
   - Apri la tab **4. QR Code Proiettabile** e scansiona il QR con uno smartphone: completa un test rapido e verifica che la consegna appaia nella **Regia Live** entro 4 secondi.

---

## Manutenzione utile

### Cambiare il PIN formatore in futuro
Esegui nel Neon SQL Editor:
```sql
UPDATE app_private.settings
SET value = crypt('NUOVO_PIN', gen_salt('bf')),
    updated_at = now()
WHERE key = 'dashboard_pin_hash';
```

### Svuotare i dati di prova prima della serata reale
```sql
DELETE FROM public.test_submissions
WHERE session_code = 'QA-TEST';
```
Oppure, per ogni nuova serata, usa semplicemente un nuovo codice `session` dal selettore QR (es. `SERATA-2026-11`), senza cancellare lo storico delle serate precedenti.
