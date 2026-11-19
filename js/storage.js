const PARTICIPANT_KEY = "stm_participant_v1";
const HISTORY_KEY = "stm_history_v1";

function safeParseJson(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function generateParticipantId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return "p_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  }
  const rand = Math.random().toString(36).slice(2, 10);
  const ts = Date.now().toString(36).slice(-6);
  return `p_${ts}${rand}`;
}

export function getParticipantProfile() {
  const stored = safeParseJson(localStorage.getItem(PARTICIPANT_KEY), null);
  if (stored && typeof stored.participant_id === "string" && stored.participant_id.startsWith("p_")) {
    return {
      participant_id: stored.participant_id,
      nickname: typeof stored.nickname === "string" ? stored.nickname : "",
      lastCategory: typeof stored.lastCategory === "string" ? stored.lastCategory : ""
    };
  }
  const fresh = {
    participant_id: generateParticipantId(),
    nickname: "",
    lastCategory: ""
  };
  try {
    localStorage.setItem(PARTICIPANT_KEY, JSON.stringify(fresh));
  } catch {
    // Ignore storage quota errors
  }
  return fresh;
}

export function saveParticipantProfile({ nickname, lastCategory }) {
  const current = getParticipantProfile();
  const updated = {
    participant_id: current.participant_id,
    nickname: typeof nickname === "string" ? nickname.trim() : current.nickname,
    lastCategory: typeof lastCategory === "string" ? lastCategory : current.lastCategory
  };
  try {
    localStorage.setItem(PARTICIPANT_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage quota errors
  }
  return updated;
}

export function buildAttemptKey(session, test, round, mode) {
  return `stm_attempt_${session}_${test}_${round}_${mode}`;
}

export function loadAttempt(attemptKey) {
  const data = safeParseJson(localStorage.getItem(attemptKey), null);
  if (!data || typeof data !== "object") return null;
  return data;
}

export function saveAttempt(attempt) {
  if (!attempt || !attempt.attemptKey) return;
  try {
    localStorage.setItem(attempt.attemptKey, JSON.stringify(attempt));
  } catch {
    // Ignore storage quota errors
  }
}

/**
 * Resolves any phase timers that expired while the page was closed or reloaded.
 * Ensures an expired study phase NEVER displays its stimulus again on reload.
 */
export function resolveAttemptOnLoad(attempt, enabledSections, mode, now = Date.now()) {
  if (!attempt || attempt.phase === "onboarding" || attempt.phase === "completed") {
    return { attempt, changed: false, transitionedToCompleted: false };
  }
  if (!Array.isArray(enabledSections) || enabledSections.length === 0) {
    const completed = {
      ...attempt,
      phase: "completed",
      completedAt: attempt.completedAt || now
    };
    return { attempt: completed, changed: true, transitionedToCompleted: true };
  }

  let phase = attempt.phase;
  let sectionIndex = Number.isInteger(attempt.sectionIndex) ? attempt.sectionIndex : 0;
  if (sectionIndex < 0 || sectionIndex >= enabledSections.length) {
    sectionIndex = 0;
  }
  let phaseStartedAt = Number(attempt.phaseStartedAt) || now;
  let phaseEndsAt = Number(attempt.phaseEndsAt) || now;
  let completedAt = attempt.completedAt || null;
  let changed = false;
  let transitionedToCompleted = false;

  const answers = attempt.answers && typeof attempt.answers === "object"
    ? { ...attempt.answers }
    : {};

  while (phase !== "completed" && now >= phaseEndsAt) {
    const currentSec = enabledSections[sectionIndex];
    if (phase === "study") {
      changed = true;
      if (mode === "study") {
        sectionIndex += 1;
        if (sectionIndex >= enabledSections.length) {
          phase = "completed";
          completedAt = phaseEndsAt;
          transitionedToCompleted = true;
          break;
        }
        const nextSec = enabledSections[sectionIndex];
        phase = "study";
        phaseStartedAt = phaseEndsAt;
        phaseEndsAt = phaseStartedAt + (Number(nextSec.studySeconds) || 120) * 1000;
      } else {
        phase = "recall";
        phaseStartedAt = phaseEndsAt;
        phaseEndsAt = phaseStartedAt + (Number(currentSec.recallSeconds) || 120) * 1000;
      }
    } else if (phase === "recall") {
      // Per chimica (e matematica in Prova 2) a disegno libero: allo scadere del timer passa a selfcheck e attende conferma
      const isFreeDrawSection =
        (currentSec?.type === "chemistry" && currentSec?.mode === "free_draw_selfcheck") ||
        (currentSec?.type === "math" && Number(attempt.round) === 2 && mode === "recall");
      if (isFreeDrawSection) {
        const chemAns = answers[currentSec.id] && typeof answers[currentSec.id] === "object"
          ? answers[currentSec.id]
          : {};
        if (chemAns.subPhase !== "selfcheck") {
          answers[currentSec.id] = {
            ...chemAns,
            freeDrawMode: currentSec?.type === "math" ? true : chemAns.freeDrawMode,
            subPhase: "selfcheck"
          };
          changed = true;
        }
        break;
      }

      changed = true;
      sectionIndex += 1;
      if (sectionIndex >= enabledSections.length) {
        phase = "completed";
        completedAt = phaseEndsAt;
        transitionedToCompleted = true;
        break;
      }
      const nextSec = enabledSections[sectionIndex];
      if (mode === "recall") {
        phase = "recall";
        phaseStartedAt = phaseEndsAt;
        phaseEndsAt = phaseStartedAt + (Number(nextSec.recallSeconds) || 120) * 1000;
      } else {
        phase = "study";
        phaseStartedAt = phaseEndsAt;
        phaseEndsAt = phaseStartedAt + (Number(nextSec.studySeconds) || 120) * 1000;
      }
    } else {
      break;
    }
  }

  if (!changed) {
    return { attempt, changed: false, transitionedToCompleted: false };
  }

  const nextAttempt = {
    ...attempt,
    phase,
    sectionIndex,
    phaseStartedAt,
    phaseEndsAt,
    completedAt,
    answers
  };
  saveAttempt(nextAttempt);
  return { attempt: nextAttempt, changed: true, transitionedToCompleted };
}

export function getHistoryList() {
  const list = safeParseJson(localStorage.getItem(HISTORY_KEY), []);
  return Array.isArray(list) ? list : [];
}

export function saveHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") return [];
  const list = getHistoryList();
  const keyOf = (item) =>
    `${item.session_code}__${item.test_id}__${item.round_num}__${item.mode}__${item.participant_id}`;
  const targetKey = keyOf(entry);
  const idx = list.findIndex((item) => keyOf(item) === targetKey);
  if (idx >= 0) {
    list[idx] = entry;
  } else {
    list.push(entry);
  }
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    // Ignore storage quota errors
  }
  return list;
}

export function getParticipantSessionHistory(participantId, sessionCode) {
  const list = getHistoryList();
  return list
    .filter(
      (item) =>
        item &&
        item.participant_id === participantId &&
        item.session_code === sessionCode
    )
    .sort((a, b) => {
      const roundDiff = (Number(a.round_num) || 0) - (Number(b.round_num) || 0);
      if (roundDiff !== 0) return roundDiff;
      return String(a.completed_at || "").localeCompare(String(b.completed_at || ""));
    });
}
