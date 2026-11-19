import { APP_CONFIG } from "../config.js";
import { submitResult, flushPendingQueue, isDemoMode } from "./neon-client.js";
import {
  getParticipantProfile,
  saveParticipantProfile,
  buildAttemptKey,
  loadAttempt,
  saveAttempt,
  resolveAttemptOnLoad,
  saveHistoryEntry,
  getParticipantSessionHistory
} from "./storage.js";
import { scoreTest } from "./scoring.js";

const CATEGORIES = [
  { value: "weekend", label: "Ho fatto il corso questo weekend" },
  { value: "mesi_fa", label: "Ho fatto il corso mesi fa" },
  { value: "nessun_corso", label: "Non ho ancora fatto nessun tipo di corso" }
];

const CATEGORY_SHORT = {
  weekend: "Corso questo weekend",
  mesi_fa: "Corso mesi fa",
  nessun_corso: "Nessun corso"
};

const rootEl = document.getElementById("app-root");

let ctx = null; // { session, test, round, mode, testData, enabledSections, attempt }
let timerIntervalId = null;
let isAdvancing = false;
let lastFocusedDigitIndex = 0;

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createSubmissionId() {
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

function formatNumberIt(num) {
  const n = Number(num) || 0;
  return Number.isInteger(n) ? String(n) : String(n).replace(".", ",");
}

function formatTimer(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function parseQueryParams() {
  const params = new URLSearchParams(window.location.search);
  const fallbackSession = String(APP_CONFIG?.defaultSession || "SERATA-1")
    .trim()
    .toUpperCase() || "SERATA-1";

  const rawSession = params.get("session");
  const session = rawSession && rawSession.trim()
    ? rawSession.trim().toUpperCase()
    : fallbackSession;

  const rawTest = (params.get("test") || "A").trim().toUpperCase();
  const test = rawTest === "B" ? "B" : "A";

  const parsedRound = parseInt(params.get("round") || "1", 10);
  const round = parsedRound === 1 || parsedRound === 2 || parsedRound === 3 ? parsedRound : 1;

  const rawMode = (params.get("mode") || "full").trim().toLowerCase();
  const mode = rawMode === "recall" ? "recall" : rawMode === "study" ? "study" : "full";

  return { session, test, round, mode };
}

function clearPhaseTimer() {
  if (timerIntervalId !== null) {
    clearInterval(timerIntervalId);
    timerIntervalId = null;
  }
}

function persistAttempt() {
  if (ctx && ctx.attempt) {
    saveAttempt(ctx.attempt);
  }
}

function getCurrentSection() {
  const { enabledSections, attempt } = ctx;
  return enabledSections[attempt.sectionIndex] || null;
}

function ensureSectionAnswerContainer(section) {
  const answers = ctx.attempt.answers;
  if (!answers || typeof answers !== "object") {
    ctx.attempt.answers = {};
  }
  const existing = ctx.attempt.answers[section.id];

  switch (section.type) {
    case "digits": {
      const len = String(section.digits || "").length || 30;
      if (!Array.isArray(existing) || existing.length !== len) {
        ctx.attempt.answers[section.id] = new Array(len).fill("");
      }
      break;
    }
    case "chemistry": {
      if (section.mode === "free_draw_selfcheck" || (!section.variantQuestion && !Array.isArray(section.detailQuestions))) {
        if (!existing || typeof existing !== "object") {
          ctx.attempt.answers[section.id] = {
            subPhase: "draw",
            drawingDataUrl: "",
            photoDataUrl: "",
            usedPaper: false,
            selfEval: null
          };
        } else {
          if (existing.subPhase !== "selfcheck") existing.subPhase = "draw";
          if (typeof existing.drawingDataUrl !== "string") existing.drawingDataUrl = "";
          if (typeof existing.photoDataUrl !== "string") existing.photoDataUrl = "";
          existing.usedPaper = Boolean(existing.usedPaper);
        }
      } else {
        if (!existing || typeof existing !== "object") {
          ctx.attempt.answers[section.id] = { variantId: null, detailAnswers: {} };
        } else if (!existing.detailAnswers || typeof existing.detailAnswers !== "object") {
          existing.detailAnswers = {};
        }
      }
      break;
    }
    case "words": {
      const len = Array.isArray(section.words) ? section.words.length : 15;
      if (!Array.isArray(existing) || existing.length !== len) {
        ctx.attempt.answers[section.id] = new Array(len).fill("");
      }
      break;
    }
    case "vocab": {
      if (!existing || typeof existing !== "object") {
        ctx.attempt.answers[section.id] = {};
      }
      break;
    }
    case "math": {
      if (isMathFreeDrawMode(section)) {
        if (!existing || typeof existing !== "object" || !("subPhase" in existing)) {
          ctx.attempt.answers[section.id] = {
            freeDrawMode: true,
            subPhase: "draw",
            drawingDataUrl: "",
            photoDataUrl: "",
            usedPaper: false,
            selfEval: null
          };
        } else {
          existing.freeDrawMode = true;
          if (existing.subPhase !== "selfcheck") existing.subPhase = "draw";
          if (typeof existing.drawingDataUrl !== "string") existing.drawingDataUrl = "";
          if (typeof existing.photoDataUrl !== "string") existing.photoDataUrl = "";
          existing.usedPaper = Boolean(existing.usedPaper);
        }
        break;
      }
      if (!existing || typeof existing !== "object") {
        ctx.attempt.answers[section.id] = {
          recallAnswers: {},
          intermediate: "",
          final: ""
        };
      } else if (!existing.recallAnswers || typeof existing.recallAnswers !== "object") {
        existing.recallAnswers = {};
      }
      break;
    }
    case "dates": {
      if (!existing || typeof existing !== "object") {
        ctx.attempt.answers[section.id] = {};
      }
      break;
    }
    default:
      break;
  }
  return ctx.attempt.answers[section.id];
}

function isMathFreeDrawMode(section) {
  return Boolean(
    section &&
    section.type === "math" &&
    ctx &&
    Number(ctx.round) === 2 &&
    ctx.mode === "recall"
  );
}

function isChemistrySelfCheckActive(section, phase) {
  if (phase !== "recall" || !section) return false;
  if (isMathFreeDrawMode(section)) {
    return ctx?.attempt?.answers?.[section.id]?.subPhase === "selfcheck";
  }
  if (section.type !== "chemistry") return false;
  if (section.mode !== "free_draw_selfcheck" && (section.variantQuestion || Array.isArray(section.detailQuestions))) {
    return false;
  }
  return ctx?.attempt?.answers?.[section.id]?.subPhase === "selfcheck";
}

function renderTopBar(section, phase) {
  const { enabledSections, attempt } = ctx;
  const total = enabledSections.length;
  const currentNum = attempt.sectionIndex + 1;
  const inSelfCheck = isChemistrySelfCheckActive(section, phase);
  const phaseLabel = phase === "study" ? "Memorizzazione" : inSelfCheck ? "Confronto" : "Recupero";
  const remainingMs = inSelfCheck ? 0 : Math.max(0, (attempt.phaseEndsAt || Date.now()) - Date.now());
  const durationSec = phase === "study" ? section.studySeconds : section.recallSeconds;
  const totalMs = Math.max(1000, (Number(durationSec) || 120) * 1000);
  const pctLeft = inSelfCheck ? 0 : Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));
  const isUrgent = !inSelfCheck && remainingMs > 0 && remainingMs <= 15000;

  const dotsHtml = enabledSections
    .map((_, idx) => {
      const cls =
        idx < attempt.sectionIndex
          ? "section-dot done"
          : idx === attempt.sectionIndex
          ? "section-dot active"
          : "section-dot";
      return `<span class="${cls}"></span>`;
    })
    .join("");

  return `
    <header class="phase-topbar">
      <div class="topbar-row">
        <div class="topbar-meta">
          <span>Prova ${currentNum} di ${total}</span>
          <span aria-hidden="true">·</span>
          <span class="phase-badge ${phase}">${phaseLabel}</span>
        </div>
        <div id="phase-timer" class="timer-pill ${isUrgent ? "urgent" : ""}" aria-label="${inSelfCheck ? "Fase confronto" : "Tempo rimanente"}">
          ${inSelfCheck ? "Confronto" : formatTimer(remainingMs)}
        </div>
      </div>
      <div class="topbar-title">${escapeHtml(section.title)}</div>
      <div class="progress-track" aria-hidden="true">
        <div
          id="phase-progress-fill"
          class="progress-fill ${phase} ${isUrgent ? "urgent" : ""}"
          style="width: ${pctLeft.toFixed(1)}%"
        ></div>
      </div>
      <div class="section-dots" aria-hidden="true">${dotsHtml}</div>
    </header>
  `;
}

function startPhaseTimer(section, phase) {
  clearPhaseTimer();
  if (isChemistrySelfCheckActive(section, phase)) {
    return;
  }
  const durationSec = phase === "study" ? section.studySeconds : section.recallSeconds;
  const totalMs = Math.max(1000, (Number(durationSec) || 120) * 1000);

  const updateTick = () => {
    if (!ctx || ctx.attempt.phase !== phase) {
      clearPhaseTimer();
      return;
    }
    if (isChemistrySelfCheckActive(section, phase)) {
      clearPhaseTimer();
      return;
    }
    const stored = loadAttempt(ctx.attempt.attemptKey);
    if (
      stored &&
      stored.phase === phase &&
      stored.sectionIndex === ctx.attempt.sectionIndex &&
      Number.isFinite(Number(stored.phaseEndsAt))
    ) {
      ctx.attempt.phaseEndsAt = Number(stored.phaseEndsAt);
    }

    const now = Date.now();
    const remainingMs = Math.max(0, (ctx.attempt.phaseEndsAt || now) - now);

    const timerEl = document.getElementById("phase-timer");
    const fillEl = document.getElementById("phase-progress-fill");
    const isUrgent = remainingMs > 0 && remainingMs <= 15000;

    if (timerEl) {
      timerEl.textContent = formatTimer(remainingMs);
      timerEl.classList.toggle("urgent", isUrgent);
    }
    if (fillEl) {
      const pctLeft = Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));
      fillEl.style.width = `${pctLeft.toFixed(1)}%`;
      fillEl.classList.toggle("urgent", isUrgent);
    }

    if (remainingMs <= 0 && !isAdvancing) {
      clearPhaseTimer();
      handlePhaseTimeout();
    }
  };

  updateTick();
  timerIntervalId = setInterval(updateTick, 250);
}

function captureChemCanvasSnapshot(section) {
  if (!section || (section.type !== "chemistry" && !isMathFreeDrawMode(section))) return;
  const canvas = document.getElementById("chem-canvas");
  if (!canvas || !ctx?.attempt?.answers?.[section.id]) return;
  const chemAns = ctx.attempt.answers[section.id];
  if (canvas.dataset.hasInk === "true") {
    try {
      chemAns.drawingDataUrl = canvas.toDataURL("image/png");
    } catch {
      // ignore canvas export failure
    }
  }
}

