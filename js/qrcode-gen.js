/**
 * Generatore QR Code puro JavaScript (zero dipendenze), conforme a ISO/IEC 18004.
 *
 * Specifiche implementate:
 * - Modalità Byte (UTF-8 tramite TextEncoder)
 * - Versioni 1–12 con selezione automatica della versione minima capace
 * - Livello di correzione errori M (ECC Level M)
 * - Polinomi Reed-Solomon su GF(256) con polinomio primitivo 0x11d
 * - Alignment patterns (V2–V12), Timing patterns, Dark module, Version info (V7–V12)
 * - Format info BCH(15, 5) mascherato con 0x5412
 * - Valutazione di tutte le 8 maschere con le 4 penalità standard ISO/IEC 18004 (N1–N4)
 * - Rendering SVG ad alto contrasto (#000000 su #FFFFFF) con quiet zone configurabile
 */

// Tabella ISO/IEC 18004 per ECC Level M (Versioni 1–12)
const VERSION_SPECS_M = [
  null, // index 0 unused
  { version: 1,  size: 21, totalCw: 26,  dataCw: 16,  ecPerBlock: 10, g1Blocks: 1, g1DataCw: 16, g2Blocks: 0, g2DataCw: 0,  align: [] },
  { version: 2,  size: 25, totalCw: 44,  dataCw: 28,  ecPerBlock: 16, g1Blocks: 1, g1DataCw: 28, g2Blocks: 0, g2DataCw: 0,  align: [6, 18] },
  { version: 3,  size: 29, totalCw: 70,  dataCw: 44,  ecPerBlock: 26, g1Blocks: 1, g1DataCw: 44, g2Blocks: 0, g2DataCw: 0,  align: [6, 22] },
  { version: 4,  size: 33, totalCw: 100, dataCw: 64,  ecPerBlock: 18, g1Blocks: 2, g1DataCw: 32, g2Blocks: 0, g2DataCw: 0,  align: [6, 26] },
  { version: 5,  size: 37, totalCw: 134, dataCw: 86,  ecPerBlock: 24, g1Blocks: 2, g1DataCw: 43, g2Blocks: 0, g2DataCw: 0,  align: [6, 30] },
  { version: 6,  size: 41, totalCw: 172, dataCw: 108, ecPerBlock: 16, g1Blocks: 4, g1DataCw: 27, g2Blocks: 0, g2DataCw: 0,  align: [6, 34] },
  { version: 7,  size: 45, totalCw: 196, dataCw: 124, ecPerBlock: 18, g1Blocks: 4, g1DataCw: 31, g2Blocks: 0, g2DataCw: 0,  align: [6, 22, 38] },
  { version: 8,  size: 49, totalCw: 242, dataCw: 154, ecPerBlock: 22, g1Blocks: 2, g1DataCw: 38, g2Blocks: 2, g2DataCw: 39, align: [6, 24, 42] },
  { version: 9,  size: 53, totalCw: 292, dataCw: 182, ecPerBlock: 22, g1Blocks: 3, g1DataCw: 36, g2Blocks: 2, g2DataCw: 37, align: [6, 26, 46] },
  { version: 10, size: 57, totalCw: 346, dataCw: 216, ecPerBlock: 26, g1Blocks: 4, g1DataCw: 43, g2Blocks: 1, g2DataCw: 44, align: [6, 28, 50] },
  { version: 11, size: 61, totalCw: 404, dataCw: 254, ecPerBlock: 30, g1Blocks: 1, g1DataCw: 50, g2Blocks: 4, g2DataCw: 51, align: [6, 30, 54] },
  { version: 12, size: 65, totalCw: 466, dataCw: 290, ecPerBlock: 22, g1Blocks: 6, g1DataCw: 36, g2Blocks: 2, g2DataCw: 37, align: [6, 32, 58] }
];

