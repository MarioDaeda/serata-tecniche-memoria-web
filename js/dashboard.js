/**
 * Logica della Regia Live Proiettabile (`dashboard.html`).
 * Gestisce accesso PIN, polling auto-refresh, 4 viste proiettabili,
 * grafico comparativo Round 1->2->3, generatore QR inline e export CSV.
 */
import { APP_CONFIG } from "../config.js";
import {
  isDemoMode,
  verifyDashboardPin,
  fetchDashboardData,
  seedDemoSubmissions
} from "./neon-client.js";
import { renderQrSvg } from "./qrcode-gen.js";

const CATEGORIES = [
  { key: "weekend", label: "Corso questo weekend", shortLabel: "Corso weekend", color: "#38bdf8" },
  { key: "mesi_fa", label: "Corso mesi fa", shortLabel: "Corso mesi fa", color: "#f59e0b" },
  { key: "nessun_corso", label: "Nessun corso", shortLabel: "Nessun corso", color: "#f472b6" }
];

const SECTIONS = [
  { key: "cifre", label: "Cifre", defaultMax: 30 },
  { key: "chimica", label: "Chimica", defaultMax: 10 },
  { key: "parole", label: "Parole PAV", defaultMax: 15 },
  { key: "vocaboli", label: "Vocaboli", defaultMax: 12 },
  { key: "matematica", label: "Matematica", defaultMax: 10 },
  { key: "date", label: "Date storiche", defaultMax: 15 }
];

const state = {
  authenticated: false,
  pin: "",
  mode: isDemoMode() ? "local" : "neon",
  sessions: [],
  submissions: [],
  selectedSession: "",
  sessionChosenByUser: false,
  filterRound: "ALL",
  filterTest: "ALL",
  sectionCategoryFilter: "ALL",
  activeTab: "live",
  autoRefresh: true,
  refreshTimerId: null,
  isRefreshing: false,
  lastRefreshedAt: null
};

const el = {};

function cacheDom() {
  const ids = [
    "pin-screen", "login-mode-badge", "login-mode-desc", "pin-form", "pin-input",
    "btn-toggle-pin", "pin-error", "btn-pin-submit",
    "dashboard-shell", "header-mode-badge", "live-submissions-count",
    "live-participants-count", "last-refresh-time", "session-select",
    "session-manual", "btn-apply-session", "filter-round", "filter-test",
    "btn-autorefresh", "btn-refresh-now", "btn-seed-demo", "btn-export-csv",
    "btn-fullscreen", "btn-logout", "dashboard-banner",
    "live-kpi-strip", "live-categories-grid",
    "rounds-chart-container", "rounds-cards-grid",
    "section-filter-category", "section-filter-round",
    "sections-bars-list", "sections-matrix-wrap",
    "qr-session", "qr-test", "qr-round", "qr-mode", "qr-url-display",
    "btn-qr-fullscreen", "btn-copy-wa-link", "qr-copy-feedback",
    "qr-stage-badge", "qr-preview-container",
    "qr-modal", "btn-close-qr-modal", "qr-modal-title",
    "qr-modal-svg-container", "qr-modal-url"
  ];
  for (const id of ids) {
    el[id] = document.getElementById(id);
  }
  el.tabButtons = Array.from(document.querySelectorAll(".tab-btn"));
  el.tabPanels = Array.from(document.querySelectorAll(".tab-panel"));
}

function clearChildren(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function createEl(tag, className = "", text = null) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== null && text !== undefined) node.textContent = String(text);
  return node;
}

function formatPct(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  return `${Number(value).toFixed(1).replace(".", ",")}%`;
}

function formatNum(value, decimals = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "—";
  }
  return Number(value).toFixed(decimals).replace(".", ",");
}

function formatDeltaPct(delta) {
  if (delta === null || delta === undefined || Number.isNaN(Number(delta))) {
    return "—";
  }
  const num = Number(delta);
  const sign = num > 0 ? "+" : "";
  return `${sign}${num.toFixed(1).replace(".", ",")}%`;
}

function getCategoryLabel(catKey) {
  return CATEGORIES.find((c) => c.key === catKey)?.label || catKey || "Altro";
}

function showBanner(message, isError = false) {
  if (!message) {
    el["dashboard-banner"].hidden = true;
    el["dashboard-banner"].textContent = "";
    el["dashboard-banner"].classList.remove("is-error");
    return;
  }
  el["dashboard-banner"].textContent = message;
  el["dashboard-banner"].classList.toggle("is-error", Boolean(isError));
  el["dashboard-banner"].hidden = false;
}

function updateModeBadges() {
  const demo = isDemoMode();
  const label = demo
    ? `Modalità Demo Locale (PIN: ${APP_CONFIG.demoPin})`
    : "Connesso a Neon Postgres";
  for (const badge of [el["login-mode-badge"], el["header-mode-badge"]]) {
    badge.textContent = label;
    badge.classList.toggle("mode-badge--demo", demo);
    badge.classList.toggle("mode-badge--neon", !demo);
  }
  el["login-mode-desc"].textContent = demo
    ? "I dati sono salvati localmente su questo browser (localStorage). Inserisci il PIN formatore per aprire la regia."
    : "Connessione attiva al database Neon Postgres. Inserisci il PIN formatore per leggere i risultati della sala.";
  el["btn-seed-demo"].hidden = !demo;
}