function handlePhaseTimeout() {
  if (isAdvancing || !ctx) return;
  isAdvancing = true;
  try {
    const now = Date.now();
    const currentSec = getCurrentSection();
    if (
      ctx.attempt.phase === "recall" &&
      (
        (currentSec?.type === "chemistry" &&
          (currentSec.mode === "free_draw_selfcheck" || (!currentSec.variantQuestion && !Array.isArray(currentSec.detailQuestions)))) ||
        isMathFreeDrawMode(currentSec)
      )
    ) {
      const chemAns = ensureSectionAnswerContainer(currentSec);
      if (chemAns.subPhase !== "selfcheck") {
        captureChemCanvasSnapshot(currentSec);
        chemAns.subPhase = "selfcheck";
        persistAttempt();
        renderRecallView(currentSec);
        return;
      }
    }

    const elapsedPastEnd = now - (ctx.attempt.phaseEndsAt || now);

    if (elapsedPastEnd >= 5000) {
      const { attempt: resolved, transitionedToCompleted } = resolveAttemptOnLoad(
        ctx.attempt,
        ctx.enabledSections,
        ctx.mode,
        now
      );
      ctx.attempt = resolved;
      if (transitionedToCompleted || ctx.attempt.phase === "completed") {
        finalizeAttempt();
        return;
      }
      renderCurrentView();
    } else {
      advanceToNextPhase(now);
    }
  } finally {
    isAdvancing = false;
  }
}

function advanceToNextPhase(now = Date.now()) {
  const { attempt, enabledSections, mode } = ctx;
  const currentSec = enabledSections[attempt.sectionIndex];

  if (attempt.phase === "study" && currentSec) {
    if (mode === "study") {
      const nextIdx = attempt.sectionIndex + 1;
      if (nextIdx >= enabledSections.length) {
        finalizeAttempt();
        return;
      }
      const nextSec = enabledSections[nextIdx];
      attempt.sectionIndex = nextIdx;
      attempt.phase = "study";
      attempt.phaseStartedAt = now;
      attempt.phaseEndsAt = now + (Number(nextSec.studySeconds) || 120) * 1000;
      persistAttempt();
      renderCurrentView();
      return;
    }

    attempt.phase = "recall";
    attempt.phaseStartedAt = now;
    attempt.phaseEndsAt = now + (Number(currentSec.recallSeconds) || 120) * 1000;
    persistAttempt();
    renderCurrentView();
    return;
  }

  if (attempt.phase === "recall") {
    const nextIdx = attempt.sectionIndex + 1;
    if (nextIdx >= enabledSections.length) {
      finalizeAttempt();
      return;
    }
    const nextSec = enabledSections[nextIdx];
    const nextPhase = mode === "recall" ? "recall" : "study";
    const nextSeconds =
      nextPhase === "study" ? Number(nextSec.studySeconds) || 120 : Number(nextSec.recallSeconds) || 120;

    attempt.sectionIndex = nextIdx;
    attempt.phase = nextPhase;
    attempt.phaseStartedAt = now;
    attempt.phaseEndsAt = now + nextSeconds * 1000;
    persistAttempt();
    renderCurrentView();
  }
}

function renderOnboarding() {
  clearPhaseTimer();
  const { session, test, round, mode, testData, enabledSections, attempt } = ctx;
  const demo = isDemoMode();
  const selectedCategory = attempt.participant?.category || "";
  const nicknameValue = attempt.participant?.nickname || "";

  const totalSecCount = enabledSections.length;
  let modeBadge = `<span class="chip chip-primary">Studio + Risposta</span>`;
  let showRoundChip = true;

  if (mode === "study") {
    if (round === 1) {
      modeBadge = `<span class="chip chip-primary">Memorizzazione 1 · Senza tecniche</span>`;
      showRoundChip = false;
    } else if (round === 2) {
      modeBadge = `<span class="chip chip-primary">Memorizzazione 2 · Con tecniche</span>`;
      showRoundChip = false;
    } else {
      modeBadge = `<span class="chip chip-primary">Solo Memorizzazione</span>`;
    }
  } else if (mode === "recall") {
    if (round === 1) {
      modeBadge = `<span class="chip chip-recall-mode">Test 1 · Prima (Senza tecniche)</span>`;
      showRoundChip = false;
    } else if (round === 2) {
      modeBadge = `<span class="chip chip-recall-mode">Test 2 · Dopo (Con tecniche)</span>`;
      showRoundChip = false;
    } else {
      modeBadge = `<span class="chip chip-recall-mode">Solo Recupero</span>`;
    }
  }

  const syncBadge = demo
    ? `<span class="chip chip-demo">Modalità Demo Locale</span>`
    : `<span class="chip chip-live">Regia Live Connessa</span>`;

  const categoriesHtml = CATEGORIES.map((cat) => {
    const checked = selectedCategory === cat.value;
    return `
      <label class="category-card ${checked ? "selected" : ""}">
        <input
          type="radio"
          name="participant_category"
          value="${escapeHtml(cat.value)}"
          ${checked ? "checked" : ""}
        />
        <span class="category-label">${escapeHtml(cat.label)}</span>
      </label>
    `;
  }).join("");

  const instructionsText =
    mode === "recall"
      ? `Affronterai ${totalSecCount} prove in modalità Solo Recupero: nessuno stimolo verrà mostrato, scriverai direttamente ciò che ricordi dalla memoria entro il tempo di ogni prova.`
      : mode === "study"
      ? `Affronterai ${totalSecCount} sezioni di pura memorizzazione con timer indipendente. Non dovrai riscrivere nulla subito: il recupero verrà verificato nelle prove successive.`
      : `Affronterai ${totalSecCount} prove cronometrate. In ogni prova avrai prima la fase di Memorizzazione e poi la fase di Recupero. Allo scadere del timer si passa automaticamente avanti.`;

  rootEl.innerHTML = `
    <section class="card stack-md">
      <div class="meta-chips">
        <span class="chip chip-primary">Serata ${escapeHtml(session)}</span>
        <span class="chip">Test ${escapeHtml(test)}</span>
        ${showRoundChip ? `<span class="chip">Prova ${round}</span>` : ""}
        ${modeBadge}
        ${syncBadge}
      </div>

      <div>
        <h1 class="hero-title">${escapeHtml(testData.title || `Test ${test}`)}</h1>
        ${testData.subtitle ? `<p class="hero-subtitle">${escapeHtml(testData.subtitle)}</p>` : ""}
      </div>

      <div class="notice-box">${escapeHtml(instructionsText)}</div>

      <form id="onboarding-form" class="stack-md" novalidate>
        <div>
          <span class="field-label">Qual è la tua esperienza con il corso? *</span>
          <div class="category-list" role="radiogroup" aria-label="Categoria partecipante">
            ${categoriesHtml}
          </div>
          <div id="category-error" class="inline-error" hidden>
            Seleziona una delle tre opzioni per iniziare.
          </div>
        </div>

        <div>
          <label class="field-label" for="nickname-input">
            Nome o nickname (facoltativo)
          </label>
          <input
            id="nickname-input"
            class="text-input"
            type="text"
            maxlength="40"
            autocomplete="name"
            placeholder="Es. Marco R."
            value="${escapeHtml(nicknameValue)}"
          />
        </div>

        <button type="submit" id="start-test-btn" class="btn btn-primary btn-block">
          Avvia test
        </button>
      </form>
    </section>
  `;

  const form = document.getElementById("onboarding-form");
  const errEl = document.getElementById("category-error");
  const radioCards = form.querySelectorAll(".category-card");
  const radios = form.querySelectorAll('input[name="participant_category"]');

  radios.forEach((radio) => {
    radio.addEventListener("change", () => {
      errEl.hidden = true;
      radioCards.forEach((card) => {
        const input = card.querySelector("input");
        card.classList.toggle("selected", Boolean(input && input.checked));
      });
    });
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const chosen = form.querySelector('input[name="participant_category"]:checked');
    if (!chosen) {
      errEl.hidden = false;
      errEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
      return;
    }

    const nickname = (document.getElementById("nickname-input")?.value || "").trim();
    const category = chosen.value;

    const updatedProfile = saveParticipantProfile({ nickname, lastCategory: category });
    const now = Date.now();
    const firstSection = enabledSections[0];
    if (!firstSection) {
      finalizeAttempt();
      return;
    }

    const initialPhase = mode === "recall" ? "recall" : "study";
    const initialSeconds =
      initialPhase === "study"
        ? Number(firstSection.studySeconds) || 120
        : Number(firstSection.recallSeconds) || 120;

    ctx.attempt.participant = {
      participant_id: updatedProfile.participant_id,
      nickname: updatedProfile.nickname,
      category
    };
    ctx.attempt.testStartedAt = now;
    ctx.attempt.sectionIndex = 0;
    ctx.attempt.phase = initialPhase;
    ctx.attempt.phaseStartedAt = now;
    ctx.attempt.phaseEndsAt = now + initialSeconds * 1000;
    persistAttempt();
    renderCurrentView();
  });
}