// Tabelle GF(256) con polinomio primitivo 0x11d (x^8 + x^4 + x^3 + x^2 + 1)
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_EXP[i + 255] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  GF_EXP[510] = GF_EXP[0];
  GF_EXP[511] = GF_EXP[1];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsComputeRemainder(data, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const buf = new Uint8Array(data.length + ecLen);
  buf.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const factor = buf[i];
    if (factor !== 0) {
      for (let j = 0; j < gen.length; j++) {
        buf[i + j] ^= gfMul(gen[j], factor);
      }
    }
  }
  return buf.slice(data.length);
}

function selectVersionForBytes(byteLength) {
  for (let v = 1; v < VERSION_SPECS_M.length; v++) {
    const spec = VERSION_SPECS_M[v];
    const countBits = v <= 9 ? 8 : 16;
    const neededBits = 4 + countBits + byteLength * 8;
    if (neededBits <= spec.dataCw * 8) {
      return spec;
    }
  }
  throw new Error(
    `Testo troppo lungo per QR Code versione 1–12 livello M (${byteLength} byte).`
  );
}

function appendBits(bitBuffer, value, bitCount) {
  for (let i = bitCount - 1; i >= 0; i--) {
    bitBuffer.push((value >>> i) & 1);
  }
}

function buildDataCodewords(bytes, spec) {
  const totalDataBits = spec.dataCw * 8;
  const bits = [];
  // Mode indicator 0100 (Byte mode)
  appendBits(bits, 0b0100, 4);
  // Character count indicator (8 bit per V1-9, 16 bit per V10-12)
  const countBits = spec.version <= 9 ? 8 : 16;
  appendBits(bits, bytes.length, countBits);
  for (let i = 0; i < bytes.length; i++) {
    appendBits(bits, bytes[i], 8);
  }

  // Terminator (fino a 4 bit a 0)
  const terminatorLen = Math.min(4, totalDataBits - bits.length);
  for (let i = 0; i < terminatorLen; i++) {
    bits.push(0);
  }
  // Allineamento al confine del byte
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const codewords = new Uint8Array(spec.dataCw);
  let cwIndex = 0;
  for (let i = 0; i < bits.length; i += 8) {
    let val = 0;
    for (let b = 0; b < 8; b++) {
      val = (val << 1) | bits[i + b];
    }
    codewords[cwIndex++] = val;
  }

  // Pad bytes alternati 0xEC e 0x11
  let padToggle = 0;
  while (cwIndex < spec.dataCw) {
    codewords[cwIndex++] = padToggle === 0 ? 0xec : 0x11;
    padToggle ^= 1;
  }

  return codewords;
}

function buildFinalBitstream(dataCodewords, spec) {
  const blocks = [];
  let offset = 0;

  for (let i = 0; i < spec.g1Blocks; i++) {
    const data = dataCodewords.slice(offset, offset + spec.g1DataCw);
    offset += spec.g1DataCw;
    const ec = rsComputeRemainder(data, spec.ecPerBlock);
    blocks.push({ data, ec });
  }
  for (let i = 0; i < spec.g2Blocks; i++) {
    const data = dataCodewords.slice(offset, offset + spec.g2DataCw);
    offset += spec.g2DataCw;
    const ec = rsComputeRemainder(data, spec.ecPerBlock);
    blocks.push({ data, ec });
  }

  const interleaved = [];
  const maxDataLen = Math.max(spec.g1DataCw, spec.g2DataCw);
  for (let col = 0; col < maxDataLen; col++) {
    for (let b = 0; b < blocks.length; b++) {
      if (col < blocks[b].data.length) {
        interleaved.push(blocks[b].data[col]);
      }
    }
  }
  for (let col = 0; col < spec.ecPerBlock; col++) {
    for (let b = 0; b < blocks.length; b++) {
      interleaved.push(blocks[b].ec[col]);
    }
  }

  const bits = [];
  for (let i = 0; i < interleaved.length; i++) {
    appendBits(bits, interleaved[i], 8);
  }
  return bits;
}

function createMatrix(size) {
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunction = Array.from({ length: size }, () => new Uint8Array(size));
  return { size, modules, isFunction };
}