function getSubmissionPct(sub, kind = "total") {
  if (kind === "recall") {
    if (Number.isFinite(Number(sub.pct_recall))) return Number(sub.pct_recall);
    return Number(sub.max_recall) > 0 ? (Number(sub.score_recall) / Number(sub.max_recall)) * 100 : 0;
  }
  if (kind === "comprehension") {
    if (Number.isFinite(Number(sub.pct_comprehension))) return Number(sub.pct_comprehension);
    return Number(sub.max_comprehension) > 0
      ? (Number(sub.score_comprehension) / Number(sub.max_comprehension)) * 100
      : 0;
  }
  if (Number.isFinite(Number(sub.pct_total))) return Number(sub.pct_total);
  return Number(sub.max_total) > 0 ? (Number(sub.score_total) / Number(sub.max_total)) * 100 : 0;
}

function computeGroupStats(items) {
  const count = items.length;
  const participants = new Set(items.map((s) => s.participant_id).filter(Boolean)).size;
  if (count === 0) {
    return {
      count: 0,
      participants: 0,
      avgPctTotal: null,
      avgPctRecall: null,
      avgPctComp: null,
      avgScoreTotal: null,
      avgScoreRecall: null,
      avgScoreComp: null,
      avgMaxTotal: 92,
      avgMaxRecall: 82,
      avgMaxComp: 10,
      shiftCount: 0
    };
  }
  let sumPctTotal = 0;
  let sumPctRecall = 0;
  let sumPctComp = 0;
  let sumScoreTotal = 0;
  let sumScoreRecall = 0;
  let sumScoreComp = 0;
  let sumMaxTotal = 0;
  let sumMaxRecall = 0;
  let sumMaxComp = 0;
  let shiftCount = 0;

  for (const item of items) {
    sumPctTotal += getSubmissionPct(item, "total");
    sumPctRecall += getSubmissionPct(item, "recall");
    sumPctComp += getSubmissionPct(item, "comprehension");
    sumScoreTotal += Number(item.score_total || 0);
    sumScoreRecall += Number(item.score_recall || 0);
    sumScoreComp += Number(item.score_comprehension || 0);
    sumMaxTotal += Number(item.max_total || 92);
    sumMaxRecall += Number(item.max_recall || 82);
    sumMaxComp += Number(item.max_comprehension || 10);
    if (item.digits_shift_detected) shiftCount++;
  }

  return {
    count,
    participants,
    avgPctTotal: sumPctTotal / count,
    avgPctRecall: sumPctRecall / count,
    avgPctComp: sumPctComp / count,
    avgScoreTotal: sumScoreTotal / count,
    avgScoreRecall: sumScoreRecall / count,
    avgScoreComp: sumScoreComp / count,
    avgMaxTotal: sumMaxTotal / count,
    avgMaxRecall: sumMaxRecall / count,
    avgMaxComp: sumMaxComp / count,
    shiftCount
  };
}

function getHeaderFilteredSubmissions({ ignoreRound = false } = {}) {
  return state.submissions.filter((sub) => {
    if (
      state.selectedSession &&
      state.selectedSession !== "ALL" &&
      String(sub.session_code || "").toUpperCase() !== state.selectedSession
    ) {
      return false;
    }
    if (!ignoreRound && state.filterRound !== "ALL" && Number(sub.round_num) !== Number(state.filterRound)) {
      return false;
    }
    if (state.filterTest !== "ALL" && String(sub.test_id || "").toUpperCase() !== state.filterTest) {
      return false;
    }
    return true;
  });
}

function populateSessionSelector() {
  const select = el["session-select"];
  const options = new Set();
  if (APP_CONFIG.defaultSession) {
    options.add(String(APP_CONFIG.defaultSession).trim().toUpperCase());
  }
  for (const s of state.sessions) {
    if (s) options.add(String(s).trim().toUpperCase());
  }
  if (state.selectedSession && state.selectedSession !== "ALL") {
    options.add(state.selectedSession);
  }

  const sorted = Array.from(options).sort((a, b) => a.localeCompare(b));
  clearChildren(select);

  const allOpt = createEl("option", "", "Tutte le serate");
  allOpt.value = "ALL";
  select.appendChild(allOpt);

  for (const code of sorted) {
    const opt = createEl("option", "", code);
    opt.value = code;
    select.appendChild(opt);
  }

  select.value = state.selectedSession || "ALL";
  el["session-manual"].value = state.selectedSession === "ALL" ? "" : state.selectedSession;
}