function renderStudyView(section) {
  let bodyHtml = "";

  if (section.type === "digits") {
    const digits = Array.from(String(section.digits || ""));
    const cells = digits
      .map((d) => `<span class="digit-study-cell">${escapeHtml(d)}</span>`)
      .join("");
    bodyHtml = `
      <div class="digits-study-box">
        <div class="digits-study-grid" aria-label="Sequenza di cifre da memorizzare">
          ${cells}
        </div>
      </div>
    `;
  } else if (section.type === "chemistry") {
    bodyHtml = `
      <div class="card">
        <div class="chem-header">
          <h2 class="chem-name">${escapeHtml(section.moleculeName || "Struttura chimica")}</h2>
          ${section.formula ? `<span class="chem-formula">${escapeHtml(section.formula)}</span>` : ""}
        </div>
        <div class="chem-svg-frame">
          <img
            src="./${escapeHtml(section.studySvgPath || "")}"
            alt="${escapeHtml(section.moleculeName || "Molecola")}"
            class="chem-study-img"
          />
        </div>
      </div>
    `;
  } else if (section.type === "words") {
    // STRICT RULE: NEVER show numbers before the words in study!
    const words = Array.isArray(section.words) ? section.words : [];
    const itemsHtml = words
      .map((word, idx) => {
        const arrow = idx < words.length - 1 ? `<div class="word-study-arrow" aria-hidden="true">↓</div>` : "";
        return `
          <li class="word-study-item">
            <div class="word-study-card">
              <span class="word-study-badge" aria-hidden="true"></span>
              <span class="word-study-text">${escapeHtml(word)}</span>
            </div>
            ${arrow}
          </li>
        `;
      })
      .join("");
    bodyHtml = `<ul class="words-study-list" aria-label="Elenco parole da memorizzare nell'ordine">${itemsHtml}</ul>`;
  } else if (section.type === "vocab") {
    const items = Array.isArray(section.items) ? section.items : [];
    const cardsHtml = items
      .map((item) => {
        const langKey = String(item.language || "").toLowerCase();
        return `
          <div class="vocab-study-card">
            <div class="vocab-study-pair">
              <span class="vocab-foreign">${escapeHtml(item.foreign)}</span>
              <span class="vocab-italian">${escapeHtml(item.italian)}</span>
            </div>
            <span class="lang-pill lang-${escapeHtml(langKey)}">${escapeHtml(item.language)}</span>
          </div>
        `;
      })
      .join("");
    bodyHtml = `<div class="vocab-study-list">${cardsHtml}</div>`;
  } else if (section.type === "math") {
    bodyHtml = `
      <div class="card stack-sm">
        ${section.formulaName ? `<h2 class="section-heading">${escapeHtml(section.formulaName)}</h2>` : ""}
        <div class="math-study-body">${section.studyHtml || ""}</div>
      </div>
    `;
  } else if (section.type === "dates") {
    const items = Array.isArray(section.items) ? section.items : [];
    const cardsHtml = items
      .map((item) => {
        const prefixRe = new RegExp(`^${String(item.year)}\\s*[—–-]\\s*`);
        const cleanEvent = String(item.studyEvent || "").replace(prefixRe, "");
        return `
          <div class="date-study-card">
            <div class="date-year-badge">${escapeHtml(item.year)}</div>
            <p class="date-event-text">${escapeHtml(cleanEvent)}</p>
          </div>
        `;
      })
      .join("");
    bodyHtml = `<div class="stack-sm">${cardsHtml}</div>`;
  }

  const isLastStudy = ctx.attempt.sectionIndex === ctx.enabledSections.length - 1;
  const studyBtnLabel =
    ctx.mode === "study"
      ? isLastStudy
        ? "Completa memorizzazione ✓"
        : "Prossima sezione →"
      : "Passa alle risposte →";
  const studyHintText =
    ctx.mode === "study"
      ? "Una volta passato alla sezione successiva non potrai più tornare indietro allo stimolo."
      : "Una volta passato alle risposte non potrai più rivedere lo stimolo.";

  rootEl.innerHTML = `
    ${renderTopBar(section, "study")}
    <div class="instruction-banner study">
      ${escapeHtml(section.instructionStudy || "Memorizza con attenzione il materiale qui sotto.")}
    </div>
    ${bodyHtml}
    <div class="phase-footer">
      <button type="button" id="finish-study-btn" class="btn btn-primary btn-block">
        ${studyBtnLabel}
      </button>
      <p class="footer-hint">${studyHintText}</p>
    </div>
  `;

  window.scrollTo({ top: 0, behavior: "instant" });

  document.getElementById("finish-study-btn")?.addEventListener("click", () => {
    if (isAdvancing) return;
    isAdvancing = true;
    try {
      clearPhaseTimer();
      advanceToNextPhase(Date.now());
    } finally {
      isAdvancing = false;
    }
  });

  startPhaseTimer(section, "study");
}

function renderDigitsRecall(section, answers) {
  const len = answers.length;
  const blocksCount = Math.ceil(len / 5);
  let blocksHtml = "";

  for (let b = 0; b < blocksCount; b += 1) {
    const start = b * 5;
    const end = Math.min(len, start + 5);
    let rowHtml = "";
    for (let i = start; i < end; i += 1) {
      const val = answers[i] || "";
      rowHtml += `
        <div class="digit-slot">
          <span class="digit-slot-num">${i + 1}</span>
          <input
            type="text"
            class="digit-input ${val ? "filled" : ""}"
            data-digit-index="${i}"
            inputmode="numeric"
            pattern="[0-9]*"
            maxlength="1"
            autocomplete="off"
            aria-label="Cifra ${i + 1}"
            value="${escapeHtml(val)}"
          />
        </div>
      `;
    }
    blocksHtml += `
      <div class="digit-block">
        <div class="digit-block-title">Posizioni ${start + 1} – ${end}</div>
        <div class="digit-row">${rowHtml}</div>
      </div>
    `;
  }

  return `
    <div class="digits-toolbar">
      <span id="active-digit-indicator" class="helper-text">Casella attiva: <strong>1 / ${len}</strong></span>
      <button type="button" id="skip-digit-btn" class="btn btn-skip">
        Salta casella (lascia vuoto)
      </button>
    </div>
    <div class="digit-blocks">${blocksHtml}</div>
  `;
}

function wireDigitsRecall(section, answers) {
  const inputs = Array.from(rootEl.querySelectorAll(".digit-input"));
  const indicatorEl = document.getElementById("active-digit-indicator");
  const skipBtn = document.getElementById("skip-digit-btn");
  lastFocusedDigitIndex = 0;

  const updateIndicator = (idx) => {
    lastFocusedDigitIndex = idx;
    if (indicatorEl) {
      indicatorEl.innerHTML = `Casella attiva: <strong>${idx + 1} / ${inputs.length}</strong>`;
    }
  };

  inputs.forEach((input, idx) => {
    input.addEventListener("focus", () => {
      updateIndicator(idx);
      input.select?.();
    });

    input.addEventListener("input", (e) => {
      const raw = e.target.value || "";
      const digitsOnly = raw.replace(/\D/g, "");

      if (!digitsOnly) {
        if (raw.trim() !== "") {
          // Non-digit character typed: restore previous valid digit
          e.target.value = answers[idx] || "";
          return;
        }
        answers[idx] = "";
        e.target.value = "";
        e.target.classList.remove("filled");
        persistAttempt();
        return;
      }

      if (digitsOnly.length === 1) {
        answers[idx] = digitsOnly;
        e.target.value = digitsOnly;
        e.target.classList.add("filled");
        persistAttempt();
        if (idx + 1 < inputs.length) {
          updateIndicator(idx + 1);
          inputs[idx + 1].focus();
        }
      } else {
        let cursor = idx;
        for (const ch of digitsOnly) {
          if (cursor >= inputs.length) break;
          answers[cursor] = ch;
          inputs[cursor].value = ch;
          inputs[cursor].classList.add("filled");
          cursor += 1;
        }
        persistAttempt();
        const nextFocus = Math.min(inputs.length - 1, cursor);
        updateIndicator(nextFocus);
        inputs[nextFocus].focus();
      }
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !e.target.value && idx > 0) {
        e.preventDefault();
        updateIndicator(idx - 1);
        inputs[idx - 1].focus();
      } else if (e.key === "ArrowLeft" && idx > 0) {
        e.preventDefault();
        updateIndicator(idx - 1);
        inputs[idx - 1].focus();
      } else if (e.key === "ArrowRight" && idx + 1 < inputs.length) {
        e.preventDefault();
        updateIndicator(idx + 1);
        inputs[idx + 1].focus();
      }
    });
  });

  if (skipBtn) {
    skipBtn.addEventListener("mousedown", (e) => {
      e.preventDefault();
    });
    skipBtn.addEventListener("click", () => {
      const curr = Math.max(0, Math.min(inputs.length - 1, lastFocusedDigitIndex));
      answers[curr] = "";
      inputs[curr].value = "";
      inputs[curr].classList.remove("filled");
      persistAttempt();
      const next = Math.min(inputs.length - 1, curr + 1);
      updateIndicator(next);
      inputs[next].focus();
    });
  }
}

async function compressImageFileToDataUrl(file, maxDim = 900, quality = 0.78) {
  if (!file) {
    throw new Error("Nessun file selezionato.");
  }
  if (file.type && !file.type.startsWith("image/")) {
    throw new Error("Seleziona un file immagine valido.");
  }

  let source = null;
  let srcW = 0;
  let srcH = 0;
  let closeBitmap = null;
  let revokeUrl = null;

  try {
    if (typeof createImageBitmap === "function") {
      try {
        const bitmap = await createImageBitmap(file);
        source = bitmap;
        srcW = bitmap.width;
        srcH = bitmap.height;
        closeBitmap = () => bitmap.close?.();
      } catch {
        source = null;
      }
    }

    if (!source) {
      const objectUrl = URL.createObjectURL(file);
      revokeUrl = () => URL.revokeObjectURL(objectUrl);
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Impossibile leggere la foto selezionata."));
        el.src = objectUrl;
      });
      source = img;
      srcW = img.naturalWidth || img.width;
      srcH = img.naturalHeight || img.height;
    }

    if (!srcW || !srcH) {
      throw new Error("Dimensioni immagine non valide.");
    }

    const scale = Math.min(1, maxDim / Math.max(srcW, srcH));
    const targetW = Math.max(1, Math.round(srcW * scale));
    const targetH = Math.max(1, Math.round(srcH * scale));

    const offscreen = document.createElement("canvas");
    offscreen.width = targetW;
    offscreen.height = targetH;
    const ctx2d = offscreen.getContext("2d");
    if (!ctx2d) {
      throw new Error("Canvas non disponibile sul dispositivo.");
    }
    ctx2d.fillStyle = "#ffffff";
    ctx2d.fillRect(0, 0, targetW, targetH);
    ctx2d.drawImage(source, 0, 0, targetW, targetH);

    return offscreen.toDataURL("image/jpeg", quality);
  } finally {
    closeBitmap?.();
    revokeUrl?.();
  }
}