function setFunctionModule(matrix, r, c, dark) {
  if (r < 0 || r >= matrix.size || c < 0 || c >= matrix.size) return;
  matrix.modules[r][c] = dark ? 1 : 0;
  matrix.isFunction[r][c] = 1;
}

function drawFinderPattern(matrix, topRow, leftCol) {
  // 7x7 finder + 1-module white separator intorno (9x9 area ritagliata sui bordi)
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const r = topRow + dr;
      const c = leftCol + dc;
      if (r < 0 || r >= matrix.size || c < 0 || c >= matrix.size) continue;
      const inOuter = dr === 0 || dr === 6 || dc === 0 || dc === 6;
      const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
      const inFinder = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const dark = inFinder && (inOuter || inInner);
      setFunctionModule(matrix, r, c, dark);
    }
  }
}

function drawAlignmentPattern(matrix, centerRow, centerCol) {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const dist = Math.max(Math.abs(dr), Math.abs(dc));
      setFunctionModule(matrix, centerRow + dr, centerCol + dc, dist !== 1);
    }
  }
}

function drawFunctionPatterns(matrix, spec) {
  const s = matrix.size;
  // 3 Finder patterns + separatori
  drawFinderPattern(matrix, 0, 0);
  drawFinderPattern(matrix, 0, s - 7);
  drawFinderPattern(matrix, s - 7, 0);

  // Timing patterns (riga 6 e colonna 6)
  for (let i = 8; i < s - 8; i++) {
    const dark = i % 2 === 0;
    setFunctionModule(matrix, 6, i, dark);
    setFunctionModule(matrix, i, 6, dark);
  }

  // Alignment patterns (V >= 2)
  const coords = spec.align;
  for (let i = 0; i < coords.length; i++) {
    for (let j = 0; j < coords.length; j++) {
      const r = coords[i];
      const c = coords[j];
      // Salta gli angoli occupati dai 3 finder pattern
      if ((i === 0 && j === 0) || (i === 0 && j === coords.length - 1) || (i === coords.length - 1 && j === 0)) {
        continue;
      }
      drawAlignmentPattern(matrix, r, c);
    }
  }

  // Dark module obbligatorio a (4*version + 9, 8) = (size - 8, 8)
  setFunctionModule(matrix, s - 8, 8, true);

  // Riserva aree Format Info (15 bit x 2 copie)
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFunctionModule(matrix, 8, i, false);
      setFunctionModule(matrix, i, 8, false);
    }
  }
  for (let i = s - 8; i < s; i++) {
    setFunctionModule(matrix, 8, i, false);
    if (i > s - 8) {
      setFunctionModule(matrix, i, 8, false);
    }
  }

  // Version Info (V >= 7): BCH(18, 6) su due blocchi 6x3 e 3x6
  if (spec.version >= 7) {
    let rem = spec.version << 12;
    for (let i = 17; i >= 12; i--) {
      if ((rem >>> i) & 1) {
        rem ^= 0x1f25 << (i - 12);
      }
    }
    const verBits = (spec.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((verBits >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = s - 11 + (i % 3);
      setFunctionModule(matrix, a, b, bit);
      setFunctionModule(matrix, b, a, bit);
    }
  }
}

function drawCodewordBits(matrix, bits) {
  const s = matrix.size;
  let bitIdx = 0;
  let upward = true;
  for (let col = s - 1; col >= 1; col -= 2) {
    if (col === 6) {
      col -= 1; // Salta colonna timing verticale
    }
    for (let step = 0; step < s; step++) {
      const r = upward ? s - 1 - step : step;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (!matrix.isFunction[r][c]) {
          matrix.modules[r][c] = bitIdx < bits.length ? bits[bitIdx++] : 0;
        }
      }
    }
    upward = !upward;
  }
}

function maskBit(maskPattern, r, c) {
  switch (maskPattern) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: throw new Error(`Mask pattern non valida: ${maskPattern}`);
  }
}