function updateHeaderCounters(filtered) {
  const stats = computeGroupStats(filtered);
  el["live-submissions-count"].textContent = String(stats.count);
  el["live-participants-count"].textContent = String(stats.participants);
  if (state.lastRefreshedAt) {
    const t = state.lastRefreshedAt.toLocaleTimeString("it-IT", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    el["last-refresh-time"].textContent = `Agg. ${t}`;
  }
}

/* ==================== RENDER TAB 1: LIVE PER CATEGORIE ==================== */
function renderLiveTab(filtered) {
  const kpiStrip = el["live-kpi-strip"];
  const grid = el["live-categories-grid"];
  clearChildren(kpiStrip);
  clearChildren(grid);

  const overall = computeGroupStats(filtered);

  const kpis = [
    {
      label: "Consegne",
      value: String(overall.count),
      sub: `${overall.participants} partecipanti unici`
    },
    {
      label: "Media Totale Sala",
      value: formatPct(overall.avgPctTotal),
      sub: overall.count ? `${formatNum(overall.avgScoreTotal)} / ${formatNum(overall.avgMaxTotal, 0)} pt medi` : "In attesa di consegne"
    },
    {
      label: "Media Ricordo",
      value: formatPct(overall.avgPctRecall),
      sub: overall.count ? `${formatNum(overall.avgScoreRecall)} / ${formatNum(overall.avgMaxRecall, 0)} pt medi` : "—"
    },
    {
      label: "Media Comprensione",
      value: formatPct(overall.avgPctComp),
      sub: overall.count ? `${formatNum(overall.avgScoreComp)} / ${formatNum(overall.avgMaxComp, 0)} pt medi` : "—"
    }
  ];

  for (const kpi of kpis) {
    const box = createEl("div", "kpi-box");
    box.appendChild(createEl("div", "kpi-label", kpi.label));
    box.appendChild(createEl("div", "kpi-value", kpi.value));
    box.appendChild(createEl("div", "kpi-sub", kpi.sub));
    kpiStrip.appendChild(box);
  }

  if (filtered.length === 0) {
    const empty = createEl("div", "empty-state-card");
    empty.appendChild(createEl("h3", "", "Nessuna consegna per i filtri selezionati"));
    empty.appendChild(
      createEl(
        "p",
        "",
        isDemoMode()
          ? 'Completa una prova su index.html oppure premi "Popola dati demo" in alto per visualizzare una simulazione completa su 3 round.'
          : "Le consegne inviate dai telefoni appariranno automaticamente qui entro pochi secondi."
      )
    );
    grid.appendChild(empty);
    return;
  }

  for (const cat of CATEGORIES) {
    const items = filtered.filter((s) => s.category === cat.key);
    const stats = computeGroupStats(items);

    const card = createEl("article", `category-card category-card--${cat.key}`);
    const header = createEl("div", "category-header");
    header.appendChild(createEl("h2", "category-title", cat.label));
    header.appendChild(
      createEl("span", "category-count-badge", `${stats.count} ${stats.count === 1 ? "consegna" : "consegne"}`)
    );
    card.appendChild(header);

    const pctRow = createEl("div", "category-pct-row");
    pctRow.appendChild(createEl("div", "category-big-pct", formatPct(stats.avgPctTotal)));
    pctRow.appendChild(
      createEl(
        "div",
        "category-pts-sub",
        stats.count ? `${formatNum(stats.avgScoreTotal)} / ${formatNum(stats.avgMaxTotal, 0)} pt` : "Nessun dato"
      )
    );
    card.appendChild(pctRow);

    const track = createEl("div", "thick-progress-track");
    const fill = createEl("div", "thick-progress-fill");
    const widthPct = stats.avgPctTotal === null ? 0 : Math.max(0, Math.min(100, stats.avgPctTotal));
    fill.style.width = `${widthPct.toFixed(1)}%`;
    track.appendChild(fill);
    card.appendChild(track);

    const subGrid = createEl("div", "subscore-grid");
    const boxRecall = createEl("div", "subscore-box");
    boxRecall.appendChild(createEl("div", "subscore-label", "Ricordo"));
    boxRecall.appendChild(createEl("div", "subscore-val", formatPct(stats.avgPctRecall)));
    boxRecall.appendChild(
      createEl("div", "subscore-detail", stats.count ? `${formatNum(stats.avgScoreRecall)} / ${formatNum(stats.avgMaxRecall, 0)} pt` : "—")
    );

    const boxComp = createEl("div", "subscore-box");
    boxComp.appendChild(createEl("div", "subscore-label", "Comprensione"));
    boxComp.appendChild(createEl("div", "subscore-val", formatPct(stats.avgPctComp)));
    boxComp.appendChild(
      createEl("div", "subscore-detail", stats.count ? `${formatNum(stats.avgScoreComp)} / ${formatNum(stats.avgMaxComp, 0)} pt` : "—")
    );

    subGrid.appendChild(boxRecall);
    subGrid.appendChild(boxComp);
    card.appendChild(subGrid);

    const footer = createEl("div", "category-footer-meta");
    footer.appendChild(
      createEl(
        "span",
        "",
        `Partecipanti: ${stats.participants}`
      )
    );
    if (stats.shiftCount > 0) {
      footer.appendChild(
        createEl("span", "shift-note-pill", `Shift cifre rilevato: ${stats.shiftCount}`)
      );
    }
    card.appendChild(footer);
    grid.appendChild(card);
  }
}

/* ==================== RENDER TAB 2: CONFRONTO ROUND 1->2->3 ==================== */
function buildRoundsSvgChart(matrix) {
  const ns = "http://www.w3.org/2000/svg";
  const width = 960;
  const height = 260;
  const padLeft = 58;
  const padRight = 24;
  const padTop = 24;
  const padBottom = 46;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "rounds-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Grafico comparativo Round 1, Round 2 e Round 3 per categoria");

  const makeSvgEl = (tag, attrs = {}, text = null) => {
    const node = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) {
      node.setAttribute(k, String(v));
    }
    if (text !== null) node.textContent = String(text);
    return node;
  };

  // Griglia orizzontale 0, 25, 50, 75, 100%
  for (const pct of [0, 25, 50, 75, 100]) {
    const y = padTop + plotH - (pct / 100) * plotH;
    svg.appendChild(
      makeSvgEl("line", {
        x1: padLeft,
        y1: y,
        x2: width - padRight,
        y2: y,
        stroke: pct === 0 ? "#475569" : "#1e293b",
        "stroke-width": pct === 0 ? 1.5 : 1
      })
    );
    svg.appendChild(
      makeSvgEl(
        "text",
        {
          x: padLeft - 10,
          y: y + 4,
          fill: "#94a3b8",
          "font-size": 13,
          "font-weight": 700,
          "text-anchor": "end"
        },
        `${pct}%`
      )
    );
  }

  const groupW = plotW / CATEGORIES.length;
  const roundColors = ["#94a3b8", "#38bdf8", "#22c55e"];
  const barW = 46;
  const gap = 14;
  const totalGroupBarsW = 3 * barW + 2 * gap;

  CATEGORIES.forEach((cat, catIdx) => {
    const groupCenterX = padLeft + groupW * (catIdx + 0.5);
    const startX = groupCenterX - totalGroupBarsW / 2;

    svg.appendChild(
      makeSvgEl(
        "text",
        {
          x: groupCenterX,
          y: height - 14,
          fill: "#f8fafc",
          "font-size": 15,
          "font-weight": 800,
          "text-anchor": "middle"
        },
        cat.label
      )
    );

    [1, 2, 3].forEach((rNum, rIdx) => {
      const cell = matrix[cat.key][rNum];
      const val = cell.avgPctTotal;
      const barX = startX + rIdx * (barW + gap);
      const barH = val === null ? 0 : Math.max(4, (val / 100) * plotH);
      const barY = padTop + plotH - barH;

      // Sfondo traccia sottile
      svg.appendChild(
        makeSvgEl("rect", {
          x: barX,
          y: padTop,
          width: barW,
          height: plotH,
          rx: 6,
          fill: "#0d1729",
          opacity: 0.7
        })
      );

      if (val !== null) {
        svg.appendChild(
          makeSvgEl("rect", {
            x: barX,
            y: barY,
            width: barW,
            height: barH,
            rx: 6,
            fill: roundColors[rIdx]
          })
        );
        svg.appendChild(
          makeSvgEl(
            "text",
            {
              x: barX + barW / 2,
              y: Math.max(padTop + 14, barY - 6),
              fill: "#f8fafc",
              "font-size": 13,
              "font-weight": 800,
              "text-anchor": "middle"
            },
            `${val.toFixed(0)}%`
          )
        );
      } else {
        svg.appendChild(
          makeSvgEl(
            "text",
            {
              x: barX + barW / 2,
              y: padTop + plotH - 10,
              fill: "#64748b",
              "font-size": 12,
              "font-weight": 700,
              "text-anchor": "middle"
            },
            "—"
          )
        );
      }

      svg.appendChild(
        makeSvgEl(
          "text",
          {
            x: barX + barW / 2,
            y: padTop + plotH + 16,
            fill: "#94a3b8",
            "font-size": 11,
            "font-weight": 700,
            "text-anchor": "middle"
          },
          `R${rNum}`
        )
      );
    });
  });

  return svg;
}