function renderChemistryRecall(section, answers) {
  const isFreeDraw =
    section.mode === "free_draw_selfcheck" ||
    (!section.variantQuestion && !Array.isArray(section.detailQuestions));

  if (isFreeDraw) {
    if (answers.subPhase === "selfcheck") {
      let userPanelHtml = "";
      if (answers.photoDataUrl) {
        userPanelHtml = `
          <div class="chem-compare-panel">
            <span class="field-label">La tua foto</span>
            <button
              type="button"
              class="chem-compare-frame"
              data-zoom-src="${answers.photoDataUrl}"
              data-zoom-title="La tua foto"
              aria-label="Ingrandisci la tua foto"
            >
              <img src="${answers.photoDataUrl}" alt="La tua foto della formula" class="chem-compare-img" />
            </button>
          </div>
        `;
      } else if (answers.drawingDataUrl) {
        userPanelHtml = `
          <div class="chem-compare-panel">
            <span class="field-label">Il tuo disegno</span>
            <button
              type="button"
              class="chem-compare-frame"
              data-zoom-src="${answers.drawingDataUrl}"
              data-zoom-title="Il tuo disegno"
              aria-label="Ingrandisci il tuo disegno"
            >
              <img src="${answers.drawingDataUrl}" alt="Il tuo disegno" class="chem-compare-img" />
            </button>
          </div>
        `;
      } else {
        userPanelHtml = `
          <div class="chem-compare-panel">
            <span class="field-label">Il tuo foglio</span>
            <div class="chem-paper-placeholder">
              Confronta il tuo foglio di carta con la formula a fianco.
            </div>
          </div>
        `;
      }

      const refSrc = `./${escapeHtml(section.studySvgPath || "")}`;

      return `
        <div class="card stack-md">
          <div class="chem-header" style="margin-bottom: 0;">
            <h2 class="chem-name">${escapeHtml(section.moleculeName || "Struttura chimica")}</h2>
            ${section.formula ? `<span class="chem-formula">${escapeHtml(section.formula)}</span>` : ""}
          </div>

          <div class="chem-compare-grid">
            ${userPanelHtml}

            <div class="chem-compare-panel">
              <span class="field-label">Formula corretta</span>
              <button
                type="button"
                class="chem-compare-frame"
                data-zoom-src="${refSrc}"
                data-zoom-title="Formula corretta"
                aria-label="Ingrandisci la formula corretta"
              >
                <img
                  src="${refSrc}"
                  alt="${escapeHtml(section.moleculeName || "Formula corretta")}"
                  class="chem-compare-img"
                />
              </button>
            </div>
          </div>

          <p class="chem-zoom-hint">Tocca un'immagine per ingrandirla</p>

          <div class="chem-eval-prompt">
            <p class="question-prompt" style="margin-bottom: 10px;">La struttura che hai disegnato è corretta?</p>
            <div class="chem-eval-actions">
              <button type="button" id="chem-eval-correct" class="btn btn-eval-correct" data-self-eval="correct">
                ✓ Corretta
              </button>
              <button type="button" id="chem-eval-wrong" class="btn btn-eval-wrong" data-self-eval="wrong">
                ✗ Errata
              </button>
            </div>
          </div>
        </div>

        <div id="chem-zoom-modal" class="chem-zoom-modal" role="dialog" aria-modal="true" aria-labelledby="chem-zoom-title" hidden>
          <div class="chem-zoom-dialog">
            <div class="chem-zoom-header">
              <span id="chem-zoom-title" class="chem-zoom-title"></span>
              <button type="button" id="chem-zoom-close" class="btn btn-secondary btn-sm">Chiudi</button>
            </div>
            <div class="chem-zoom-body">
              <img id="chem-zoom-img" class="chem-zoom-img" alt="" />
            </div>
          </div>
        </div>
      `;
    }

    // Step A: draw freely with ZERO reference SVG in DOM
    return `
      <div class="card stack-sm">
        <div class="chem-header" style="margin-bottom: 4px;">
          <h2 class="chem-name">${escapeHtml(section.moleculeName || "Struttura chimica")}</h2>
        </div>
        <p class="helper-text">
          Traccia liberamente la struttura sul riquadro qui sotto con il dito (oppure su un foglio di carta). Nessun aiuto verrà mostrato finché non premi «Ho finito il disegno».
        </p>

        <div class="chem-canvas-wrap">
          <canvas id="chem-canvas" class="chem-canvas" aria-label="Lavagnetta disegno struttura chimica"></canvas>
        </div>

        <div class="chem-canvas-tools">
          <button type="button" id="chem-undo-btn" class="btn btn-secondary">Annulla tratto</button>
          <button type="button" id="chem-clear-btn" class="btn btn-secondary">Pulisci</button>
        </div>

        <div class="chem-photo-box">
          <input type="file" id="chem-photo-input" accept="image/*" hidden />
          <button type="button" id="chem-photo-btn" class="btn btn-secondary btn-block">
            📷 Scatta o carica foto del foglio
          </button>
          <div id="chem-photo-preview-wrap" class="chem-photo-preview-wrap" ${answers.photoDataUrl ? "" : "hidden"}>
            <img
              id="chem-photo-thumb"
              class="chem-photo-thumb"
              src="${answers.photoDataUrl || ""}"
              alt="Anteprima foto formula"
            />
            <div class="chem-photo-preview-bar">
              <span class="helper-text">Foto pronta per il confronto affiancato</span>
              <button type="button" id="chem-photo-remove-btn" class="btn btn-secondary btn-sm">
                Rimuovi foto
              </button>
            </div>
          </div>
          <div id="chem-photo-error" class="inline-error" hidden></div>
        </div>

        <label class="known-toggle ${answers.usedPaper ? "checked" : ""}" style="justify-content: center;">
          <input
            type="checkbox"
            id="chem-paper-checkbox"
            ${answers.usedPaper ? "checked" : ""}
          />
          <span>Sto disegnando su un foglio di carta</span>
        </label>

        <button type="button" id="chem-finish-draw-btn" class="btn btn-recall-action btn-block" style="margin-top: 6px;">
          Ho finito il disegno → Confronta
        </button>
      </div>
    `;
  }

  const vq = section.variantQuestion || { prompt: "", options: [] };
  const optionsHtml = (vq.options || [])
    .map((opt) => {
      const selected = answers.variantId === opt.id;
      return `
        <button
          type="button"
          class="chem-option-card ${selected ? "selected" : ""}"
          data-variant-id="${escapeHtml(opt.id)}"
          aria-pressed="${selected ? "true" : "false"}"
        >
          <div class="chem-option-img-wrap">
            <img
              src="./${escapeHtml(opt.svgPath || "")}"
              alt="${escapeHtml(opt.label || "Opzione")}"
              class="chem-option-img"
            />
          </div>
          <span class="chem-option-label">${escapeHtml(opt.label || "")}</span>
        </button>
      `;
    })
    .join("");

  const detailQuestionsHtml = (section.detailQuestions || [])
    .map((q, qIdx) => {
      const picked = answers.detailAnswers?.[q.id] || "";
      const choicesHtml = (q.choices || [])
        .map((c) => {
          const isChecked = picked === c.id;
          return `
            <label class="choice-item ${isChecked ? "selected" : ""}">
              <input
                type="radio"
                name="chem_detail_${escapeHtml(q.id)}"
                value="${escapeHtml(c.id)}"
                data-question-id="${escapeHtml(q.id)}"
                ${isChecked ? "checked" : ""}
              />
              <span class="choice-text">${escapeHtml(c.text)}</span>
            </label>
          `;
        })
        .join("");

      return `
        <div class="question-card">
          <p class="question-prompt">${qIdx + 1}. ${escapeHtml(q.prompt)}</p>
          <div class="choice-list">${choicesHtml}</div>
        </div>
      `;
    })
    .join("");

  return `
    <div class="card card-compact stack-sm">
      <p class="question-prompt">${escapeHtml(vq.prompt || "Qual è la struttura chimica corretta?")}</p>
      <div class="chem-grid-2x2">${optionsHtml}</div>
    </div>
    ${detailQuestionsHtml}
  `;
}

function wireChemistryRecall(section, answers) {
  const isFreeDraw =
    section.mode === "free_draw_selfcheck" ||
    (!section.variantQuestion && !Array.isArray(section.detailQuestions));

  if (isFreeDraw) {
    if (answers.subPhase === "selfcheck") {
      const zoomModal = document.getElementById("chem-zoom-modal");
      const zoomTitle = document.getElementById("chem-zoom-title");
      const zoomImg = document.getElementById("chem-zoom-img");
      const zoomClose = document.getElementById("chem-zoom-close");

      const onZoomKeydown = (e) => {
        if (e.key === "Escape") {
          closeZoomModal();
        }
      };

      const closeZoomModal = () => {
        if (zoomModal) zoomModal.hidden = true;
        document.removeEventListener("keydown", onZoomKeydown);
      };

      const openZoomModal = (src, title) => {
        if (!zoomModal || !zoomImg || !src) return;
        if (zoomTitle) zoomTitle.textContent = title || "";
        zoomImg.src = src;
        zoomImg.alt = title || "Immagine ingrandita";
        zoomModal.hidden = false;
        document.removeEventListener("keydown", onZoomKeydown);
        document.addEventListener("keydown", onZoomKeydown);
        zoomClose?.focus();
      };

      const zoomButtons = Array.from(rootEl.querySelectorAll("[data-zoom-src]"));
      zoomButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
          openZoomModal(btn.getAttribute("data-zoom-src"), btn.getAttribute("data-zoom-title"));
        });
      });

      zoomClose?.addEventListener("click", closeZoomModal);
      zoomModal?.addEventListener("click", (e) => {
        if (e.target === zoomModal) {
          closeZoomModal();
        }
      });

      const evalButtons = Array.from(rootEl.querySelectorAll("[data-self-eval]"));
      evalButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
          if (isAdvancing) return;
          isAdvancing = true;
          try {
            closeZoomModal();
            answers.selfEval = btn.getAttribute("data-self-eval") === "correct" ? "correct" : "wrong";
            persistAttempt();
            clearPhaseTimer();
            advanceToNextPhase(Date.now());
          } finally {
            isAdvancing = false;
          }
        });
      });
      return;
    }

    const canvas = document.getElementById("chem-canvas");
    const undoBtn = document.getElementById("chem-undo-btn");
    const clearBtn = document.getElementById("chem-clear-btn");
    const paperCb = document.getElementById("chem-paper-checkbox");
    const finishBtn = document.getElementById("chem-finish-draw-btn");
    const photoInput = document.getElementById("chem-photo-input");
    const photoBtn = document.getElementById("chem-photo-btn");
    const photoPreviewWrap = document.getElementById("chem-photo-preview-wrap");
    const photoThumb = document.getElementById("chem-photo-thumb");
    const photoRemoveBtn = document.getElementById("chem-photo-remove-btn");
    const photoErrEl = document.getElementById("chem-photo-error");

    const strokes = [];
    let activeStroke = null;
    let baseImg = null;
    let canvasCtx = null;
    let logicalW = 320;
    let logicalH = 220;

    const redrawCanvas = () => {
      if (!canvasCtx) return;
      canvasCtx.fillStyle = "#ffffff";
      canvasCtx.fillRect(0, 0, logicalW, logicalH);
      if (baseImg) {
        canvasCtx.drawImage(baseImg, 0, 0, logicalW, logicalH);
      }
      canvasCtx.strokeStyle = "#182230";
      canvasCtx.lineWidth = 2.6;
      canvasCtx.lineCap = "round";
      canvasCtx.lineJoin = "round";
      for (const stroke of strokes) {
        if (!stroke.length) continue;
        canvasCtx.beginPath();
        canvasCtx.moveTo(stroke[0].x, stroke[0].y);
        if (stroke.length === 1) {
          canvasCtx.lineTo(stroke[0].x + 0.1, stroke[0].y + 0.1);
        } else {
          for (let i = 1; i < stroke.length; i += 1) {
            canvasCtx.lineTo(stroke[i].x, stroke[i].y);
          }
        }
        canvasCtx.stroke();
      }
      if (canvas) {
        canvas.dataset.hasInk = strokes.length > 0 || Boolean(baseImg) ? "true" : "false";
      }
    };

    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      logicalW = Math.max(260, Math.round(rect.width || 320));
      logicalH = Math.max(200, Math.round(rect.height || 230));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = logicalW * dpr;
      canvas.height = logicalH * dpr;
      canvasCtx = canvas.getContext("2d");
      if (canvasCtx) {
        canvasCtx.scale(dpr, dpr);
        redrawCanvas();
      }

      if (answers.drawingDataUrl) {
        const savedUrl = answers.drawingDataUrl;
        const img = new Image();
        img.onload = () => {
          baseImg = img;
          redrawCanvas();
        };
        img.src = savedUrl;
      }

      const getPos = (e) => {
        const r = canvas.getBoundingClientRect();
        return {
          x: ((e.clientX - r.left) / Math.max(1, r.width)) * logicalW,
          y: ((e.clientY - r.top) / Math.max(1, r.height)) * logicalH
        };
      };

      canvas.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        canvas.setPointerCapture?.(e.pointerId);
        activeStroke = [getPos(e)];
        strokes.push(activeStroke);
        redrawCanvas();
      });

      canvas.addEventListener("pointermove", (e) => {
        if (!activeStroke) return;
        e.preventDefault();
        activeStroke.push(getPos(e));
        redrawCanvas();
      });

      const endStroke = () => {
        if (!activeStroke) return;
        activeStroke = null;
        captureChemCanvasSnapshot(section);
        persistAttempt();
      };
      canvas.addEventListener("pointerup", endStroke);
      canvas.addEventListener("pointercancel", endStroke);
    }

    undoBtn?.addEventListener("click", () => {
      strokes.pop();
      redrawCanvas();
      if (canvas && canvas.dataset.hasInk === "true") {
        captureChemCanvasSnapshot(section);
      } else {
        answers.drawingDataUrl = "";
      }
      persistAttempt();
    });

    clearBtn?.addEventListener("click", () => {
      baseImg = null;
      strokes.length = 0;
      answers.drawingDataUrl = "";
      redrawCanvas();
      persistAttempt();
    });

    paperCb?.addEventListener("change", () => {
      answers.usedPaper = paperCb.checked;
      paperCb.closest(".known-toggle")?.classList.toggle("checked", paperCb.checked);
      persistAttempt();
    });

    photoBtn?.addEventListener("click", () => {
      photoInput?.click();
    });

    photoInput?.addEventListener("change", async () => {
      const file = photoInput.files?.[0];
      if (!file) return;
      if (photoErrEl) {
        photoErrEl.hidden = true;
        photoErrEl.textContent = "";
      }
      try {
        const compressedUrl = await compressImageFileToDataUrl(file, 900, 0.78);
        answers.photoDataUrl = compressedUrl;
        answers.usedPaper = true;
        if (paperCb) {
          paperCb.checked = true;
          paperCb.closest(".known-toggle")?.classList.add("checked");
        }
        if (photoThumb) {
          photoThumb.src = compressedUrl;
        }
        if (photoPreviewWrap) {
          photoPreviewWrap.hidden = false;
        }
        persistAttempt();
      } catch (err) {
        if (photoErrEl) {
          photoErrEl.textContent = err?.message || "Errore durante il caricamento della foto.";
          photoErrEl.hidden = false;
        }
      }
    });

    photoRemoveBtn?.addEventListener("click", () => {
      answers.photoDataUrl = "";
      if (photoInput) photoInput.value = "";
      if (photoThumb) photoThumb.removeAttribute("src");
      if (photoPreviewWrap) photoPreviewWrap.hidden = true;
      if (photoErrEl) {
        photoErrEl.hidden = true;
        photoErrEl.textContent = "";
      }
      persistAttempt();
    });

    finishBtn?.addEventListener("click", () => {
      if (isAdvancing) return;
      isAdvancing = true;
      try {
        clearPhaseTimer();
        captureChemCanvasSnapshot(section);
        answers.subPhase = "selfcheck";
        persistAttempt();
        renderRecallView(section);
      } finally {
        isAdvancing = false;
      }
    });

    return;
  }

  const optionBtns = Array.from(rootEl.querySelectorAll(".chem-option-card"));
  optionBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const vid = btn.getAttribute("data-variant-id");
      answers.variantId = vid;
      persistAttempt();
      optionBtns.forEach((other) => {
        const active = other.getAttribute("data-variant-id") === vid;
        other.classList.toggle("selected", active);
        other.setAttribute("aria-pressed", active ? "true" : "false");
      });
    });
  });

  const radios = Array.from(rootEl.querySelectorAll('input[data-question-id]'));
  radios.forEach((radio) => {
    radio.addEventListener("change", () => {
      const qid = radio.getAttribute("data-question-id");
      answers.detailAnswers[qid] = radio.value;
      persistAttempt();
      const group = rootEl.querySelectorAll(`input[name="${radio.name}"]`);
      group.forEach((r) => {
        r.closest(".choice-item")?.classList.toggle("selected", r.checked);
      });
    });
  });
}

