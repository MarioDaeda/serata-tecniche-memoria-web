/**
 * Connettore Neon Data API + Fallback Demo locale (localStorage).
 * Utilizzato sia dall'app smartphone (index.html / test-runner.js)
 * sia dalla Regia Live (dashboard.html / dashboard.js).
 */
import { APP_CONFIG } from "../config.js";

const DEMO_SUBMISSIONS_KEY = "stm_demo_submissions_v1";
const PENDING_QUEUE_KEY = "stm_pending_queue_v1";
const ANON_TOKEN_KEY = "stm_neon_anon_token_v1";

let memoryAnonToken = "";
let flushInFlightPromise = null;

function trimTrailingSlash(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function generateUuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function safeReadJsonArray(storage, key) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeWriteJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn(`[neon-client] Impossibile scrivere ${key} in storage:`, err);
  }
}

function roundOneDecimal(val) {
  return Math.round(Number(val || 0) * 10) / 10;
}

function normalizePayload(payload) {
  const sessionCode = String(payload?.session_code || APP_CONFIG.defaultSession || "SERATA-1")
    .trim()
    .toUpperCase();
  return {
    id: payload?.id || generateUuid(),
    created_at: payload?.created_at || new Date().toISOString(),
    session_code: sessionCode,
    test_id: String(payload?.test_id || "A").trim().toUpperCase(),
    round_num: Number(payload?.round_num || 1),
    mode: String(payload?.mode || "full").trim().toLowerCase(),
    participant_id: String(payload?.participant_id || "p_anon").trim(),
    nickname: String(payload?.nickname || "").trim(),
    category: String(payload?.category || "nessun_corso").trim(),
    score_total: Number(payload?.score_total ?? 0),
    max_total: Number(payload?.max_total ?? 100),
    pct_total: Number(payload?.pct_total ?? 0),
    score_recall: Number(payload?.score_recall ?? 0),
    max_recall: Number(payload?.max_recall ?? 88),
    pct_recall: Number(payload?.pct_recall ?? 0),
    score_comprehension: Number(payload?.score_comprehension ?? 0),
    max_comprehension: Number(payload?.max_comprehension ?? 12),
    pct_comprehension: Number(payload?.pct_comprehension ?? 0),
    vocab_known_count: Number(payload?.vocab_known_count ?? 0),
    vocab_new_correct: Number(payload?.vocab_new_correct ?? 0),
    vocab_new_total: Number(payload?.vocab_new_total ?? 20),
    digits_shift_detected: Boolean(payload?.digits_shift_detected),
    section_scores: payload?.section_scores && typeof payload.section_scores === "object"
      ? payload.section_scores
      : {},
    duration_seconds: Math.max(0, Math.round(Number(payload?.duration_seconds ?? 0)))
  };
}

function isJwtFresh(token) {
  if (!token || typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3) return true; // Token opaco non-JWT: accetta finché non riceve 401
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const claims = JSON.parse(atob(padded));
    if (typeof claims?.exp === "number") {
      return claims.exp * 1000 > Date.now() + 60_000;
    }
    return true;
  } catch {
    return true;
  }
}

function clearCachedAnonToken() {
  memoryAnonToken = "";
  try {
    sessionStorage.removeItem(ANON_TOKEN_KEY);
  } catch {
    // ignore storage errors
  }
}

function getCachedAnonToken() {
  if (isJwtFresh(memoryAnonToken)) return memoryAnonToken;
  try {
    const stored = sessionStorage.getItem(ANON_TOKEN_KEY) || "";
    if (isJwtFresh(stored)) {
      memoryAnonToken = stored;
      return stored;
    }
  } catch {
    // ignore
  }
  clearCachedAnonToken();
  return "";
}

function storeCachedAnonToken(token) {
  if (!token) return;
  memoryAnonToken = token;
  try {
    sessionStorage.setItem(ANON_TOKEN_KEY, token);
  } catch {
    // ignore
  }
}