function renderRoundsTab() {
  const allRoundsItems = getHeaderFilteredSubmissions({ ignoreRound: true });
  const chartContainer = el["rounds-chart-container"];
  const cardsGrid = el["rounds-cards-grid"];
  clearChildren(chartContainer);
  clearChildren(cardsGrid);

  const matrix = {};
  for (const cat of CATEGORIES) {
    matrix[cat.key] = {};
    for (const rNum of [1, 2, 3]) {
      const subset = allRoundsItems.filter(
        (s) => s.category === cat.key && Number(s.round_num) === rNum
      );
      matrix[cat.key][rNum] = computeGroupStats(subset);
    }
  }

  chartContainer.appendChild(buildRoundsSvgChart(matrix));

  for (const cat of CATEGORIES) {
    const card = createEl("article", "round-cat-card");
    const header = createEl("div", "round-cat-header");
    header.appendChild(createEl("h3", "round-cat-title", cat.label));

    const r1 = matrix[cat.key][1].avgPctTotal;
    const r2 = matrix[cat.key][2].avgPctTotal;
    const r3 = matrix[cat.key][3].avgPctTotal;

    const deltas = createEl("div", "delta-badges");
    if (r1 !== null && r2 !== null) {
      const diff12 = r2 - r1;
      const badge12 = createEl(
        "span",
        `delta-badge ${diff12 > 0 ? "delta-badge--up" : "delta-badge--flat"}`,
        `R1→R2 ${formatDeltaPct(diff12)}`
      );
      deltas.appendChild(badge12);
    }
    if (r1 !== null && r3 !== null) {
      const diff13 = r3 - r1;
      const badge13 = createEl(
        "span",
        `delta-badge ${diff13 > 0 ? "delta-badge--up" : "delta-badge--flat"}`,
        `R1→R3 ${formatDeltaPct(diff13)}`
      );
      deltas.appendChild(badge13);
    }
    if (!deltas.childElementCount) {
      deltas.appendChild(createEl("span", "delta-badge delta-badge--flat", "In attesa R2/R3"));
    }

    header.appendChild(deltas);
    card.appendChild(header);

    const rows = createEl("div", "round-bar-rows");
    const roundLabels = {
      1: "Round 1 · A freddo",
      2: "Round 2 · Post-tecniche",
      3: "Round 3 · Ritest"
    };

    for (const rNum of [1, 2, 3]) {
      const cell = matrix[cat.key][rNum];
      const row = createEl("div", "round-bar-row");
      const meta = createEl("div", "round-bar-meta");
      meta.appendChild(createEl("span", "", roundLabels[rNum]));
      meta.appendChild(
        createEl(
          "span",
          "",
          cell.count > 0 ? `${formatPct(cell.avgPctTotal)} (n=${cell.count})` : "—"
        )
      );
      row.appendChild(meta);

      const track = createEl("div", "round-track");
      const fill = createEl("div", `round-fill round-fill--${rNum}`);
      const w = cell.avgPctTotal === null ? 0 : Math.max(0, Math.min(100, cell.avgPctTotal));
      fill.style.width = `${w.toFixed(1)}%`;
      track.appendChild(fill);
      row.appendChild(track);
      rows.appendChild(row);
    }

    card.appendChild(rows);
    cardsGrid.appendChild(card);
  }
}