function renderWordsRecall(section, answers) {
  const rowsHtml = answers
    .map(
      (val, idx) => `
        <div class="word-recall-row">
          <span class="word-recall-index">${idx + 1}</span>
          <input
            type="text"
            class="text-input word-recall-input"
            data-word-index="${idx}"
            autocomplete="off"
            autocorrect="off"
            spellcheck="false"
            placeholder="Parola ${idx + 1}"
            aria-label="Parola posizione ${idx + 1}"
            value="${escapeHtml(val)}"
          />
        </div>
      `
    )
    .join("");
  return `<div class="card card-compact"><div class="words-recall-list">${rowsHtml}</div></div>`;
}

function wireWordsRecall(answers) {
  const inputs = Array.from(rootEl.querySelectorAll(".word-recall-input"));
  inputs.forEach((input) => {
    input.addEventListener("input", () => {
      const idx = parseInt(input.getAttribute("data-word-index"), 10);
      answers[idx] = input.value;
      persistAttempt();
    });
  });
}

function renderVocabCard(item, idx, answers) {
  const entry = answers[item.id] || { answer: "", alreadyKnown: false };
  const langKey = String(item.language || "").toLowerCase();
  return `
    <div class="vocab-recall-card">
      <div class="vocab-recall-head">
        <div>
          <span class="lang-pill lang-${escapeHtml(langKey)}">${escapeHtml(item.language)}</span>
          <div class="vocab-prompt-word">${idx + 1}. ${escapeHtml(item.italian)}</div>
        </div>
        <label class="known-toggle ${entry.alreadyKnown ? "checked" : ""}">
          <input
            type="checkbox"
            class="vocab-known-checkbox"
            data-vocab-id="${escapeHtml(item.id)}"
            ${entry.alreadyKnown ? "checked" : ""}
          />
          <span>Già nota</span>
        </label>
      </div>
      <input
        type="text"
        class="text-input vocab-answer-input"
        data-vocab-id="${escapeHtml(item.id)}"
        autocomplete="off"
        autocorrect="off"
        autocapitalize="none"
        spellcheck="false"
        placeholder="Scrivi in ${escapeHtml(item.language)}…"
        aria-label="${escapeHtml(item.italian)} in ${escapeHtml(item.language)}"
        value="${escapeHtml(entry.answer || "")}"
      />
    </div>
  `;
}

function renderVocabRecall(section, answers) {
  const items = Array.isArray(section.items) ? section.items : [];
  const itemById = new Map(items.map((item) => [item.id, item]));
  const orderIds =
    Array.isArray(section.recallOrder) && section.recallOrder.length > 0
      ? section.recallOrder
      : items.map((item) => item.id);

  const orderedItems = orderIds.map((id) => itemById.get(id)).filter(Boolean);
  let bodyHtml = "";

  if (section.groupByLanguageInRecall) {
    const groups = new Map();
    for (const item of orderedItems) {
      const lang = String(item.language || "Altro");
      if (!groups.has(lang)) groups.set(lang, []);
      groups.get(lang).push(item);
    }

    let runningIdx = 0;
    const sectionsHtml = [];
    for (const [lang, groupItems] of groups.entries()) {
      const langKey = lang.toLowerCase();
      const cardsHtml = groupItems
        .map((item) => {
          const card = renderVocabCard(item, runningIdx, answers);
          runningIdx += 1;
          return card;
        })
        .join("");

      sectionsHtml.push(`
        <div class="vocab-lang-group">
          <div class="vocab-lang-group-head">
            <span class="lang-pill lang-${escapeHtml(langKey)}">${escapeHtml(lang)}</span>
            <span class="helper-text">${groupItems.length} vocaboli</span>
          </div>
          ${cardsHtml}
        </div>
      `);
    }
    bodyHtml = sectionsHtml.join("");
  } else {
    bodyHtml = orderedItems.map((item, idx) => renderVocabCard(item, idx, answers)).join("");
  }

  return `
    <div class="notice-box" style="margin-bottom: 12px;">
      Spunta <strong>Già nota</strong> se conoscevi già il vocabolo prima del test (serve a misurare i vocaboli nuovi appresi).
    </div>
    <div>${bodyHtml}</div>
  `;
}

function wireVocabRecall(answers) {
  const textInputs = Array.from(rootEl.querySelectorAll(".vocab-answer-input"));
  textInputs.forEach((input) => {
    input.addEventListener("input", () => {
      const id = input.getAttribute("data-vocab-id");
      if (!answers[id] || typeof answers[id] !== "object") {
        answers[id] = { answer: "", alreadyKnown: false };
      }
      answers[id].answer = input.value;
      persistAttempt();
    });
  });

  const checkboxes = Array.from(rootEl.querySelectorAll(".vocab-known-checkbox"));
  checkboxes.forEach((cb) => {
    cb.addEventListener("change", () => {
      const id = cb.getAttribute("data-vocab-id");
      if (!answers[id] || typeof answers[id] !== "object") {
        answers[id] = { answer: "", alreadyKnown: false };
      }
      answers[id].alreadyKnown = cb.checked;
      cb.closest(".known-toggle")?.classList.toggle("checked", cb.checked);
      persistAttempt();
    });
  });
}