function computeFormatBitsLevelM(maskPattern) {
  // ECC Level M indicator = 00
  const data = (0b00 << 3) | (maskPattern & 0x07);
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >>> i) & 1) {
      rem ^= 0x537 << (i - 10);
    }
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormatBits(modules, size, maskPattern) {
  const fmt = computeFormatBitsLevelM(maskPattern);
  const bitAt = (idx) => (fmt >>> idx) & 1;

  // Copia 1 intorno al finder in alto a sinistra
  // Bit 14..9 -> (8,0)..(8,5), Bit 8 -> (8,7), Bit 7 -> (8,8), Bit 6 -> (7,8), Bit 5..0 -> (5,8)..(0,8)
  for (let i = 0; i <= 5; i++) {
    modules[8][i] = bitAt(14 - i);
  }
  modules[8][7] = bitAt(8);
  modules[8][8] = bitAt(7);
  modules[7][8] = bitAt(6);
  for (let i = 0; i <= 5; i++) {
    modules[5 - i][8] = bitAt(5 - i);
  }

  // Copia 2: Bit 14..8 -> (size-1,8)..(size-7,8), Bit 7..0 -> (8,size-8)..(8,size-1)
  for (let i = 0; i <= 6; i++) {
    modules[size - 1 - i][8] = bitAt(14 - i);
  }
  for (let i = 0; i <= 7; i++) {
    modules[8][size - 8 + i] = bitAt(7 - i);
  }
}

function cloneModulesWithMask(matrix, maskPattern) {
  const s = matrix.size;
  const out = Array.from({ length: s }, (_, r) => {
    const row = new Uint8Array(s);
    for (let c = 0; c < s; c++) {
      const bit = matrix.modules[r][c];
      row[c] = !matrix.isFunction[r][c] && maskBit(maskPattern, r, c) ? bit ^ 1 : bit;
    }
    return row;
  });
  drawFormatBits(out, s, maskPattern);
  return out;
}

function evaluatePenalty(modules, size) {
  let penalty = 0;

  // N1: sequenze consecutive >= 5 dello stesso colore (orizzontale e verticale)
  for (let r = 0; r < size; r++) {
    let runColor = modules[r][0];
    let runLen = 1;
    for (let c = 1; c < size; c++) {
      if (modules[r][c] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }

  for (let c = 0; c < size; c++) {
    let runColor = modules[0][c];
    let runLen = 1;
    for (let r = 1; r < size; r++) {
      if (modules[r][c] === runColor) {
        runLen++;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }

  // N2: blocchi 2x2 dello stesso colore
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
        penalty += 3;
      }
    }
  }

  // N3: pattern tipo finder 1:1:3:1:1 con 4 moduli bianchi prima o dopo
  // Pattern A: [1,0,1,1,1,0,1,0,0,0,0]
  // Pattern B: [0,0,0,0,1,0,1,1,1,0,1]
  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 11; c++) {
      const row = modules[r];
      if (
        row[c] === 1 && row[c + 1] === 0 && row[c + 2] === 1 && row[c + 3] === 1 &&
        row[c + 4] === 1 && row[c + 5] === 0 && row[c + 6] === 1 &&
        row[c + 7] === 0 && row[c + 8] === 0 && row[c + 9] === 0 && row[c + 10] === 0
      ) {
        penalty += 40;
      }
      if (
        row[c] === 0 && row[c + 1] === 0 && row[c + 2] === 0 && row[c + 3] === 0 &&
        row[c + 4] === 1 && row[c + 5] === 0 && row[c + 6] === 1 &&
        row[c + 7] === 1 && row[c + 8] === 1 && row[c + 9] === 0 && row[c + 10] === 1
      ) {
        penalty += 40;
      }
    }
  }

  for (let c = 0; c < size; c++) {
    for (let r = 0; r <= size - 11; r++) {
      if (
        modules[r][c] === 1 && modules[r + 1][c] === 0 && modules[r + 2][c] === 1 && modules[r + 3][c] === 1 &&
        modules[r + 4][c] === 1 && modules[r + 5][c] === 0 && modules[r + 6][c] === 1 &&
        modules[r + 7][c] === 0 && modules[r + 8][c] === 0 && modules[r + 9][c] === 0 && modules[r + 10][c] === 0
      ) {
        penalty += 40;
      }
      if (
        modules[r][c] === 0 && modules[r + 1][c] === 0 && modules[r + 2][c] === 0 && modules[r + 3][c] === 0 &&
        modules[r + 4][c] === 1 && modules[r + 5][c] === 0 && modules[r + 6][c] === 1 &&
        modules[r + 7][c] === 1 && modules[r + 8][c] === 1 && modules[r + 9][c] === 0 && modules[r + 10][c] === 1
      ) {
        penalty += 40;
      }
    }
  }

  // N4: proporzione moduli scuri rispetto al 50%
  let darkCount = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      darkCount += modules[r][c];
    }
  }
  const total = size * size;
  const k = Math.floor(Math.abs(darkCount * 20 - total * 10) / total);
  penalty += k * 10;

  return penalty;
}