/* ==================== RENDER TAB 3: DETTAGLIO PER PROVA ==================== */
function computeSectionAggregate(items, secKey, defaultMax) {
  let count = 0;
  let sumScore = 0;
  let sumMax = 0;
  let sumRecall = 0;
  let sumMaxRecall = 0;
  let sumComp = 0;
  let sumMaxComp = 0;
  let shiftCount = 0;
  let sumVocabKnown = 0;
  let sumVocabNewCorrect = 0;
  let sumVocabNewTotal = 0;

  for (const sub of items) {
    const sec = sub.section_scores?.[secKey];
    if (!sec || Number(sec.max) <= 0) continue;
    count++;
    sumScore += Number(sec.score || 0);
    sumMax += Number(sec.max || defaultMax);
    sumRecall += Number(sec.recall ?? sec.score ?? 0);
    sumMaxRecall += Number(sec.maxRecall ?? sec.max ?? defaultMax);
    sumComp += Number(sec.comp ?? 0);
    sumMaxComp += Number(sec.maxComp ?? 0);

    if (secKey === "cifre" && (sec.shiftDetected || sub.digits_shift_detected)) {
      shiftCount++;
    }
    if (secKey === "vocaboli") {
      sumVocabKnown += Number(sec.knownCount ?? sub.vocab_known_count ?? 0);
      sumVocabNewCorrect += Number(sec.newCorrect ?? sub.vocab_new_correct ?? 0);
      sumVocabNewTotal += Number(sec.newTotal ?? sub.vocab_new_total ?? 12);
    }
  }

  if (count === 0) {
    return { count: 0, avgPct: null, avgScore: null, avgMax: defaultMax };
  }

  return {
    count,
    avgPct: sumMax > 0 ? (sumScore / sumMax) * 100 : 0,
    avgScore: sumScore / count,
    avgMax: sumMax / count,
    avgRecall: sumRecall / count,
    avgMaxRecall: sumMaxRecall / count,
    avgComp: sumComp / count,
    avgMaxComp: sumMaxComp / count,
    shiftCount,
    avgVocabKnown: sumVocabKnown / count,
    avgVocabNewCorrect: sumVocabNewCorrect / count,
    avgVocabNewTotal: sumVocabNewTotal / count,
    vocabNewPct: sumVocabNewTotal > 0 ? (sumVocabNewCorrect / sumVocabNewTotal) * 100 : null
  };
}

function renderSectionsTab() {
  const baseItems = getHeaderFilteredSubmissions();
  const catFilter = state.sectionCategoryFilter;
  const items =
    catFilter === "ALL" ? baseItems : baseItems.filter((s) => s.category === catFilter);

  const listEl = el["sections-bars-list"];
  const matrixWrap = el["sections-matrix-wrap"];
  clearChildren(listEl);
  clearChildren(matrixWrap);

  for (const sec of SECTIONS) {
    const agg = computeSectionAggregate(items, sec.key, sec.defaultMax);
    const card = createEl("article", "section-bar-card");

    const top = createEl("div", "section-bar-top");
    top.appendChild(createEl("div", "section-bar-title", sec.label));
    top.appendChild(createEl("div", "section-bar-pct", formatPct(agg.avgPct)));
    card.appendChild(top);

    const track = createEl("div", "section-track");
    const fill = createEl("div", "section-fill");
    const w = agg.avgPct === null ? 0 : Math.max(0, Math.min(100, agg.avgPct));
    fill.style.width = `${w.toFixed(1)}%`;
    track.appendChild(fill);
    card.appendChild(track);

    const subRow = createEl("div", "section-bar-sub");
    if (agg.count > 0) {
      subRow.appendChild(
        createEl("span", "", `Media: ${formatNum(agg.avgScore)} / ${formatNum(agg.avgMax, 0)} pt (n=${agg.count})`)
      );
      if (agg.avgMaxComp > 0) {
        subRow.appendChild(
          createEl(
            "span",
            "",
            `Ricordo ${formatNum(agg.avgRecall)}/${formatNum(agg.avgMaxRecall, 0)} · Compr. ${formatNum(agg.avgComp)}/${formatNum(agg.avgMaxComp, 0)}`
          )
        );
      } else if (sec.key === "cifre" && agg.shiftCount > 0) {
        subRow.appendChild(
          createEl("span", "shift-note-pill", `Shift rilevati: ${agg.shiftCount}`)
        );
      }
    } else {
      subRow.appendChild(createEl("span", "", "Nessuna consegna per i filtri attivi"));
    }
    card.appendChild(subRow);

    if (sec.key === "vocaboli" && agg.count > 0) {
      const vocabSub = createEl("div", "vocab-new-subrow");
      vocabSub.appendChild(
        createEl(
          "span",
          "",
          `Vocaboli nuovi appresi (escluse ${formatNum(agg.avgVocabKnown)} già note):`
        )
      );
      vocabSub.appendChild(
        createEl(
          "strong",
          "",
          `${formatPct(agg.vocabNewPct)} (${formatNum(agg.avgVocabNewCorrect)} / ${formatNum(agg.avgVocabNewTotal)})`
        )
      );
      card.appendChild(vocabSub);
    }

    listEl.appendChild(card);
  }

  // Tabella comparativa per categoria
  matrixWrap.appendChild(
    createEl("h3", "matrix-title", "Confronto rapido per categoria (media % su ciascuna prova)")
  );
  const table = createEl("table", "matrix-table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.appendChild(createEl("th", "", "Prova"));
  for (const cat of CATEGORIES) {
    headRow.appendChild(createEl("th", "num", cat.shortLabel));
  }
  headRow.appendChild(createEl("th", "num", "Totale filtro"));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const sec of SECTIONS) {
    const tr = document.createElement("tr");
    tr.appendChild(createEl("td", "", sec.label));
    for (const cat of CATEGORIES) {
      const catItems = baseItems.filter((s) => s.category === cat.key);
      const agg = computeSectionAggregate(catItems, sec.key, sec.defaultMax);
      tr.appendChild(
        createEl("td", "num", agg.count > 0 ? formatPct(agg.avgPct) : "—")
      );
    }
    const allAgg = computeSectionAggregate(baseItems, sec.key, sec.defaultMax);
    tr.appendChild(createEl("td", "num", allAgg.count > 0 ? formatPct(allAgg.avgPct) : "—"));
    tbody.appendChild(tr);

    if (sec.key === "vocaboli") {
      const trNew = document.createElement("tr");
      trNew.appendChild(createEl("td", "", "↳ Vocaboli nuovi appresi"));
      for (const cat of CATEGORIES) {
        const catItems = baseItems.filter((s) => s.category === cat.key);
        const agg = computeSectionAggregate(catItems, "vocaboli", 12);
        trNew.appendChild(
          createEl("td", "num", agg.count > 0 ? formatPct(agg.vocabNewPct) : "—")
        );
      }
      const allVocab = computeSectionAggregate(baseItems, "vocaboli", 12);
      trNew.appendChild(
        createEl("td", "num", allVocab.count > 0 ? formatPct(allVocab.vocabNewPct) : "—")
      );
      tbody.appendChild(trNew);
    }
  }
  table.appendChild(tbody);
  matrixWrap.appendChild(table);
}