function extractTokenFromResponse(data, response) {
  const headerToken = response?.headers?.get("set-auth-jwt");
  if (headerToken) return headerToken;
  if (typeof data === "string" && data.trim()) return data.trim();
  if (data && typeof data === "object") {
    return (
      data.token ||
      data.access_token ||
      data.jwt ||
      data.data?.token ||
      data.session?.token ||
      ""
    );
  }
  return "";
}

async function fetchAnonymousToken(forceRefresh = false) {
  const authBase = trimTrailingSlash(APP_CONFIG.neonAuthUrl);
  if (!authBase) return "";

  if (!forceRefresh) {
    const cached = getCachedAnonToken();
    if (cached) return cached;
  } else {
    clearCachedAnonToken();
  }

  // Endpoint primario Neon Auth anonimo
  const getRes = await fetch(`${authBase}/token/anonymous`, {
    method: "GET",
    headers: { Accept: "application/json" }
  });
  if (getRes.ok) {
    const text = await getRes.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    const token = extractTokenFromResponse(parsed, getRes);
    if (token) {
      storeCachedAnonToken(token);
      return token;
    }
  }

  // Fallback Better Auth anonymous sign-in (alcune configurazioni Neon Auth)
  const postRes = await fetch(`${authBase}/sign-in/anonymous`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({})
  });
  if (postRes.ok) {
    const data = await postRes.json().catch(() => ({}));
    const token = extractTokenFromResponse(data, postRes);
    if (token) {
      storeCachedAnonToken(token);
      return token;
    }
  }

  throw new Error(`Impossibile ottenere token anonimo Neon Auth (${getRes.status})`);
}

async function buildNeonHeaders(extraHeaders = {}, forceTokenRefresh = false) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extraHeaders
  };
  if (trimTrailingSlash(APP_CONFIG.neonAuthUrl)) {
    const token = await fetchAnonymousToken(forceTokenRefresh);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  }
  return headers;
}