function renderMathRecall(section, answers) {
  if (isMathFreeDrawMode(section)) {
    if (answers.subPhase === "selfcheck") {
      let userPanelHtml = "";
      if (answers.photoDataUrl) {
        userPanelHtml = `
          <div class="chem-compare-panel">
            <span class="field-label">La tua foto</span>
            <button
              type="button"
              class="chem-compare-frame"
              data-zoom-src="${answers.photoDataUrl}"
              data-zoom-title="La tua foto"
              aria-label="Ingrandisci la tua foto"
            >
              <img src="${answers.photoDataUrl}" alt="La tua foto della formula" class="chem-compare-img" />
            </button>
          </div>
        `;
      } else if (answers.drawingDataUrl) {
        userPanelHtml = `
          <div class="chem-compare-panel">
            <span class="field-label">Il tuo disegno</span>
            <button
              type="button"
              class="chem-compare-frame"
              data-zoom-src="${answers.drawingDataUrl}"
              data-zoom-title="Il tuo disegno"
              aria-label="Ingrandisci il tuo disegno"
            >
              <img src="${answers.drawingDataUrl}" alt="Il tuo disegno" class="chem-compare-img" />
            </button>
          </div>
        `;
      } else {
        userPanelHtml = `
          <div class="chem-compare-panel">
            <span class="field-label">Il tuo foglio</span>
            <div class="chem-paper-placeholder">
              Confronta il tuo foglio di carta con la formula a fianco.
            </div>
          </div>
        `;
      }

      const isErone = /erone/i.test(String(section.formulaName || ""));
      const mathRefHtml = isErone
        ? `
          <div class="math-ref-main">A = &radic;[p &middot; (p &minus; a) &middot; (p &minus; b) &middot; (p &minus; c)]</div>
          <div class="math-ref-sub">p = (a + b + c) / 2</div>
        `
        : `
          <div class="math-ref-main">d(P, r) = |a&middot;x<sub>0</sub> + b&middot;y<sub>0</sub> + c| / &radic;(a<sup>2</sup> + b<sup>2</sup>)</div>
          <div class="math-ref-sub">a&middot;x + b&middot;y + c = 0</div>
        `;

      return `
        <div class="card stack-md">
          <div class="chem-header" style="margin-bottom: 0;">
            <h2 class="chem-name">${escapeHtml(section.formulaName || "Formula matematica")}</h2>
          </div>

          <div class="chem-compare-grid">
            ${userPanelHtml}

            <div class="chem-compare-panel">
              <span class="field-label">Formula corretta</span>
              <div class="chem-compare-frame chem-compare-frame--math">
                ${mathRefHtml}
              </div>
            </div>
          </div>

          ${answers.photoDataUrl || answers.drawingDataUrl ? `<p class="chem-zoom-hint">Tocca la tua immagine per ingrandirla</p>` : ""}

          <div class="chem-eval-prompt">
            <p class="question-prompt" style="margin-bottom: 10px;">La formula che hai scritto è corretta?</p>
            <div class="chem-eval-actions">
              <button type="button" id="chem-eval-correct" class="btn btn-eval-correct" data-self-eval="correct">
                ✓ Corretta
              </button>
              <button type="button" id="chem-eval-wrong" class="btn btn-eval-wrong" data-self-eval="wrong">
                ✗ Errata
              </button>
            </div>
          </div>
        </div>

        <div id="chem-zoom-modal" class="chem-zoom-modal" role="dialog" aria-modal="true" aria-labelledby="chem-zoom-title" hidden>
          <div class="chem-zoom-dialog">
            <div class="chem-zoom-header">
              <span id="chem-zoom-title" class="chem-zoom-title"></span>
              <button type="button" id="chem-zoom-close" class="btn btn-secondary btn-sm">Chiudi</button>
            </div>
            <div class="chem-zoom-body">
              <img id="chem-zoom-img" class="chem-zoom-img" alt="" />
            </div>
          </div>
        </div>
      `;
    }

    // Step A: scrivi/disegna la formula senza alcun aiuto nel DOM
    return `
      <div class="card stack-sm">
        <div class="chem-header" style="margin-bottom: 4px;">
          <h2 class="chem-name">${escapeHtml(section.formulaName || "Formula matematica")}</h2>
        </div>
        <p class="helper-text">
          Scrivi liberamente la formula sul riquadro qui sotto con il dito (oppure su un foglio di carta). Nessun aiuto verrà mostrato finché non premi «Ho finito → Confronta».
        </p>

        <div class="chem-canvas-wrap">
          <canvas id="chem-canvas" class="chem-canvas" aria-label="Lavagnetta formula matematica"></canvas>
        </div>

        <div class="chem-canvas-tools">
          <button type="button" id="chem-undo-btn" class="btn btn-secondary">Annulla tratto</button>
          <button type="button" id="chem-clear-btn" class="btn btn-secondary">Pulisci</button>
        </div>

        <div class="chem-photo-box">
          <input type="file" id="chem-photo-input" accept="image/*" hidden />
          <button type="button" id="chem-photo-btn" class="btn btn-secondary btn-block">
            📷 Scatta o carica foto del foglio
          </button>
          <div id="chem-photo-preview-wrap" class="chem-photo-preview-wrap" ${answers.photoDataUrl ? "" : "hidden"}>
            <img
              id="chem-photo-thumb"
              class="chem-photo-thumb"
              src="${answers.photoDataUrl || ""}"
              alt="Anteprima foto formula"
            />
            <div class="chem-photo-preview-bar">
              <span class="helper-text">Foto pronta per il confronto affiancato</span>
              <button type="button" id="chem-photo-remove-btn" class="btn btn-secondary btn-sm">
                Rimuovi foto
              </button>
            </div>
          </div>
          <div id="chem-photo-error" class="inline-error" hidden></div>
        </div>

        <label class="known-toggle ${answers.usedPaper ? "checked" : ""}" style="justify-content: center;">
          <input
            type="checkbox"
            id="chem-paper-checkbox"
            ${answers.usedPaper ? "checked" : ""}
          />
          <span>Sto scrivendo su un foglio di carta</span>
        </label>

        <button type="button" id="chem-finish-draw-btn" class="btn btn-recall-action btn-block" style="margin-top: 6px;">
          Ho finito → Confronta
        </button>
      </div>
    `;
  }

  const recallQuestions = Array.isArray(section.recallQuestions) ? section.recallQuestions : [];
  const recallHtml = recallQuestions
    .map((q, qIdx) => {
      const picked = answers.recallAnswers?.[q.id] || "";
      const choicesHtml = (q.choices || [])
        .map((c) => {
          const isChecked = picked === c.id;
          return `
            <label class="choice-item ${isChecked ? "selected" : ""}">
              <input
                type="radio"
                name="math_q_${escapeHtml(q.id)}"
                value="${escapeHtml(c.id)}"
                data-math-qid="${escapeHtml(q.id)}"
                ${isChecked ? "checked" : ""}
              />
              <span class="choice-text">${escapeHtml(c.text)}</span>
            </label>
          `;
        })
        .join("");

      return `
        <div class="question-card">
          <p class="question-prompt">${qIdx + 1}. ${escapeHtml(q.prompt)}</p>
          <div class="choice-list">${choicesHtml}</div>
        </div>
      `;
    })
    .join("");

  const app = section.applicationProblem || {};
  const intermediateHtml =
    app.intermediatePrompt
      ? `
        <div>
          <label class="field-label" for="math-intermediate-input">
            ${escapeHtml(app.intermediatePrompt)}
          </label>
          <input
            id="math-intermediate-input"
            class="text-input"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            placeholder="Inserisci un numero"
            value="${escapeHtml(answers.intermediate || "")}"
          />
        </div>
      `
      : "";

  const appHtml = `
    <div class="math-app-card stack-sm">
      <p class="question-prompt" style="margin-bottom: 2px;">Applicazione della formula memorizzata</p>
      <p class="helper-text" style="color: var(--text); font-weight: 600;">${escapeHtml(app.promptText || "")}</p>
      ${intermediateHtml}
      <div>
        <label class="field-label" for="math-final-input">
          ${escapeHtml(app.finalPrompt || "Risultato finale")}
        </label>
        <input
          id="math-final-input"
          class="text-input"
          type="text"
          inputmode="decimal"
          autocomplete="off"
          placeholder="Scrivi il risultato"
          value="${escapeHtml(answers.final || "")}"
        />
      </div>
    </div>
  `;

  return `${recallHtml}${appHtml}`;
}

function wireMathRecall(answers) {
  const radios = Array.from(rootEl.querySelectorAll("input[data-math-qid]"));
  radios.forEach((radio) => {
    radio.addEventListener("change", () => {
      const qid = radio.getAttribute("data-math-qid");
      answers.recallAnswers[qid] = radio.value;
      persistAttempt();
      const group = rootEl.querySelectorAll(`input[name="${radio.name}"]`);
      group.forEach((r) => {
        r.closest(".choice-item")?.classList.toggle("selected", r.checked);
      });
    });
  });

  const interInput = document.getElementById("math-intermediate-input");
  const finalInput = document.getElementById("math-final-input");

  interInput?.addEventListener("input", () => {
    answers.intermediate = interInput.value;
    persistAttempt();
  });

  finalInput?.addEventListener("input", () => {
    answers.final = finalInput.value;
    persistAttempt();
  });
}

function renderDatesRecall(section, answers) {
  const items = Array.isArray(section.items) ? section.items : [];
  const itemById = new Map(items.map((item) => [item.id, item]));
  const orderIds =
    Array.isArray(section.recallOrder) && section.recallOrder.length > 0
      ? section.recallOrder
      : items.map((item) => item.id);

  const orderedItems = orderIds.map((id) => itemById.get(id)).filter(Boolean);

  return orderedItems
    .map((item, idx) => {
      const entry = answers[item.id] || { year: "", detailChoiceId: "" };
      const choicesHtml = (item.detailChoices || [])
        .map((c) => {
          const isChecked = entry.detailChoiceId === c.id;
          return `
            <label class="choice-item ${isChecked ? "selected" : ""}">
              <input
                type="radio"
                name="date_detail_${escapeHtml(item.id)}"
                value="${escapeHtml(c.id)}"
                data-date-id="${escapeHtml(item.id)}"
                ${isChecked ? "checked" : ""}
              />
              <span class="choice-text">${escapeHtml(c.text)}</span>
            </label>
          `;
        })
        .join("");

      return `
        <div class="date-recall-card stack-sm">
          <p class="date-recall-event">${idx + 1}. ${escapeHtml(item.recallPrompt)}</p>
          <div>
            <label class="field-label" for="date-year-${escapeHtml(item.id)}">Anno esatto (4 cifre)</label>
            <input
              id="date-year-${escapeHtml(item.id)}"
              class="text-input date-year-input"
              data-date-id="${escapeHtml(item.id)}"
              type="text"
              inputmode="numeric"
              pattern="[0-9]*"
              maxlength="8"
              autocomplete="off"
              placeholder="AAAA"
              value="${escapeHtml(entry.year || "")}"
            />
          </div>
          <div>
            <span class="field-label">${escapeHtml(item.detailQuestion || "Dettaglio dell'evento")}</span>
            <div class="choice-list">${choicesHtml}</div>
          </div>
        </div>
      `;
    })
    .join("");
}

function wireDatesRecall(answers) {
  const yearInputs = Array.from(rootEl.querySelectorAll(".date-year-input"));
  yearInputs.forEach((input) => {
    input.addEventListener("input", () => {
      const id = input.getAttribute("data-date-id");
      const digitsOnly = (input.value || "").replace(/\D/g, "").slice(0, 4);
      input.value = digitsOnly;
      if (!answers[id] || typeof answers[id] !== "object") {
        answers[id] = { year: "", detailChoiceId: "" };
      }
      answers[id].year = digitsOnly;
      persistAttempt();
    });
  });

  const radios = Array.from(rootEl.querySelectorAll("input[data-date-id]"));
  radios.forEach((radio) => {
    radio.addEventListener("change", () => {
      const id = radio.getAttribute("data-date-id");
      if (!answers[id] || typeof answers[id] !== "object") {
        answers[id] = { year: "", detailChoiceId: "" };
      }
      answers[id].detailChoiceId = radio.value;
      persistAttempt();
      const group = rootEl.querySelectorAll(`input[name="${radio.name}"]`);
      group.forEach((r) => {
        r.closest(".choice-item")?.classList.toggle("selected", r.checked);
      });
    });
  });
}