/* ==================== RENDER TAB 4: QR CODE PROIETTABILE ==================== */
function getAppBaseUrl() {
  const configured = String(APP_CONFIG.appBaseUrl || "").trim();
  if (configured) {
    if (/\.html?$/i.test(configured)) return configured;
    return configured.endsWith("/") ? configured : `${configured}/`;
  }
  if (window.location.protocol === "file:") {
    return new URL("index.html", window.location.href).href;
  }
  return new URL("./", window.location.href).href;
}

function buildParticipantUrl() {
  const rawSession = String(el["qr-session"].value || APP_CONFIG.defaultSession || "SERATA-1")
    .trim()
    .toUpperCase();
  const session = rawSession || "SERATA-1";
  const test = el["qr-test"].value === "B" ? "B" : "A";
  const round = ["1", "2", "3"].includes(el["qr-round"].value) ? el["qr-round"].value : "1";
  const rawMode = el["qr-mode"].value;
  const mode = rawMode === "recall" ? "recall" : rawMode === "study" ? "study" : "full";

  const base = getAppBaseUrl();
  const params = new URLSearchParams({
    session,
    test,
    round,
    mode
  });
  return {
    session,
    test,
    round,
    mode,
    url: `${base}?${params.toString()}`
  };
}

function injectQrSvg(container, svgMarkup) {
  clearChildren(container);
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgMarkup, "image/svg+xml");
  const svgNode = doc.documentElement;
  if (svgNode && svgNode.nodeName.toLowerCase() === "svg") {
    container.appendChild(document.importNode(svgNode, true));
  }
}

function renderQrTab() {
  const { session, test, round, mode, url } = buildParticipantUrl();
  const modeLabel =
    mode === "recall"
      ? "Solo Recupero"
      : mode === "study"
      ? "Solo Memorizzazione"
      : "Studio + Risposta";
  const titleText = `${session} · Prova ${round} — Test ${test} (${modeLabel})`;

  el["qr-url-display"].textContent = url;
  el["qr-stage-badge"].textContent = titleText;
  el["qr-modal-title"].textContent = titleText;
  el["qr-modal-url"].textContent = url;

  const previewSvg = renderQrSvg(url, { marginModules: 4, sizePx: 280 });
  const modalSvg = renderQrSvg(url, { marginModules: 4, sizePx: 640 });
  injectQrSvg(el["qr-preview-container"], previewSvg);
  injectQrSvg(el["qr-modal-svg-container"], modalSvg);
}

/* ==================== RENDER ALL & CSV ==================== */
function renderAll() {
  const filtered = getHeaderFilteredSubmissions();
  updateHeaderCounters(filtered);
  renderLiveTab(filtered);
  renderRoundsTab();
  renderSectionsTab();
  renderQrTab();
}

function csvEscape(value) {
  const str = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replaceAll('"', '""')}"`;
  }
  return str;
}