async function postSubmissionToNeon(record) {
  const baseUrl = trimTrailingSlash(APP_CONFIG.neonDataApiUrl);
  const endpoint = `${baseUrl}/test_submissions`;

  // Il campo created_at viene valorizzato dal server (default now()), mentre id è UUID v4 idempotente
  const dbRecord = { ...record };

  const doPost = async (preferHeader, forceRefresh = false) => {
    const headers = await buildNeonHeaders({ Prefer: preferHeader }, forceRefresh);
    return fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(dbRecord)
    });
  };

  // Usa direttamente Prefer: return=minimal perché anonymous ha solo INSERT (nessun SELECT per privacy RLS)
  let res = await doPost("return=minimal", false);

  // Se il token anonimo è scaduto, rigenera una volta
  if (res.status === 401 && trimTrailingSlash(APP_CONFIG.neonAuthUrl)) {
    res = await doPost("return=minimal", true);
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Neon INSERT fallito (${res.status}): ${errBody}`);
  }

  const raw = await res.text().catch(() => "");
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      const row = Array.isArray(parsed) ? parsed[0] : parsed;
      if (row?.id) return String(row.id);
    } catch {
      // response non JSON con return=minimal
    }
  }
  return record.id;
}

function enqueuePendingRecord(record) {
  const queue = safeReadJsonArray(localStorage, PENDING_QUEUE_KEY);
  const exists = queue.some((item) => item?.id === record.id);
  if (!exists) {
    queue.push(record);
    safeWriteJson(localStorage, PENDING_QUEUE_KEY, queue);
  }
}

/**
 * Indica se l'app è in Modalità Demo Locale (neonDataApiUrl vuoto).
 * @returns {boolean}
 */
export function isDemoMode() {
  return !String(APP_CONFIG?.neonDataApiUrl || "").trim();
}

/**
 * Restituisce il numero di consegne in attesa nella coda offline.
 * @returns {number}
 */
export function getPendingQueueCount() {
  return safeReadJsonArray(localStorage, PENDING_QUEUE_KEY).length;
}

/**
 * Invia il risultato di una prova (Demo in localStorage oppure Neon Data API con coda offline).
 * @param {object} payload
 * @returns {Promise<{ ok: boolean, mode: 'neon'|'local', id: string, queued?: boolean }>}
 */
export async function submitResult(payload) {
  const record = normalizePayload(payload);

  if (isDemoMode()) {
    const list = safeReadJsonArray(localStorage, DEMO_SUBMISSIONS_KEY);
    const idx = list.findIndex((item) => item?.id === record.id);
    if (idx >= 0) {
      list[idx] = record;
    } else {
      list.push(record);
    }
    safeWriteJson(localStorage, DEMO_SUBMISSIONS_KEY, list);
    return { ok: true, mode: "local", id: record.id };
  }

  try {
    const savedId = await postSubmissionToNeon(record);
    return { ok: true, mode: "neon", id: savedId };
  } catch (err) {
    console.warn("[neon-client] Invio a Neon fallito, accodo localmente:", err);
    enqueuePendingRecord(record);
    return { ok: false, mode: "neon", id: record.id, queued: true };
  }
}

/**
 * Ritenta l'invio dei record rimasti in `stm_pending_queue_v1`.
 * @returns {Promise<number>} Numero di record inviati con successo.
 */
export async function flushPendingQueue() {
  if (isDemoMode()) return 0;
  if (flushInFlightPromise) return flushInFlightPromise;

  flushInFlightPromise = (async () => {
    const queue = safeReadJsonArray(localStorage, PENDING_QUEUE_KEY);
    if (queue.length === 0) return 0;

    let sentCount = 0;
    const remaining = [];
    for (const item of queue) {
      const record = normalizePayload(item);
      try {
        await postSubmissionToNeon(record);
        sentCount++;
      } catch {
        remaining.push(record);
      }
    }

    if (remaining.length === 0) {
      try {
        localStorage.removeItem(PENDING_QUEUE_KEY);
      } catch {
        safeWriteJson(localStorage, PENDING_QUEUE_KEY, []);
      }
    } else {
      safeWriteJson(localStorage, PENDING_QUEUE_KEY, remaining);
    }
    return sentCount;
  })();

  try {
    return await flushInFlightPromise;
  } finally {
    flushInFlightPromise = null;
  }
}

/**
 * Verifica il PIN del formatore per accedere alla dashboard.
 * @param {string} pin
 * @returns {Promise<boolean>}
 */
export async function verifyDashboardPin(pin) {
  const cleanPin = String(pin ?? "").trim();
  if (!cleanPin) return false;

  if (isDemoMode()) {
    return cleanPin === String(APP_CONFIG.demoPin);
  }

  const baseUrl = trimTrailingSlash(APP_CONFIG.neonDataApiUrl);
  const endpoint = `${baseUrl}/rpc/verify_dashboard_pin`;

  const callRpc = async (forceRefresh = false) => {
    const headers = await buildNeonHeaders({}, forceRefresh);
    return fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ p_pin: cleanPin })
    });
  };

  let res = await callRpc(false);
  if (res.status === 401 && trimTrailingSlash(APP_CONFIG.neonAuthUrl)) {
    res = await callRpc(true);
  }

  if (res.status === 401 || res.status === 403) {
    return false;
  }
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    if (msg.includes("42501") || msg.toLowerCase().includes("pin")) {
      return false;
    }
    throw new Error(`Errore verifica PIN Neon (${res.status}): ${msg}`);
  }

  const data = await res.json().catch(() => false);
  if (typeof data === "boolean") return data;
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0];
    if (typeof first === "boolean") return first;
    if (first && typeof first === "object") {
      return Boolean(first.verify_dashboard_pin ?? Object.values(first)[0]);
    }
  }
  if (data && typeof data === "object") {
    return Boolean(data.verify_dashboard_pin ?? data.ok ?? Object.values(data)[0]);
  }
  return Boolean(data);
}

/**
 * Recupera le sessioni disponibili e tutte le consegne (filtrate opzionalmente per sessionCode).
 * @param {string} pin
 * @param {string|null} [sessionCode=null]
 * @returns {Promise<{ sessions: string[], submissions: Array<object>, mode: 'neon'|'local' }>}
 */
export async function fetchDashboardData(pin, sessionCode = null) {
  const rawSession = String(sessionCode || "").trim().toUpperCase();
  const filterSession = rawSession && rawSession !== "ALL" ? rawSession : null;

  if (isDemoMode()) {
    if (pin !== null && pin !== undefined && String(pin).trim() !== "" && String(pin).trim() !== String(APP_CONFIG.demoPin)) {
      throw new Error("PIN formatore non valido");
    }
    const all = safeReadJsonArray(localStorage, DEMO_SUBMISSIONS_KEY).map(normalizePayload);
    const sessionsSet = new Set();
    for (const sub of all) {
      if (sub.session_code) sessionsSet.add(sub.session_code);
    }
    const sessions = Array.from(sessionsSet).sort((a, b) => a.localeCompare(b));
    const filtered = filterSession
      ? all.filter((sub) => sub.session_code === filterSession)
      : all;
    filtered.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return { sessions, submissions: filtered, mode: "local" };
  }

  const baseUrl = trimTrailingSlash(APP_CONFIG.neonDataApiUrl);
  const endpoint = `${baseUrl}/rpc/get_dashboard_data`;

  const callRpc = async (forceRefresh = false) => {
    const headers = await buildNeonHeaders({}, forceRefresh);
    return fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({ p_pin: String(pin ?? ""), p_session: filterSession })
    });
  };

  let res = await callRpc(false);
  if (res.status === 401 && trimTrailingSlash(APP_CONFIG.neonAuthUrl)) {
    res = await callRpc(true);
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Errore lettura dashboard Neon (${res.status}): ${errText}`);
  }

  let data = await res.json();
  if (Array.isArray(data) && data.length > 0 && data[0]?.get_dashboard_data) {
    data = data[0].get_dashboard_data;
  } else if (data && typeof data === "object" && data.get_dashboard_data) {
    data = data.get_dashboard_data;
  }

  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const submissions = Array.isArray(data?.submissions)
    ? data.submissions.map(normalizePayload)
    : [];
  return { sessions, submissions, mode: "neon" };
}