function renderRecallView(section) {
  const answers = ensureSectionAnswerContainer(section);
  const isLast = ctx.attempt.sectionIndex === ctx.enabledSections.length - 1;
  let bodyHtml = "";

  switch (section.type) {
    case "digits":
      bodyHtml = renderDigitsRecall(section, answers);
      break;
    case "chemistry":
      bodyHtml = renderChemistryRecall(section, answers);
      break;
    case "words":
      bodyHtml = renderWordsRecall(section, answers);
      break;
    case "vocab":
      bodyHtml = renderVocabRecall(section, answers);
      break;
    case "math":
      bodyHtml = renderMathRecall(section, answers);
      break;
    case "dates":
      bodyHtml = renderDatesRecall(section, answers);
      break;
    default:
      bodyHtml = `<div class="card">Sezione non riconosciuta.</div>`;
  }

  const isChemFreeDraw =
    section.type === "chemistry" &&
    (section.mode === "free_draw_selfcheck" || (!section.variantQuestion && !Array.isArray(section.detailQuestions)));
  const isFreeDrawRecall = isChemFreeDraw || isMathFreeDrawMode(section);

  const footerHtml = isFreeDrawRecall
    ? ""
    : `
      <div class="phase-footer">
        <button type="button" id="submit-section-btn" class="btn btn-recall-action btn-block">
          ${isLast ? "Consegna il test e vedi il risultato ✓" : "Conferma e passa alla prova successiva →"}
        </button>
      </div>
    `;

  const instructionBannerText = isChemistrySelfCheckActive(section, "recall")
    ? "Confronta ciò che hai scritto/disegnato (a sinistra) con la versione corretta (a destra) e indica se è corretta o errata."
    : isMathFreeDrawMode(section)
    ? "Scrivi liberamente la formula memorizzata (su schermo o su carta) senza aiuti. Al termine potrai confrontarla con quella corretta."
    : section.instructionRecall || "Inserisci ciò che ricordi prima dello scadere del tempo.";

  rootEl.innerHTML = `
    ${renderTopBar(section, "recall")}
    <div class="instruction-banner recall">
      ${escapeHtml(instructionBannerText)}
    </div>
    ${bodyHtml}
    ${footerHtml}
  `;

  window.scrollTo({ top: 0, behavior: "instant" });

  switch (section.type) {
    case "digits":
      wireDigitsRecall(section, answers);
      break;
    case "chemistry":
      wireChemistryRecall(section, answers);
      break;
    case "words":
      wireWordsRecall(answers);
      break;
    case "vocab":
      wireVocabRecall(answers);
      break;
    case "math":
      if (isMathFreeDrawMode(section)) {
        wireChemistryRecall(section, answers);
      } else {
        wireMathRecall(answers);
      }
      break;
    case "dates":
      wireDatesRecall(answers);
      break;
    default:
      break;
  }

  document.getElementById("submit-section-btn")?.addEventListener("click", () => {
    if (isAdvancing) return;
    isAdvancing = true;
    try {
      clearPhaseTimer();
      advanceToNextPhase(Date.now());
    } finally {
      isAdvancing = false;
    }
  });

  startPhaseTimer(section, "recall");
}

function buildPayload(scoreResult, completedAt) {
  const { session, test, round, mode, attempt } = ctx;
  const startedAt = attempt.testStartedAt || completedAt;
  const durationSeconds = Math.max(0, Math.round((completedAt - startedAt) / 1000));
  if (!attempt.submissionId) {
    attempt.submissionId = createSubmissionId();
  }

  return {
    id: attempt.submissionId,
    session_code: session,
    test_id: test,
    round_num: round,
    mode,
    participant_id: attempt.participant.participant_id,
    nickname: attempt.participant.nickname || "",
    category: attempt.participant.category,
    score_total: scoreResult.score_total,
    max_total: scoreResult.max_total,
    pct_total: scoreResult.pct_total,
    score_recall: scoreResult.score_recall,
    max_recall: scoreResult.max_recall,
    pct_recall: scoreResult.pct_recall,
    score_comprehension: scoreResult.score_comprehension,
    max_comprehension: scoreResult.max_comprehension,
    pct_comprehension: scoreResult.pct_comprehension,
    vocab_known_count: scoreResult.vocab_known_count,
    vocab_new_correct: scoreResult.vocab_new_correct,
    vocab_new_total: scoreResult.vocab_new_total,
    digits_shift_detected: scoreResult.digits_shift_detected,
    section_scores: scoreResult.section_scores,
    duration_seconds: durationSeconds
  };
}

async function dispatchSubmission(payload) {
  try {
    const res = await submitResult(payload);
    ctx.attempt.submission = {
      ...ctx.attempt.submission,
      status: res.ok ? "sent" : res.queued ? "queued" : "error",
      mode: res.mode,
      resultId: res.id || null,
      queued: Boolean(res.queued)
    };
  } catch {
    ctx.attempt.submission = {
      ...ctx.attempt.submission,
      status: "error",
      mode: isDemoMode() ? "local" : "neon",
      queued: false
    };
  }
  persistAttempt();
  updateSubmissionBanner();
}

async function retrySubmission() {
  if (!ctx?.attempt?.submission) return;
  const sub = ctx.attempt.submission;
  sub.status = "sending";
  persistAttempt();
  updateSubmissionBanner();

  try {
    if (sub.queued) {
      const flushed = await flushPendingQueue();
      if (flushed > 0) {
        sub.status = "sent";
        sub.queued = false;
        persistAttempt();
        updateSubmissionBanner();
        return;
      }
      sub.status = "queued";
      persistAttempt();
      updateSubmissionBanner();
      return;
    }
    await dispatchSubmission(sub.payload);
  } catch {
    sub.status = sub.queued ? "queued" : "error";
    persistAttempt();
    updateSubmissionBanner();
  }
}

function updateSubmissionBanner() {
  const banner = document.getElementById("submission-banner");
  if (!banner || !ctx?.attempt?.submission) return;

  const sub = ctx.attempt.submission;
  if (sub.status === "sending") {
    banner.className = "status-banner sending";
    banner.innerHTML = `<span>Invio risultato alla regia in corso…</span>`;
    return;
  }

  if (sub.status === "sent") {
    if (sub.mode === "local") {
      banner.className = "status-banner local";
      banner.innerHTML = `<span>Risultato salvato in modalità demo locale ✓</span>`;
    } else {
      banner.className = "status-banner success";
      banner.innerHTML = `<span>Risultato inviato alla regia live ✓</span>`;
    }
    return;
  }

  banner.className = "status-banner warning";
  banner.innerHTML = `
    <span>Connessione assente: risultato salvato in coda sul dispositivo.</span>
    <button type="button" id="retry-submit-btn" class="btn btn-secondary" style="min-height: 44px; padding: 8px 14px; font-size: 0.9rem;">
      Riprova invio
    </button>
  `;
  document.getElementById("retry-submit-btn")?.addEventListener("click", () => {
    retrySubmission();
  });
}

function renderCompletedStudyView() {
  clearPhaseTimer();
  const { session, test, round, enabledSections, attempt } = ctx;
  const startedAt = attempt.testStartedAt || attempt.completedAt || Date.now();
  const durationSeconds = Math.max(0, Math.round(((attempt.completedAt || Date.now()) - startedAt) / 1000));
  const mins = Math.floor(durationSeconds / 60);
  const secs = durationSeconds % 60;
  const durationLabel = `${mins}m ${String(secs).padStart(2, "0")}s`;
  const catLabel = CATEGORY_SHORT[attempt.participant?.category] || attempt.participant?.category || "";
  const nick = attempt.participant?.nickname;
  const studyStageChip =
    round === 1
      ? "Memorizzazione 1 · Senza tecniche"
      : round === 2
      ? "Memorizzazione 2 · Con tecniche"
      : `Memorizzazione · Prova ${round}`;

  rootEl.innerHTML = `
    <section class="card score-hero stack-md">
      <div class="meta-chips" style="justify-content: center;">
        <span class="chip chip-primary">Serata ${escapeHtml(session)}</span>
        <span class="chip">Test ${escapeHtml(test)}</span>
        <span class="chip chip-primary">${escapeHtml(studyStageChip)}</span>
        ${catLabel ? `<span class="chip">${escapeHtml(catLabel)}</span>` : ""}
        ${nick ? `<span class="chip">${escapeHtml(nick)}</span>` : ""}
      </div>

      <h1 class="hero-title" style="margin-top: 6px;">Memorizzazione completata! ✓</h1>
      <p class="helper-text" style="font-size: 0.98rem;">
        Hai completato tutte le ${enabledSections.length} sezioni di memorizzazione in <strong>${durationLabel}</strong>.
      </p>

      <div class="notice-box" style="text-align: left;">
        Non devi scrivere altro adesso. Attendi il prossimo <strong>QR Code</strong> proiettato dallo speaker per fare il test di verifica: il tuo profilo resta salvato su questo telefono.
      </div>
    </section>
  `;

  window.scrollTo({ top: 0, behavior: "instant" });
}

function finalizeAttempt() {
  clearPhaseTimer();
  const now = Date.now();
  const { attempt, testData, mode } = ctx;
  const completedAt = attempt.completedAt || now;
  attempt.phase = "completed";
  attempt.completedAt = completedAt;

  if (mode === "study") {
    persistAttempt();
    renderCompletedStudyView();
    return;
  }

  const scoreResult = scoreTest(testData, attempt.answers);
  const payload = buildPayload(scoreResult, completedAt);

  saveHistoryEntry({
    ...payload,
    completed_at: new Date(completedAt).toISOString()
  });

  if (!attempt.submission || (attempt.submission.status !== "sent" && attempt.submission.status !== "queued")) {
    attempt.submission = {
      status: "sending",
      mode: isDemoMode() ? "local" : "neon",
      resultId: attempt.submissionId || null,
      queued: false,
      payload,
      scoreResult
    };
    persistAttempt();
    renderCompletedView(scoreResult);
    dispatchSubmission(payload);
  } else {
    attempt.submission.payload = payload;
    attempt.submission.scoreResult = scoreResult;
    persistAttempt();
    renderCompletedView(scoreResult);
    if (attempt.submission.status === "queued") {
      retrySubmission();
    }
  }
}