function exportFilteredCsv() {
  const filtered = getHeaderFilteredSubmissions();
  const headers = [
    "id",
    "created_at",
    "session_code",
    "test_id",
    "round_num",
    "mode",
    "participant_id",
    "nickname",
    "category",
    "category_label",
    "score_total",
    "max_total",
    "pct_total",
    "score_recall",
    "max_recall",
    "pct_recall",
    "score_comprehension",
    "max_comprehension",
    "pct_comprehension",
    "vocab_known_count",
    "vocab_new_correct",
    "vocab_new_total",
    "digits_shift_detected",
    "duration_seconds",
    "cifre_score",
    "cifre_pct",
    "chimica_score",
    "chimica_pct",
    "parole_score",
    "parole_pct",
    "vocaboli_score",
    "vocaboli_pct",
    "matematica_score",
    "matematica_pct",
    "date_score",
    "date_pct"
  ];

  const rows = [headers.join(",")];
  for (const sub of filtered) {
    const s = sub.section_scores || {};
    const row = [
      sub.id,
      sub.created_at,
      sub.session_code,
      sub.test_id,
      sub.round_num,
      sub.mode,
      sub.participant_id,
      sub.nickname,
      sub.category,
      getCategoryLabel(sub.category),
      sub.score_total,
      sub.max_total,
      sub.pct_total,
      sub.score_recall,
      sub.max_recall,
      sub.pct_recall,
      sub.score_comprehension,
      sub.max_comprehension,
      sub.pct_comprehension,
      sub.vocab_known_count,
      sub.vocab_new_correct,
      sub.vocab_new_total,
      sub.digits_shift_detected,
      sub.duration_seconds,
      s.cifre?.score ?? "",
      s.cifre?.pct ?? "",
      s.chimica?.score ?? "",
      s.chimica?.pct ?? "",
      s.parole?.score ?? "",
      s.parole?.pct ?? "",
      s.vocaboli?.score ?? "",
      s.vocaboli?.pct ?? "",
      s.matematica?.score ?? "",
      s.matematica?.pct ?? "",
      s.date?.score ?? "",
      s.date?.pct ?? ""
    ];
    rows.push(row.map(csvEscape).join(","));
  }

  const csvContent = "\uFEFF" + rows.join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const blobUrl = URL.createObjectURL(blob);
  const rawSlug = (state.selectedSession || APP_CONFIG.defaultSession || "SERATA-1")
    .replace(/[^A-Za-z0-9_-]/g, "_");
  const filename = `risultati_${rawSlug}.csv`;

  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

/* ==================== DATA FETCHING & AUTO-REFRESH ==================== */
async function refreshData({ initial = false } = {}) {
  if (!state.authenticated || state.isRefreshing) return;
  state.isRefreshing = true;
  try {
    const querySession =
      initial || !state.selectedSession || state.selectedSession === "ALL"
        ? null
        : state.selectedSession;

    const data = await fetchDashboardData(state.pin, querySession);
    state.mode = data.mode;
    state.sessions = data.sessions || [];
    state.submissions = data.submissions || [];
    state.lastRefreshedAt = new Date();

    if (initial && !state.sessionChosenByUser) {
      const def = String(APP_CONFIG.defaultSession || "SERATA-1").trim().toUpperCase();
      if (state.sessions.includes(def)) {
        state.selectedSession = def;
      } else if (state.sessions.length > 0) {
        state.selectedSession = state.sessions[0];
      } else {
        state.selectedSession = def;
      }
      el["qr-session"].value = state.selectedSession === "ALL" ? def : state.selectedSession;
    }

    populateSessionSelector();
    showBanner("");
    renderAll();
  } catch (err) {
    console.error("[dashboard] Errore refresh:", err);
    showBanner(`Errore aggiornamento dati: ${err.message}`, true);
  } finally {
    state.isRefreshing = false;
  }
}

function stopAutoRefresh() {
  if (state.refreshTimerId !== null) {
    clearInterval(state.refreshTimerId);
    state.refreshTimerId = null;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (!state.autoRefresh || !state.authenticated) return;
  const intervalMs = Math.max(1500, Number(APP_CONFIG.dashboardRefreshMs || 4000));
  state.refreshTimerId = setInterval(() => {
    refreshData({ initial: false });
  }, intervalMs);
}

function setAutoRefresh(enabled) {
  state.autoRefresh = Boolean(enabled);
  const btn = el["btn-autorefresh"];
  btn.classList.toggle("is-on", state.autoRefresh);
  btn.setAttribute("aria-pressed", String(state.autoRefresh));
  btn.textContent = `Auto-refresh (${Math.round((APP_CONFIG.dashboardRefreshMs || 4000) / 1000)}s): ${state.autoRefresh ? "ON" : "OFF"}`;
  if (state.autoRefresh) {
    startAutoRefresh();
  } else {
    stopAutoRefresh();
  }
}

/* ==================== TABS, MODAL & AUTH ==================== */
function switchTab(tabKey) {
  state.activeTab = tabKey;
  for (const btn of el.tabButtons) {
    const active = btn.dataset.tab === tabKey;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
  }
  for (const panel of el.tabPanels) {
    const active = panel.id === `panel-${tabKey}`;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  }
  if (tabKey === "qr") {
    renderQrTab();
  }
}

function openQrModal() {
  renderQrTab();
  el["qr-modal"].hidden = false;
  el["btn-close-qr-modal"].focus();
}

function closeQrModal() {
  el["qr-modal"].hidden = true;
}

async function copyWhatsappLink() {
  const { url } = buildParticipantUrl();
  try {
    await navigator.clipboard.writeText(url);
    el["qr-copy-feedback"].textContent = "Link copiato negli appunti! Pronto da incollare su WhatsApp.";
  } catch {
    // Fallback di copia se clipboard API non permessa
    const area = document.createElement("textarea");
    area.value = url;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    document.body.removeChild(area);
    el["qr-copy-feedback"].textContent = "Link copiato negli appunti!";
  }
  setTimeout(() => {
    if (el["qr-copy-feedback"].textContent) {
      el["qr-copy-feedback"].textContent = "";
    }
  }, 4000);
}

async function handlePinSubmit(event) {
  event.preventDefault();
  const pin = el["pin-input"].value.trim();
  el["pin-error"].hidden = true;
  el["pin-error"].textContent = "";

  if (!pin) {
    el["pin-error"].textContent = "Inserisci il PIN formatore.";
    el["pin-error"].hidden = false;
    return;
  }

  el["btn-pin-submit"].disabled = true;
  try {
    const ok = await verifyDashboardPin(pin);
    if (!ok) {
      el["pin-error"].textContent = "PIN non valido. Verifica e riprova.";
      el["pin-error"].hidden = false;
      el["pin-input"].select();
      return;
    }

    state.authenticated = true;
    state.pin = pin;
    el["pin-screen"].hidden = true;
    el["dashboard-shell"].hidden = false;

    const urlSession = new URLSearchParams(window.location.search).get("session");
    if (urlSession && urlSession.trim()) {
      state.selectedSession = urlSession.trim().toUpperCase();
      state.sessionChosenByUser = true;
      el["qr-session"].value = state.selectedSession;
    }

    await refreshData({ initial: true });
    setAutoRefresh(true);
  } catch (err) {
    el["pin-error"].textContent = `Errore durante la verifica del PIN: ${err.message}`;
    el["pin-error"].hidden = false;
  } finally {
    el["btn-pin-submit"].disabled = false;
  }
}

function handleLogout() {
  stopAutoRefresh();
  state.authenticated = false;
  state.pin = "";
  state.submissions = [];
  el["pin-input"].value = "";
  el["pin-error"].hidden = true;
  el["dashboard-shell"].hidden = true;
  el["pin-screen"].hidden = false;
  el["pin-input"].focus();
}

function bindEvents() {
  el["pin-form"].addEventListener("submit", handlePinSubmit);

  el["btn-toggle-pin"].addEventListener("click", () => {
    const isPass = el["pin-input"].type === "password";
    el["pin-input"].type = isPass ? "text" : "password";
    el["btn-toggle-pin"].textContent = isPass ? "Nascondi" : "Mostra";
  });

  el["btn-logout"].addEventListener("click", handleLogout);

  el["session-select"].addEventListener("change", () => {
    state.selectedSession = el["session-select"].value;
    state.sessionChosenByUser = true;
    if (state.selectedSession !== "ALL") {
      el["qr-session"].value = state.selectedSession;
    }
    refreshData({ initial: false });
  });

  const applyManualSession = () => {
    const val = el["session-manual"].value.trim().toUpperCase();
    if (!val) return;
    state.selectedSession = val;
    state.sessionChosenByUser = true;
    el["qr-session"].value = val;
    refreshData({ initial: false });
  };

  el["btn-apply-session"].addEventListener("click", applyManualSession);
  el["session-manual"].addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      applyManualSession();
    }
  });

  el["filter-round"].addEventListener("change", () => {
    state.filterRound = el["filter-round"].value;
    el["section-filter-round"].value = state.filterRound;
    renderAll();
  });

  el["filter-test"].addEventListener("change", () => {
    state.filterTest = el["filter-test"].value;
    renderAll();
  });

  el["section-filter-category"].addEventListener("change", () => {
    state.sectionCategoryFilter = el["section-filter-category"].value;
    renderSectionsTab();
  });

  el["section-filter-round"].addEventListener("change", () => {
    state.filterRound = el["section-filter-round"].value;
    el["filter-round"].value = state.filterRound;
    renderAll();
  });

  el["btn-autorefresh"].addEventListener("click", () => {
    setAutoRefresh(!state.autoRefresh);
  });

  el["btn-refresh-now"].addEventListener("click", () => {
    refreshData({ initial: false });
  });

  el["btn-seed-demo"].addEventListener("click", async () => {
    if (!isDemoMode()) return;
    const targetSession = String(APP_CONFIG.defaultSession || "SERATA-1").trim().toUpperCase();
    seedDemoSubmissions(targetSession);
    state.selectedSession = targetSession;
    state.sessionChosenByUser = true;
    state.filterRound = "ALL";
    state.filterTest = "ALL";
    el["filter-round"].value = "ALL";
    el["filter-test"].value = "ALL";
    el["section-filter-round"].value = "ALL";
    el["qr-session"].value = targetSession;
    await refreshData({ initial: false });
    showBanner(`Popolate 18 consegne demo realistiche (Round 1, 2 e 3) nella serata ${targetSession}.`);
  });

  el["btn-export-csv"].addEventListener("click", exportFilteredCsv);

  el["btn-fullscreen"].addEventListener("click", async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch {
      // Fallback silenzioso se fullscreen bloccato dal browser
    }
  });

  for (const btn of el.tabButtons) {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  }

  el["qr-round"].addEventListener("change", () => {
    const r = el["qr-round"].value;
    if (r === "1") {
      el["qr-mode"].value = "study";
    } else if (r === "2" || r === "3") {
      el["qr-mode"].value = "recall";
    }
    renderQrTab();
  });

  for (const inputId of ["qr-session", "qr-test", "qr-mode"]) {
    el[inputId].addEventListener("input", renderQrTab);
    el[inputId].addEventListener("change", renderQrTab);
  }

  el["btn-qr-fullscreen"].addEventListener("click", openQrModal);
  el["btn-close-qr-modal"].addEventListener("click", closeQrModal);
  el["qr-modal"].addEventListener("click", (e) => {
    if (e.target === el["qr-modal"]) closeQrModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el["qr-modal"].hidden) {
      closeQrModal();
    }
  });

  el["btn-copy-wa-link"].addEventListener("click", copyWhatsappLink);
}

function init() {
  cacheDom();
  updateModeBadges();
  bindEvents();
  el["qr-session"].value = String(APP_CONFIG.defaultSession || "SERATA-1").toUpperCase();
  renderQrTab();
}

init();