function buildSeedRecord({
  id,
  createdAt,
  sessionCode,
  participantId,
  nickname,
  category,
  roundNum,
  cifre,
  chimicaRecall,
  chimicaComp,
  parole,
  vocabScore,
  vocabKnown,
  vocabNewCorrect,
  matRecall,
  matComp,
  dateRecall,
  dateComp,
  shiftDetected = false,
  shiftedMatches = 0,
  durationSeconds = 960
}) {
  const testId = roundNum === 1 ? "A" : "B";
  const mode = roundNum === 3 ? "recall" : "full";
  const vocabNewTotal = 20 - vocabKnown;

  const sectionScores = {
    cifre: {
      score: cifre,
      max: 30,
      pct: roundOneDecimal((cifre / 30) * 100),
      recall: cifre,
      maxRecall: 30,
      comp: 0,
      maxComp: 0,
      shiftDetected,
      shiftedMatches
    },
    chimica: {
      score: chimicaRecall + chimicaComp,
      max: 10,
      pct: roundOneDecimal(((chimicaRecall + chimicaComp) / 10) * 100),
      recall: chimicaRecall,
      maxRecall: 8,
      comp: chimicaComp,
      maxComp: 2
    },
    parole: {
      score: parole,
      max: 15,
      pct: roundOneDecimal((parole / 15) * 100),
      recall: parole,
      maxRecall: 15,
      comp: 0,
      maxComp: 0
    },
    vocaboli: {
      score: vocabScore,
      max: 20,
      pct: roundOneDecimal((vocabScore / 20) * 100),
      recall: vocabScore,
      maxRecall: 20,
      comp: 0,
      maxComp: 0,
      knownCount: vocabKnown,
      newCorrect: vocabNewCorrect,
      newTotal: vocabNewTotal
    },
    matematica: {
      score: matRecall + matComp,
      max: 10,
      pct: roundOneDecimal(((matRecall + matComp) / 10) * 100),
      recall: matRecall,
      maxRecall: 5,
      comp: matComp,
      maxComp: 5
    },
    date: {
      score: dateRecall + dateComp,
      max: 15,
      pct: roundOneDecimal(((dateRecall + dateComp) / 15) * 100),
      recall: dateRecall,
      maxRecall: 10,
      comp: dateComp,
      maxComp: 5
    }
  };

  const scoreRecall = cifre + chimicaRecall + parole + vocabScore + matRecall + dateRecall;
  const scoreComp = chimicaComp + matComp + dateComp;
  const scoreTotal = scoreRecall + scoreComp;

  return {
    id,
    created_at: createdAt,
    session_code: sessionCode,
    test_id: testId,
    round_num: roundNum,
    mode,
    participant_id: participantId,
    nickname,
    category,
    score_total: scoreTotal,
    max_total: 100,
    pct_total: roundOneDecimal(scoreTotal),
    score_recall: scoreRecall,
    max_recall: 88,
    pct_recall: roundOneDecimal((scoreRecall / 88) * 100),
    score_comprehension: scoreComp,
    max_comprehension: 12,
    pct_comprehension: roundOneDecimal((scoreComp / 12) * 100),
    vocab_known_count: vocabKnown,
    vocab_new_correct: vocabNewCorrect,
    vocab_new_total: vocabNewTotal,
    digits_shift_detected: shiftDetected,
    section_scores: sectionScores,
    duration_seconds: durationSeconds
  };
}

