function round1(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function pct(score, max) {
  if (!max || max <= 0) return 0;
  return round1((score / max) * 100);
}

export function normalizeText(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

function stripGermanArticle(normStr) {
  return normStr.replace(/^(der|die|das)\s+/i, "").trim();
}

export function levenshteinDistance(a, b) {
  const s = String(a ?? "");
  const t = String(b ?? "");
  const m = s.length;
  const n = t.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) {
    prev[j] = j;
  }

  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    const chS = s.charCodeAt(i - 1);
    for (let j = 1; j <= n; j += 1) {
      const cost = chS === t.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[n];
}

function parseNumericAnswer(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return Number.NaN;

  let numericPart = trimmed;
  const eqMatch = trimmed.match(/^[a-zA-Z0-9_() ,.]*\s*=\s*(-?\d+(?:[.,]\d+)?)$/);
  if (eqMatch) {
    numericPart = eqMatch[1];
  } else if (!/^-?\d+(?:[.,]\d+)?$/.test(trimmed)) {
    return Number.NaN;
  }

  const parsed = Number(numericPart.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function scoreDigitsSection(section, rawAnswer) {
  const expected = Array.from(String(section.digits || ""));
  const len = expected.length;
  const userDigits = new Array(len);
  for (let i = 0; i < len; i += 1) {
    const ch = String(Array.isArray(rawAnswer) ? rawAnswer[i] ?? "" : "").trim();
    userDigits[i] = /^\d$/.test(ch) ? ch : "";
  }

  let exactMatches = 0;
  for (let i = 0; i < len; i += 1) {
    if (userDigits[i] !== "" && userDigits[i] === expected[i]) {
      exactMatches += 1;
    }
  }

  const countShift = (delta) => {
    let matches = 0;
    for (let i = 0; i < len; i += 1) {
      const j = i + delta;
      if (j >= 0 && j < len && userDigits[j] !== "" && userDigits[j] === expected[i]) {
        matches += 1;
      }
    }
    return matches;
  };

  const bestShifted = Math.max(countShift(-1), countShift(1));
  const shiftDetected = bestShifted >= 5 && bestShifted - exactMatches >= 4;
  const shiftedMatches = shiftDetected ? bestShifted : 0;

  const maxRecall = Number(section.maxRecallPoints) || len;
  const maxComp = Number(section.maxComprehensionPoints) || 0;
  const max = maxRecall + maxComp;

  return {
    score: exactMatches,
    max,
    pct: pct(exactMatches, max),
    recall: exactMatches,
    maxRecall,
    comp: 0,
    maxComp,
    shiftDetected,
    shiftedMatches
  };
}

function scoreChemistrySection(section, rawAnswer) {
  const ans = rawAnswer && typeof rawAnswer === "object" ? rawAnswer : {};
  let recall = 0;
  let comp = 0;

  const vq = section.variantQuestion;
  if (vq && Array.isArray(vq.options)) {
    const picked = vq.options.find((opt) => opt.id === ans.variantId);
    if (picked && picked.isCorrect) {
      const pts = Number(vq.points) || 0;
      if (vq.dimension === "comprehension") {
        comp += pts;
      } else {
        recall += pts;
      }
    }
  }

  const detailAnswers = ans.detailAnswers && typeof ans.detailAnswers === "object" ? ans.detailAnswers : {};
  if (Array.isArray(section.detailQuestions)) {
    for (const q of section.detailQuestions) {
      if (detailAnswers[q.id] === q.correctId) {
        const pts = Number(q.points) || 0;
        if (q.dimension === "comprehension") {
          comp += pts;
        } else {
          recall += pts;
        }
      }
    }
  }

  const maxRecall = Number(section.maxRecallPoints) || 0;
  const maxComp = Number(section.maxComprehensionPoints) || 0;
  const max = maxRecall + maxComp;
  const score = round1(recall + comp);

  return {
    score,
    max,
    pct: pct(score, max),
    recall: round1(recall),
    maxRecall,
    comp: round1(comp),
    maxComp
  };
}

function scoreWordsSection(section, rawAnswer) {
  const expected = Array.isArray(section.words) ? section.words : [];
  const normExpected = expected.map(normalizeText);
  const normExpectedSet = new Set(normExpected.filter(Boolean));
  const userWords = Array.isArray(rawAnswer) ? rawAnswer : [];
  const normInputs = expected.map((_, idx) => normalizeText(userWords[idx] ?? ""));

  let recall = 0;
  const exactIndices = new Set();
  const creditedWords = new Set();

  for (let i = 0; i < normExpected.length; i += 1) {
    if (normInputs[i] && normInputs[i] === normExpected[i]) {
      recall += 1;
      exactIndices.add(i);
      creditedWords.add(normExpected[i]);
    }
  }

  for (let i = 0; i < normExpected.length; i += 1) {
    if (exactIndices.has(i) || !normInputs[i]) continue;
    if (normExpectedSet.has(normInputs[i]) && !creditedWords.has(normInputs[i])) {
      recall += 0.5;
      creditedWords.add(normInputs[i]);
    }
  }

  const maxRecall = Number(section.maxRecallPoints) || expected.length;
  const maxComp = Number(section.maxComprehensionPoints) || 0;
  const max = maxRecall + maxComp;
  const score = round1(recall);

  return {
    score,
    max,
    pct: pct(score, max),
    recall: score,
    maxRecall,
    comp: 0,
    maxComp
  };
}

function scoreVocabItem(item, entry) {
  const raw = entry && typeof entry.answer === "string" ? entry.answer : "";
  const normAns = normalizeText(raw);
  if (!normAns) return 0;

  const candidates = [
    item.foreign,
    ...(Array.isArray(item.accepted) ? item.accepted : [])
  ]
    .map(normalizeText)
    .filter(Boolean);

  if (candidates.includes(normAns)) {
    return 1;
  }

  const strippedAns = stripGermanArticle(normAns);
  const strippedCandidates = candidates.map(stripGermanArticle).filter(Boolean);
  if (strippedAns && strippedCandidates.includes(strippedAns)) {
    return 1;
  }

  for (const cand of candidates) {
    if (levenshteinDistance(normAns, cand) === 1) {
      return 0.5;
    }
  }

  if (strippedAns) {
    for (const cand of strippedCandidates) {
      if (levenshteinDistance(strippedAns, cand) === 1) {
        return 0.5;
      }
    }
  }

  return 0;
}

function scoreVocabSection(section, rawAnswer) {
  const items = Array.isArray(section.items) ? section.items : [];
  const answersMap = rawAnswer && typeof rawAnswer === "object" ? rawAnswer : {};

  let recall = 0;
  let knownCount = 0;
  let newCorrect = 0;

  for (const item of items) {
    const entry = answersMap[item.id] && typeof answersMap[item.id] === "object"
      ? answersMap[item.id]
      : {};
    const alreadyKnown = Boolean(entry.alreadyKnown);
    const pts = scoreVocabItem(item, entry);
    recall += pts;
    if (alreadyKnown) {
      knownCount += 1;
    } else {
      newCorrect += pts;
    }
  }

  const newTotal = items.length - knownCount;
  const maxRecall = Number(section.maxRecallPoints) || items.length;
  const maxComp = Number(section.maxComprehensionPoints) || 0;
  const max = maxRecall + maxComp;
  const score = round1(recall);

  return {
    score,
    max,
    pct: pct(score, max),
    recall: score,
    maxRecall,
    comp: 0,
    maxComp,
    knownCount,
    newCorrect: round1(newCorrect),
    newTotal
  };
}

function scoreMathSection(section, rawAnswer) {
  const ans = rawAnswer && typeof rawAnswer === "object" ? rawAnswer : {};
  const recallAnswers = ans.recallAnswers && typeof ans.recallAnswers === "object" ? ans.recallAnswers : {};

  let recall = 0;
  if (Array.isArray(section.recallQuestions)) {
    for (const q of section.recallQuestions) {
      if (recallAnswers[q.id] === q.correctId) {
        recall += Number(q.points) || 0;
      }
    }
  }

  let comp = 0;
  const app = section.applicationProblem;
  if (app) {
    const interVal = parseNumericAnswer(ans.intermediate);
    if (!Number.isNaN(interVal) && Math.abs(interVal - Number(app.expectedIntermediate)) <= 0.01) {
      comp += Number(app.intermediatePoints) || 0;
    }
    const finalVal = parseNumericAnswer(ans.final);
    const tol = Number(app.tolerance ?? 0.01);
    if (!Number.isNaN(finalVal) && Math.abs(finalVal - Number(app.expectedNumeric)) <= tol) {
      comp += Number(app.finalPoints) || 0;
    }
  }

  const maxRecall = Number(section.maxRecallPoints) || 0;
  const maxComp = Number(section.maxComprehensionPoints) || 0;
  const max = maxRecall + maxComp;
  const score = round1(recall + comp);

  return {
    score,
    max,
    pct: pct(score, max),
    recall: round1(recall),
    maxRecall,
    comp: round1(comp),
    maxComp
  };
}

function scoreDatesSection(section, rawAnswer) {
  const items = Array.isArray(section.items) ? section.items : [];
  const answersMap = rawAnswer && typeof rawAnswer === "object" ? rawAnswer : {};

  let recall = 0;
  let comp = 0;

  for (const item of items) {
    const entry = answersMap[item.id] && typeof answersMap[item.id] === "object"
      ? answersMap[item.id]
      : {};
    const yearStr = String(entry.year ?? "").trim();
    if (/^\d+$/.test(yearStr) && parseInt(yearStr, 10) === Number(item.year)) {
      recall += Number(item.yearPoints) || 0;
    }
    if (entry.detailChoiceId && entry.detailChoiceId === item.correctDetailId) {
      comp += Number(item.detailPoints) || 0;
    }
  }

  const maxRecall = Number(section.maxRecallPoints) || 0;
  const maxComp = Number(section.maxComprehensionPoints) || 0;
  const max = maxRecall + maxComp;
  const score = round1(recall + comp);

  return {
    score,
    max,
    pct: pct(score, max),
    recall: round1(recall),
    maxRecall,
    comp: round1(comp),
    maxComp
  };
}

export function scoreTest(testData, answersBySection = {}) {
  const sections = Array.isArray(testData?.sections) ? testData.sections : [];
  const enabledSections = sections.filter((s) => s && s.enabled !== false);

  const section_scores = {};
  let score_recall = 0;
  let max_recall = 0;
  let score_comprehension = 0;
  let max_comprehension = 0;

  for (const section of enabledSections) {
    const raw = answersBySection ? answersBySection[section.id] : undefined;
    let res;
    switch (section.type) {
      case "digits":
        res = scoreDigitsSection(section, raw);
        break;
      case "chemistry":
        res = scoreChemistrySection(section, raw);
        break;
      case "words":
        res = scoreWordsSection(section, raw);
        break;
      case "vocab":
        res = scoreVocabSection(section, raw);
        break;
      case "math":
        res = scoreMathSection(section, raw);
        break;
      case "dates":
        res = scoreDatesSection(section, raw);
        break;
      default:
        res = {
          score: 0,
          max: (Number(section.maxRecallPoints) || 0) + (Number(section.maxComprehensionPoints) || 0),
          pct: 0,
          recall: 0,
          maxRecall: Number(section.maxRecallPoints) || 0,
          comp: 0,
          maxComp: Number(section.maxComprehensionPoints) || 0
        };
    }

    section_scores[section.id] = res;
    score_recall += res.recall;
    max_recall += res.maxRecall;
    score_comprehension += res.comp;
    max_comprehension += res.maxComp;
  }

  score_recall = round1(score_recall);
  score_comprehension = round1(score_comprehension);
  const score_total = round1(score_recall + score_comprehension);
  const max_total = max_recall + max_comprehension;

  const vocabStats = section_scores.vocaboli || {
    knownCount: 0,
    newCorrect: 0,
    newTotal: 0
  };

  const digitsStats = section_scores.cifre || {
    shiftDetected: false,
    shiftedMatches: 0
  };

  return {
    score_total,
    max_total,
    pct_total: pct(score_total, max_total),
    score_recall,
    max_recall,
    pct_recall: pct(score_recall, max_recall),
    score_comprehension,
    max_comprehension,
    pct_comprehension: pct(score_comprehension, max_comprehension),
    vocab_known_count: vocabStats.knownCount || 0,
    vocab_new_correct: vocabStats.newCorrect || 0,
    vocab_new_total: vocabStats.newTotal || 0,
    digits_shift_detected: Boolean(digitsStats.shiftDetected),
    digits_shifted_matches: digitsStats.shiftedMatches || 0,
    section_scores
  };
}