function renderCompletedView(scoreResult) {
  clearPhaseTimer();
  const { session, test, round, enabledSections, attempt } = ctx;
  const sub = attempt.submission || {};
  const sr = scoreResult || sub.scoreResult || scoreTest(ctx.testData, attempt.answers);

  // Ring geometry (r = 62 -> C = 2 * pi * 62 = 389.557)
  const radius = 62;
  const circumference = 2 * Math.PI * radius;
  const clampedPct = Math.max(0, Math.min(100, sr.pct_total));
  const dashOffset = circumference * (1 - clampedPct / 100);

  const sectionBarsHtml = enabledSections
    .map((sec) => {
      const s = sr.section_scores[sec.id] || { score: 0, max: 0, pct: 0 };
      return `
        <div class="section-bar-row">
          <div class="section-bar-top">
            <span class="section-bar-name">${escapeHtml(sec.title)}</span>
            <span class="section-bar-score">
              ${formatNumberIt(s.score)} / ${formatNumberIt(s.max)} pt (${formatNumberIt(s.pct)}%)
            </span>
          </div>
          <div class="section-bar-track">
            <div class="section-bar-fill" style="width: ${Math.max(0, Math.min(100, s.pct))}%"></div>
          </div>
        </div>
      `;
    })
    .join("");

  const vocabEnabled = Boolean(sr.section_scores.vocaboli);
  let vocabCardHtml = "";
  if (vocabEnabled) {
    const newTotal = sr.vocab_new_total;
    const newCorrect = sr.vocab_new_correct;
    const knownCount = sr.vocab_known_count;
    const newPct = newTotal > 0 ? Math.round((newCorrect / newTotal) * 1000) / 10 : null;
    const valueText =
      newTotal > 0
        ? `${formatNumberIt(newCorrect)} / ${newTotal} (${formatNumberIt(newPct)}%)`
        : "Tutti già noti";

    vocabCardHtml = `
      <div class="vocab-highlight-card">
        <div>
          <div class="section-bar-name">Vocaboli nuovi appresi</div>
          <div class="helper-text">${knownCount} già noti esclusi da questo indicatore</div>
        </div>
        <div class="vocab-highlight-value">${escapeHtml(valueText)}</div>
      </div>
    `;
  }

  const shiftHtml = sr.digits_shift_detected
    ? `
      <div class="shift-note-box">
        <strong>Nota formativa sulle cifre:</strong> rilevato un possibile slittamento di 1 casella (${sr.digits_shifted_matches} cifre coerenti traslate). Il punteggio ufficiale resta posizionale, ma è un segnale molto positivo!
      </div>
    `
    : "";

  const history = getParticipantSessionHistory(attempt.participant.participant_id, session);
  const hasPreviousOrMultiple = history.length > 1;
  let progressionHtml = "";
  if (hasPreviousOrMultiple) {
    const first = history[0];
    const latest = history[history.length - 1];
    const delta = Math.round((Number(latest.pct_total) - Number(first.pct_total)) * 10) / 10;
    const deltaClass = delta > 0 ? "positive" : delta < 0 ? "negative" : "neutral";
    const deltaSign = delta > 0 ? "+" : "";

    const rows = history
      .map((entry) => {
        const isCurrent =
          Number(entry.round_num) === Number(round) && String(entry.test_id) === String(test);
        const rNum = Number(entry.round_num);
        const rowLabel =
          rNum === 1
            ? "Prima (Senza tecniche)"
            : rNum === 2
            ? "Dopo (Con tecniche)"
            : `Prova ${escapeHtml(entry.round_num)}`;
        return `
          <div class="progression-item ${isCurrent ? "current" : ""}">
            <div>
              <strong>${rowLabel}</strong>
              <span class="helper-text"> · Test ${escapeHtml(entry.test_id)}</span>
            </div>
            <div>
              <strong>${formatNumberIt(entry.pct_total)}%</strong>
              <span class="helper-text"> (${formatNumberIt(entry.score_total)}/${formatNumberIt(entry.max_total)})</span>
            </div>
          </div>
        `;
      })
      .join("");

    progressionHtml = `
      <section class="card">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;">
          <h2 class="section-heading" style="margin: 0;">La tua progressione in questa serata</h2>
          <span class="delta-badge ${deltaClass}">${deltaSign}${formatNumberIt(delta)}%</span>
        </div>
        <div class="progression-list">${rows}</div>
      </section>
    `;
  }

  const catLabel = CATEGORY_SHORT[attempt.participant?.category] || attempt.participant?.category || "";
  const nick = attempt.participant?.nickname;
  const heroPhaseLabel =
    round === 1
      ? "Prima (Senza tecniche)"
      : round === 2
      ? "Dopo (Con tecniche)"
      : `Prova ${round}`;

  // STRICT RULE: NEVER render any exact answers, digits, words, vocab translations, years, or math solutions here!
  rootEl.innerHTML = `
    <div id="submission-banner" class="status-banner sending">
      <span>Verifica stato invio…</span>
    </div>

    <section class="card score-hero">
      <div class="meta-chips" style="justify-content: center;">
        <span class="chip chip-primary">Serata ${escapeHtml(session)}</span>
        <span class="chip">Test ${escapeHtml(test)} · ${escapeHtml(heroPhaseLabel)}</span>
        ${catLabel ? `<span class="chip">${escapeHtml(catLabel)}</span>` : ""}
        ${nick ? `<span class="chip">${escapeHtml(nick)}</span>` : ""}
      </div>

      <h1 class="hero-title" style="margin-top: 4px;">Prova completata!</h1>

      <div class="score-ring-wrap" aria-label="Punteggio totale ${formatNumberIt(sr.pct_total)} percento">
        <svg class="score-ring-svg" viewBox="0 0 156 156" aria-hidden="true">
          <circle class="score-ring-track" cx="78" cy="78" r="${radius}"></circle>
          <circle
            class="score-ring-fill"
            cx="78"
            cy="78"
            r="${radius}"
            stroke-dasharray="${circumference.toFixed(2)}"
            stroke-dashoffset="${dashOffset.toFixed(2)}"
          ></circle>
        </svg>
        <div class="score-ring-center">
          <span class="score-ring-pct">${formatNumberIt(sr.pct_total)}%</span>
          <span class="score-ring-pts">${formatNumberIt(sr.score_total)} / ${formatNumberIt(sr.max_total)} pt</span>
        </div>
      </div>

      <div class="subscore-grid">
        <div class="subscore-box">
          <div class="subscore-label">Ricordo</div>
          <div class="subscore-pct">${formatNumberIt(sr.pct_recall)}%</div>
          <div class="subscore-pts">${formatNumberIt(sr.score_recall)} / ${formatNumberIt(sr.max_recall)} pt</div>
        </div>
        <div class="subscore-box">
          <div class="subscore-label">Comprensione &amp; Appl.</div>
          <div class="subscore-pct">${formatNumberIt(sr.pct_comprehension)}%</div>
          <div class="subscore-pts">${formatNumberIt(sr.score_comprehension)} / ${formatNumberIt(sr.max_comprehension)} pt</div>
        </div>
      </div>
    </section>

    ${vocabCardHtml ? `<section class="card card-compact">${vocabCardHtml}</section>` : ""}
    ${shiftHtml ? `<section class="card card-compact">${shiftHtml}</section>` : ""}

    <section class="card">
      <h2 class="section-heading">Dettaglio per prova</h2>
      <div style="margin-top: 12px;">
        ${sectionBarsHtml}
      </div>
    </section>

    ${progressionHtml}

    <p class="footer-hint">
      Le soluzioni non vengono mostrate sullo smartphone durante la serata. Attendi le indicazioni del formatore.
    </p>
  `;

  window.scrollTo({ top: 0, behavior: "instant" });
  updateSubmissionBanner();
}

function renderCurrentView() {
  if (!ctx) return;
  const { attempt } = ctx;

  if (attempt.phase === "onboarding") {
    renderOnboarding();
    return;
  }

  if (attempt.phase === "completed") {
    if (ctx.mode === "study") {
      renderCompletedStudyView();
      return;
    }
    renderCompletedView(attempt.submission?.scoreResult);
    return;
  }

  const section = getCurrentSection();
  if (!section) {
    finalizeAttempt();
    return;
  }

  if (attempt.phase === "study") {
    if (ctx.mode === "recall") {
      // Safety net: mode=recall must never show study phase
      attempt.phase = "recall";
      attempt.phaseStartedAt = Date.now();
      attempt.phaseEndsAt = Date.now() + (Number(section.recallSeconds) || 120) * 1000;
      persistAttempt();
      renderRecallView(section);
      return;
    }
    renderStudyView(section);
    return;
  }

  if (attempt.phase === "recall") {
    renderRecallView(section);
  }
}

function renderFatalError(message) {
  rootEl.innerHTML = `
    <section class="card stack-md" style="margin-top: 24px;">
      <h1 class="hero-title">Impossibile avviare la prova</h1>
      <div class="inline-error" style="margin-top: 0;">${escapeHtml(message)}</div>
      <button type="button" id="reload-app-btn" class="btn btn-primary btn-block">Riprova</button>
    </section>
  `;
  document.getElementById("reload-app-btn")?.addEventListener("click", () => {
    window.location.reload();
  });
}

async function initApp() {
  flushPendingQueue().catch(() => {});

  const { session, test, round, mode } = parseQueryParams();

  let testData;
  try {
    const resp = await fetch(`./data/test_${test}.json`, { cache: "no-store" });
    if (!resp.ok) {
      throw new Error(`Errore HTTP ${resp.status}`);
    }
    testData = await resp.json();
  } catch (err) {
    renderFatalError(`Impossibile caricare i dati del Test ${test}. Verifica la connessione e riprova.`);
    return;
  }

  const enabledSections = (Array.isArray(testData?.sections) ? testData.sections : []).filter(
    (s) => s && s.enabled !== false
  );

  const profile = getParticipantProfile();
  const attemptKey = buildAttemptKey(session, test, round, mode);
  let attempt = loadAttempt(attemptKey);

  if (!attempt) {
    attempt = {
      attemptKey,
      submissionId: createSubmissionId(),
      session,
      test,
      round,
      mode,
      phase: "onboarding",
      sectionIndex: 0,
      phaseStartedAt: null,
      phaseEndsAt: null,
      testStartedAt: null,
      completedAt: null,
      participant: {
        participant_id: profile.participant_id,
        nickname: profile.nickname || "",
        category: profile.lastCategory || ""
      },
      answers: {},
      submission: null
    };
  } else {
    if (!attempt.submissionId) {
      attempt.submissionId = attempt.submission?.payload?.id || createSubmissionId();
    }
    if (!attempt.participant || !attempt.participant.participant_id) {
      attempt.participant = {
        participant_id: profile.participant_id,
        nickname: profile.nickname || "",
        category: profile.lastCategory || ""
      };
    }
    const resolved = resolveAttemptOnLoad(attempt, enabledSections, mode, Date.now());
    attempt = resolved.attempt;

    ctx = { session, test, round, mode, testData, enabledSections, attempt };
    if (resolved.transitionedToCompleted || attempt.phase === "completed") {
      finalizeAttempt();
      return;
    }
    renderCurrentView();
    return;
  }

  ctx = { session, test, round, mode, testData, enabledSections, attempt };
  renderCurrentView();
}

initApp();