/**
 * Codifica `text` in matrice QR Code ISO/IEC 18004 (ECC M, Byte UTF-8).
 * @param {string} text
 * @returns {{ version: number, size: number, mask: number, modules: Uint8Array[] }}
 */
export function encodeQrMatrix(text) {
  const input = String(text ?? "");
  const encoder = new TextEncoder();
  const bytes = encoder.encode(input);
  const spec = selectVersionForBytes(bytes.length);

  const dataCw = buildDataCodewords(bytes, spec);
  const finalBits = buildFinalBitstream(dataCw, spec);

  const matrix = createMatrix(spec.size);
  drawFunctionPatterns(matrix, spec);
  drawCodewordBits(matrix, finalBits);

  let bestMask = 0;
  let bestPenalty = Infinity;
  let bestModules = null;

  for (let mask = 0; mask < 8; mask++) {
    const candidate = cloneModulesWithMask(matrix, mask);
    const penalty = evaluatePenalty(candidate, spec.size);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
      bestModules = candidate;
    }
  }

  return {
    version: spec.version,
    size: spec.size,
    mask: bestMask,
    modules: bestModules
  };
}

function escapeXmlAttr(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Genera un SVG nitido e scansionabile del QR Code (quiet zone 4 moduli default, #000000 su #FFFFFF).
 * @param {string} text
 * @param {{ marginModules?: number, sizePx?: number }} [options]
 * @returns {string}
 */
export function renderQrSvg(text, { marginModules = 4, sizePx = 320 } = {}) {
  const margin = Math.max(0, Number.isFinite(marginModules) ? Math.floor(marginModules) : 4);
  const px = Math.max(64, Number.isFinite(sizePx) ? Math.round(sizePx) : 320);

  const { size, modules, version } = encodeQrMatrix(text);
  const totalDim = size + margin * 2;

  // Unisce le sequenze orizzontali contigue di moduli scuri per evitare artefatti subpixel
  const pathParts = [];
  for (let r = 0; r < size; r++) {
    const row = modules[r];
    let c = 0;
    while (c < size) {
      if (row[c] === 1) {
        const start = c;
        while (c < size && row[c] === 1) {
          c++;
        }
        const runLen = c - start;
        pathParts.push(`M${start + margin} ${r + margin}h${runLen}v1h-${runLen}z`);
      } else {
        c++;
      }
    }
  }

  const label = escapeXmlAttr(`QR Code (v${version}) per ${String(text).slice(0, 80)}`);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalDim} ${totalDim}" width="${px}" height="${px}" shape-rendering="crispEdges" role="img" aria-label="${label}">`,
    `<rect width="${totalDim}" height="${totalDim}" fill="#FFFFFF"/>`,
    `<path d="${pathParts.join("")}" fill="#000000"/>`,
    `</svg>`
  ].join("");
}