/**
 * Popola 18 consegne realistiche demo in `localStorage` (`stm_demo_submissions_v1`)
 * distribuite sui Round 1, 2 e 3 e sulle 3 categorie canoniche.
 * @param {string} [sessionCode="SERATA-1"]
 * @returns {Array<object>}
 */
export function seedDemoSubmissions(sessionCode = APP_CONFIG.defaultSession || "SERATA-1") {
  const cleanSession = String(sessionCode || APP_CONFIG.defaultSession || "SERATA-1")
    .trim()
    .toUpperCase();
  const baseMs = Date.now() - 18 * 60_000;
  const ts = (idx) => new Date(baseMs + idx * 45_000).toISOString();

  const specs = [
    // --- WEEKEND (~68% -> ~85.5% -> ~97%) ---
    {
      participantId: "p_demo_wk_1", nickname: "Giulia R.", category: "weekend", roundNum: 1,
      cifre: 20, chimicaRecall: 6, chimicaComp: 1, parole: 10, vocabScore: 14, vocabKnown: 3, vocabNewCorrect: 11,
      matRecall: 3, matComp: 3, dateRecall: 6, dateComp: 3, durationSeconds: 1180
    },
    {
      participantId: "p_demo_wk_2", nickname: "Matteo B.", category: "weekend", roundNum: 1,
      cifre: 21, chimicaRecall: 6, chimicaComp: 2, parole: 11, vocabScore: 15, vocabKnown: 4, vocabNewCorrect: 11,
      matRecall: 3, matComp: 3, dateRecall: 6, dateComp: 3, durationSeconds: 1120
    },
    {
      participantId: "p_demo_wk_1", nickname: "Giulia R.", category: "weekend", roundNum: 2,
      cifre: 26, chimicaRecall: 7, chimicaComp: 2, parole: 13, vocabScore: 17, vocabKnown: 2, vocabNewCorrect: 15,
      matRecall: 4, matComp: 4, dateRecall: 8, dateComp: 3, durationSeconds: 1090
    },
    {
      participantId: "p_demo_wk_2", nickname: "Matteo B.", category: "weekend", roundNum: 2,
      cifre: 27, chimicaRecall: 7, chimicaComp: 2, parole: 13.5, vocabScore: 17.5, vocabKnown: 3, vocabNewCorrect: 14.5,
      matRecall: 4, matComp: 4, dateRecall: 8, dateComp: 4, durationSeconds: 1050
    },
    {
      participantId: "p_demo_wk_1", nickname: "Giulia R.", category: "weekend", roundNum: 3,
      cifre: 29, chimicaRecall: 8, chimicaComp: 2, parole: 15, vocabScore: 19, vocabKnown: 2, vocabNewCorrect: 17,
      matRecall: 5, matComp: 5, dateRecall: 9, dateComp: 4, durationSeconds: 510
    },
    {
      participantId: "p_demo_wk_2", nickname: "Matteo B.", category: "weekend", roundNum: 3,
      cifre: 30, chimicaRecall: 8, chimicaComp: 2, parole: 15, vocabScore: 19, vocabKnown: 3, vocabNewCorrect: 16,
      matRecall: 5, matComp: 5, dateRecall: 10, dateComp: 4, durationSeconds: 495
    },

    // --- MESI FA (~45% -> ~75% -> ~95%) ---
    {
      participantId: "p_demo_mf_1", nickname: "Elena V.", category: "mesi_fa", roundNum: 1,
      cifre: 12, chimicaRecall: 4, chimicaComp: 1, parole: 7, vocabScore: 10, vocabKnown: 2, vocabNewCorrect: 8,
      matRecall: 2, matComp: 2, dateRecall: 4, dateComp: 2, durationSeconds: 1290
    },
    {
      participantId: "p_demo_mf_2", nickname: "Davide P.", category: "mesi_fa", roundNum: 1,
      cifre: 13, chimicaRecall: 4, chimicaComp: 1, parole: 7.5, vocabScore: 10.5, vocabKnown: 3, vocabNewCorrect: 7.5,
      matRecall: 2, matComp: 2, dateRecall: 4, dateComp: 2, durationSeconds: 1245
    },
    {
      participantId: "p_demo_mf_1", nickname: "Elena V.", category: "mesi_fa", roundNum: 2,
      cifre: 23, chimicaRecall: 6, chimicaComp: 1, parole: 11.5, vocabScore: 15.5, vocabKnown: 2, vocabNewCorrect: 13.5,
      matRecall: 4, matComp: 3, dateRecall: 7, dateComp: 3, durationSeconds: 1160
    },
    {
      participantId: "p_demo_mf_2", nickname: "Davide P.", category: "mesi_fa", roundNum: 2,
      cifre: 24, chimicaRecall: 6, chimicaComp: 2, parole: 12, vocabScore: 16, vocabKnown: 3, vocabNewCorrect: 13,
      matRecall: 4, matComp: 3, dateRecall: 7, dateComp: 2, durationSeconds: 1140
    },
    {
      participantId: "p_demo_mf_1", nickname: "Elena V.", category: "mesi_fa", roundNum: 3,
      cifre: 29, chimicaRecall: 7, chimicaComp: 2, parole: 14.5, vocabScore: 18.5, vocabKnown: 2, vocabNewCorrect: 16.5,
      matRecall: 5, matComp: 5, dateRecall: 9, dateComp: 4, durationSeconds: 540
    },
    {
      participantId: "p_demo_mf_2", nickname: "Davide P.", category: "mesi_fa", roundNum: 3,
      cifre: 29, chimicaRecall: 8, chimicaComp: 2, parole: 15, vocabScore: 19, vocabKnown: 3, vocabNewCorrect: 16,
      matRecall: 5, matComp: 4, dateRecall: 10, dateComp: 4, durationSeconds: 525
    },

    // --- NESSUN CORSO (~28% -> ~62% -> ~92%) ---
    {
      participantId: "p_demo_nc_1", nickname: "Sofia N.", category: "nessun_corso", roundNum: 1,
      cifre: 6, chimicaRecall: 2, chimicaComp: 1, parole: 4.5, vocabScore: 6.5, vocabKnown: 1, vocabNewCorrect: 5.5,
      matRecall: 1, matComp: 2, dateRecall: 2, dateComp: 2, shiftDetected: true, shiftedMatches: 11, durationSeconds: 1380
    },
    {
      participantId: "p_demo_nc_2", nickname: "Luca M.", category: "nessun_corso", roundNum: 1,
      cifre: 7, chimicaRecall: 3, chimicaComp: 0, parole: 5, vocabScore: 7, vocabKnown: 2, vocabNewCorrect: 5,
      matRecall: 1, matComp: 2, dateRecall: 2, dateComp: 2, durationSeconds: 1350
    },
    {
      participantId: "p_demo_nc_1", nickname: "Sofia N.", category: "nessun_corso", roundNum: 2,
      cifre: 19, chimicaRecall: 5, chimicaComp: 1, parole: 10, vocabScore: 12, vocabKnown: 1, vocabNewCorrect: 11,
      matRecall: 3, matComp: 3, dateRecall: 6, dateComp: 2, durationSeconds: 1210
    },
    {
      participantId: "p_demo_nc_2", nickname: "Luca M.", category: "nessun_corso", roundNum: 2,
      cifre: 20, chimicaRecall: 5, chimicaComp: 1, parole: 10, vocabScore: 13, vocabKnown: 2, vocabNewCorrect: 11,
      matRecall: 3, matComp: 3, dateRecall: 6, dateComp: 2, durationSeconds: 1195
    },
    {
      participantId: "p_demo_nc_1", nickname: "Sofia N.", category: "nessun_corso", roundNum: 3,
      cifre: 28, chimicaRecall: 7, chimicaComp: 2, parole: 14, vocabScore: 18, vocabKnown: 1, vocabNewCorrect: 17,
      matRecall: 5, matComp: 4, dateRecall: 9, dateComp: 4, durationSeconds: 560
    },
    {
      participantId: "p_demo_nc_2", nickname: "Luca M.", category: "nessun_corso", roundNum: 3,
      cifre: 28, chimicaRecall: 7, chimicaComp: 2, parole: 14.5, vocabScore: 18.5, vocabKnown: 2, vocabNewCorrect: 16.5,
      matRecall: 5, matComp: 4, dateRecall: 10, dateComp: 4, durationSeconds: 550
    }
  ];

  const seeded = specs.map((spec, idx) =>
    buildSeedRecord({
      ...spec,
      id: `demo_${cleanSession}_${spec.participantId}_r${spec.roundNum}`,
      createdAt: ts(idx),
      sessionCode: cleanSession
    })
  );

  // Preserva eventuali consegne reali (o di altre serate), sostituendo solo i precedenti demo seed della stessa sessione
  const existing = safeReadJsonArray(localStorage, DEMO_SUBMISSIONS_KEY);
  const kept = existing.filter(
    (item) => !(String(item?.id || "").startsWith("demo_") && String(item?.session_code || "").toUpperCase() === cleanSession)
  );
  const merged = [...kept, ...seeded];
  safeWriteJson(localStorage, DEMO_SUBMISSIONS_KEY, merged);
  return seeded;
}

/**
 * Rimuove le consegne demo locali (tutte o solo di una sessione specifica).
 * @param {string|null} [sessionCode=null]
 */
export function clearDemoSubmissions(sessionCode = null) {
  const cleanSession = String(sessionCode || "").trim().toUpperCase();
  if (!cleanSession || cleanSession === "ALL") {
    try {
      localStorage.removeItem(DEMO_SUBMISSIONS_KEY);
    } catch {
      safeWriteJson(localStorage, DEMO_SUBMISSIONS_KEY, []);
    }
    return;
  }
  const existing = safeReadJsonArray(localStorage, DEMO_SUBMISSIONS_KEY);
  const kept = existing.filter(
    (item) => String(item?.session_code || "").trim().toUpperCase() !== cleanSession
  );
  safeWriteJson(localStorage, DEMO_SUBMISSIONS_KEY, kept);
}
