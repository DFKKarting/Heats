/* Karting Klassement - client-side PDF result parser + cumulative classification
   Tuned for the "Camp Company / MW Raceconsulting" timing PDF layout
   (columns identified by fixed x-position ranges, in PDF points). */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const STORAGE_KEY = "kartingHeats.v1";
const HIGHLIGHT_KEY = "kartingHighlights.v1";
const ACTIVE_RACE_KEY = "kartingActiveRace.v1";
const QUALIFYING_KEY = "kartingQualifying.v1";
const A_FINAL_CUTOFF = 36;
const B_FINAL_CUTOFF = 72;

const COL = {
  RANK: [16, 25],
  CAR: [48, 66],
  NAME: [70, 156],
  POINTS: [554, 585],
};

// Column layout of the "Total Qualifying Practice" PDF (different template from heat results).
const QCOL = {
  POS: [24, 40],
  CAR: [44, 63],
  NAME: [72, 168],
  BESTTIME: [436, 470],
  GROUP: [540, 578],
};

// A second qualifying template seen from some rounds/organizers: "Total Result
// Qualifying Fast Group / Slow Group". Separate Firstname/Lastname columns
// (instead of stacked first/last name), and a "Group Heats" column (A/B/C/...)
// that's what we actually want, distinct from the "Quali Group" Fast/Slow column.
const QCOL_FASTSLOW = {
  POS: [8, 26],
  CAR: [27, 49],
  FIRSTNAME: [50, 112],
  LASTNAME: [112, 206],
  BESTTIME: [428, 470],
  GROUP: [566, 590],
};

// A third template: a plain per-class "<Class> - Qualifying Practice" sheet,
// laid out like a heat result (stacked first/last name) but with different
// column x-positions than the "Total Qualifying Practice" template, and no
// group column at all (single ungrouped qualifying session).
const QCOL_PLAIN = {
  POS: [16, 27],
  CAR: [30, 44],
  NAME: [48, 145],
  BESTTIME: [370, 412],
  GROUP: null,
};

// Heat results from GK4 Kart Series (different organizer/timing software -
// "Orbits" - not Camp Company). Single-line "Firstname Lastname" instead of
// stacked two-line name, and a completely different column layout.
const GK4_COL = {
  // Right-aligned column: a plain rank ("1", "12") sits close to x=24, but a
  // DSQ/DNF code is wider text starting further left - widen the lower bound
  // so those "Not classified" rows still anchor as rows.
  RANK: [0, 24],
  CAR: [28, 58],
  NAME: [58, 178],
  POINTS: [534, 552],
};

// GK4's qualifying sheet uses the same generator/layout family as its heat
// results (single-line name), just with slightly different column widths and
// no group column (single, ungrouped qualifying session).
const GK4_QCOL = {
  POS: [10, 26],
  CAR: [28, 60],
  NAME: [60, 224],
};

function loadHeats() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveHeats(heats) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(heats));
}

function loadQualifying() {
  try {
    return JSON.parse(localStorage.getItem(QUALIFYING_KEY)) || [];
  } catch {
    return [];
  }
}

function saveQualifying(qualifying) {
  localStorage.setItem(QUALIFYING_KEY, JSON.stringify(qualifying));
}

function loadHighlights() {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIGHLIGHT_KEY)) || []);
  } catch {
    return new Set();
  }
}

function saveHighlights(set) {
  localStorage.setItem(HIGHLIGHT_KEY, JSON.stringify([...set]));
}

function loadActiveRace() {
  return localStorage.getItem(ACTIVE_RACE_KEY) || null;
}

function saveActiveRace(eventName) {
  if (eventName) {
    localStorage.setItem(ACTIVE_RACE_KEY, eventName);
  } else {
    localStorage.removeItem(ACTIVE_RACE_KEY);
  }
}

function deriveRaceLabel(eventName) {
  if (!eventName) return "Onbekende race";
  const m = eventName.match(/^(.*?)\s+Round\s+(\d+)/i);
  if (m) {
    const initials = m[1]
      .split(/\s+/)
      .filter((w) => /^[A-Z]/.test(w))
      .map((w) => w[0])
      .join("");
    if (initials) return `${initials} R${m[2]}`;
  }
  return eventName;
}

// Different documents for the same physical event sometimes title themselves
// slightly differently (e.g. "IAME Benelux Round 1" vs "IAME Series Benelux
// Round 1 Mariembourg"). Group races by round number instead of exact string
// match so they don't fragment into duplicate tabs.
function deriveRaceKey(eventName) {
  if (!eventName) return "unknown-race";
  const m = eventName.match(/^(.*?)\s+Round\s+(\d+)/i);
  if (!m) return eventName.trim().toLowerCase();
  // Different championships can both use "Round N" numbering (e.g. IAME
  // Benelux Round 4 vs GK4 Kart Series Round 4) - fold in a normalized series
  // name (stripped of generic/variable words) so they don't collide, while
  // still unifying slightly differently worded titles for the same series
  // (e.g. "IAME Benelux" vs "IAME Series Benelux ... Genk").
  const STOPWORDS = new Set(["series", "iame", "kart", "karting"]);
  const seriesWords = m[1]
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .sort();
  const seriesKey = seriesWords.join("-") || "series";
  return `${seriesKey}-round-${m[2]}`;
}

function within(x, [lo, hi]) {
  return x >= lo && x <= hi;
}

// The Rank column is rendered bold by double-drawing every character (e.g. "1" -> "11",
// "DSQ" -> "DDSSQQ"). Collapse that back to the original text where it applies.
function collapseDoubled(text) {
  if (text.length % 2 !== 0) return text;
  let result = "";
  for (let i = 0; i < text.length; i += 2) {
    if (text[i] !== text[i + 1]) return text;
    result += text[i];
  }
  return result;
}

// A row is anchored either by a plain rank number, or by a non-finish code
// (DSQ, DNF, DNS, ...) for drivers listed under "Not classified" - they still
// have a Points value that must count towards the total.
function isRowAnchorText(text) {
  for (const candidate of new Set([text, collapseDoubled(text)])) {
    if (/^[0-9]+$/.test(candidate)) return true;
    if (/^(DSQ|DQ|DNF|DNS|EXC|NC)$/i.test(candidate)) return true;
  }
  return false;
}

function clusterByY(items, tolerance = 3) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    let line = lines.find((l) => Math.abs(l.y - it.y) < tolerance);
    if (!line) {
      line = { y: it.y, items: [] };
      lines.push(line);
    }
    line.items.push(it);
  }
  lines.sort((a, b) => a.y - b.y);
  return lines.map((l) => ({
    y: l.y,
    text: l.items
      .sort((a, b) => a.x - b.x)
      .map((i) => i.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim(),
  }));
}

async function extractPageItems(page) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const seen = new Set();
  const items = [];
  for (const it of content.items) {
    const text = it.str;
    if (!text || !text.trim()) continue;
    const x = it.transform[4];
    const y = viewport.height - it.transform[5];
    const key = `${Math.round(x)}|${Math.round(y)}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ text, x, y });
  }
  return items;
}

function parsePrintedAt(items) {
  // The timing software stamps every export with a "Printed:" timestamp -
  // "DD.MM.YYYY / HH:MM" (Camp Company) or "DD.MM.YYYY HH:MM:SS" (Orbits/GK4).
  // A later stamp for the same heat means it's a newer, revised export.
  const rawText = items.map((it) => it.text).join(" ");
  const m = rawText.match(/Printed:\s*(\d{2})\.(\d{2})\.(\d{4})\s*\/?\s*(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min, sec] = m;
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${sec || "00"}`;
}

function parseTitleBlock(items, tableTopY) {
  const above = items.filter((it) => it.x < 350 && it.y < tableTopY - 15);
  const lines = clusterByY(above, 3).sort((a, b) => a.y - b.y);
  const eventName = lines[0] ? lines[0].text : "";
  const classLine = lines[1] ? lines[1].text : "";
  let className = classLine;
  let heatLabel = "";
  let revision = null;
  // "Revision N" is kept separate from heatLabel so a revised heat keeps the
  // same identity as the original (and correctly overwrites it) instead of
  // being treated as an extra heat.
  const m = classLine.match(/^(.*?)\s*-\s*(Heat\s+\d+\s*[A-Za-z0-9\-]*)(?:\s+Revision\s+(\d+))?\s*$/i);
  if (m) {
    className = m[1].trim();
    heatLabel = m[2].trim();
    revision = m[3] ? parseInt(m[3], 10) : null;
  }
  return { eventName, className: className || "Onbekende klasse", heatLabel: heatLabel || classLine || "Heat", revision };
}

function parseRows(items) {
  const rankAnchors = items
    .filter((it) => within(it.x, COL.RANK) && isRowAnchorText(it.text))
    .sort((a, b) => a.y - b.y);

  // merge anchors that are effectively the same row (within 3pt)
  const anchors = [];
  for (const a of rankAnchors) {
    if (anchors.length && Math.abs(anchors[anchors.length - 1].y - a.y) < 3) continue;
    anchors.push(a);
  }
  if (!anchors.length) return { rows: [], tableTopY: null };

  const rows = [];
  for (let i = 0; i < anchors.length; i++) {
    const y0 = anchors[i].y;
    const y1 = i + 1 < anchors.length ? anchors[i + 1].y : y0 + 16;
    const band = items.filter((it) => it.y >= y0 - 6 && it.y < y1 - 6);

    const carItem = band.find((it) => within(it.x, COL.CAR) && /^[0-9]+$/.test(it.text));
    const nameItems = band
      .filter((it) => within(it.x, COL.NAME))
      .sort((a, b) => a.y - b.y || a.x - b.x);

    let firstName = "";
    let lastName = "";
    if (nameItems.length) {
      const minY = Math.min(...nameItems.map((it) => it.y));
      firstName = nameItems
        .filter((it) => Math.abs(it.y - minY) < 3)
        .sort((a, b) => a.x - b.x)
        .map((it) => it.text)
        .join(" ");
      lastName = nameItems
        .filter((it) => Math.abs(it.y - minY) >= 3)
        .sort((a, b) => a.x - b.x)
        .map((it) => it.text)
        .join(" ");
    }
    const lastNameClean = lastName.replace(/\s*\([A-Za-z]\)\s*$/, "").trim();
    const fullName = `${firstName} ${lastNameClean}`.replace(/\s+/g, " ").trim();

    const pointsItem = band.find((it) => within(it.x, COL.POINTS) && /^[0-9]+$/.test(it.text));

    if (!fullName) continue; // skip malformed/incomplete trailing rows

    const anchorCode = collapseDoubled(anchors[i].text).toUpperCase();
    const resultCode = /^[0-9]+$/.test(anchorCode) ? null : anchorCode;

    rows.push({
      rank: i + 1,
      car: carItem ? carItem.text : "",
      firstName,
      lastName: lastNameClean,
      fullName,
      points: pointsItem ? parseInt(pointsItem.text, 10) : null,
      resultCode,
    });
  }
  return { rows, tableTopY: Math.min(...anchors.map((a) => a.y)) };
}

function isGK4Heat(items) {
  const above = items.filter((it) => it.y < 100);
  const topText = clusterByY(above, 3).map((l) => l.text).join(" ");
  return /GK4/i.test(topText);
}

// GK4 Kart Series heat results (Orbits timing, not Camp Company): single-line
// "Firstname Lastname" instead of stacked two-line name, plain (non-doubled)
// rank digits, and a 3-line title block (event / class / heat), each with
// track/date info off to the right that needs filtering out.
function parseRowsGK4(items) {
  const rankAnchors = items
    .filter((it) => within(it.x, GK4_COL.RANK) && isRowAnchorText(it.text))
    .sort((a, b) => a.y - b.y);

  const anchors = [];
  for (const a of rankAnchors) {
    if (anchors.length && Math.abs(anchors[anchors.length - 1].y - a.y) < 3) continue;
    anchors.push(a);
  }
  if (!anchors.length) return { rows: [], tableTopY: null };

  const rows = [];
  for (let i = 0; i < anchors.length; i++) {
    const y0 = anchors[i].y;
    const y1 = i + 1 < anchors.length ? anchors[i + 1].y : y0 + 16;
    const band = items.filter((it) => it.y >= y0 - 6 && it.y < y1 - 6);

    const carItem = band.find((it) => within(it.x, GK4_COL.CAR) && /^[0-9]+$/.test(it.text));
    const fullName = band
      .filter((it) => within(it.x, GK4_COL.NAME))
      .sort((a, b) => a.x - b.x)
      .map((it) => it.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!fullName) continue;

    const spaceIdx = fullName.indexOf(" ");
    const firstName = spaceIdx === -1 ? fullName : fullName.slice(0, spaceIdx);
    const lastName = spaceIdx === -1 ? "" : fullName.slice(spaceIdx + 1);

    const pointsItem = band.find((it) => within(it.x, GK4_COL.POINTS) && /^[0-9]+$/.test(it.text));
    const anchorCode = collapseDoubled(anchors[i].text).toUpperCase();
    const resultCode = /^[0-9]+$/.test(anchorCode) ? null : anchorCode;

    rows.push({
      rank: i + 1,
      car: carItem ? carItem.text : "",
      firstName,
      lastName,
      fullName,
      points: pointsItem ? parseInt(pointsItem.text, 10) : null,
      resultCode,
    });
  }
  return { rows, tableTopY: Math.min(...anchors.map((a) => a.y)) };
}

function parseTitleBlockGK4(items, tableTopY) {
  const above = items.filter((it) => it.x < 250 && it.y < tableTopY - 5);
  const lines = clusterByY(above, 3).sort((a, b) => a.y - b.y);
  const eventName = lines[0] ? lines[0].text.trim() : "";
  const className = lines[1] ? lines[1].text.trim() : "Onbekende klasse";
  const heatLabel = lines[2] ? lines[2].text.trim() : "Heat";
  return { eventName, className, heatLabel, revision: null };
}

function buildHeatRecord(file, items) {
  const gk4 = isGK4Heat(items);
  const { rows, tableTopY } = gk4 ? parseRowsGK4(items) : parseRows(items);
  if (!rows.length) {
    throw new Error("Kon geen resultatentabel herkennen in dit PDF.");
  }
  const { eventName, className, heatLabel, revision } = gk4
    ? parseTitleBlockGK4(items, tableTopY)
    : parseTitleBlock(items, tableTopY);
  const printedAt = parsePrintedAt(items);
  const raceKey = deriveRaceKey(eventName);

  return {
    id: `${raceKey}::${className}::${heatLabel}`,
    className,
    heatLabel,
    eventName,
    raceKey,
    revision,
    fileName: file.name,
    uploadedAt: new Date().toISOString(),
    printedAt,
    rows,
  };
}

// Parses one page of the "Total Qualifying Practice" PDF - a different template
// from heat results: Pos. / No. / Driver / Equipment / Raceteam / Best Time / Pos. in Group / Group.
function parseQualifyingRowsFromItems(items, cols) {
  const posAnchors = items
    .filter((it) => within(it.x, cols.POS) && /^[0-9]+$/.test(it.text))
    .sort((a, b) => a.y - b.y);

  const anchors = [];
  for (const a of posAnchors) {
    if (anchors.length && Math.abs(anchors[anchors.length - 1].y - a.y) < 3) continue;
    anchors.push(a);
  }
  if (!anchors.length) return [];

  const rows = [];
  for (let i = 0; i < anchors.length; i++) {
    const y0 = anchors[i].y;
    const y1 = i + 1 < anchors.length ? anchors[i + 1].y : y0 + 18;
    const band = items.filter((it) => it.y >= y0 - 6 && it.y < y1 - 6);

    const carItem = band.find((it) => within(it.x, cols.CAR) && /^[0-9]+$/.test(it.text));
    const nameItems = band
      .filter((it) => within(it.x, cols.NAME))
      .sort((a, b) => a.y - b.y || a.x - b.x);

    let firstName = "";
    let lastName = "";
    if (nameItems.length) {
      const minY = Math.min(...nameItems.map((it) => it.y));
      firstName = nameItems
        .filter((it) => Math.abs(it.y - minY) < 3)
        .sort((a, b) => a.x - b.x)
        .map((it) => it.text)
        .join(" ");
      lastName = nameItems
        .filter((it) => Math.abs(it.y - minY) >= 3)
        .sort((a, b) => a.x - b.x)
        .map((it) => it.text)
        .join(" ");
    }
    const lastNameClean = lastName.replace(/\s*\([A-Za-z]\)\s*$/, "").trim();
    const fullName = `${firstName} ${lastNameClean}`.replace(/\s+/g, " ").trim();
    if (!fullName) continue;

    const bestTimeItem = band.find((it) => within(it.x, cols.BESTTIME) && /^\d{1,2}:?\d{2}\.\d{3}$/.test(it.text));
    const groupItem = cols.GROUP ? band.find((it) => within(it.x, cols.GROUP) && /^[A-Z]$/.test(it.text)) : null;

    rows.push({
      car: carItem ? carItem.text : "",
      fullName,
      bestTime: bestTimeItem ? bestTimeItem.text : null,
      group: groupItem ? groupItem.text : null,
    });
  }
  return rows;
}

// "Total Result Qualifying Fast Group / Slow Group" template - Firstname and
// Lastname are separate columns on the same line (no stacked two-line name),
// and the heat-pairing group letter is in a "Group Heats" column, distinct
// from the "Quali Group" (Fast/Slow) column.
function parseQualifyingRowsFromItemsFastSlow(items) {
  const posAnchors = items
    .filter((it) => within(it.x, QCOL_FASTSLOW.POS) && /^[0-9]+$/.test(it.text))
    .sort((a, b) => a.y - b.y);

  const anchors = [];
  for (const a of posAnchors) {
    if (anchors.length && Math.abs(anchors[anchors.length - 1].y - a.y) < 3) continue;
    anchors.push(a);
  }
  if (!anchors.length) return [];

  const rows = [];
  for (let i = 0; i < anchors.length; i++) {
    const y0 = anchors[i].y;
    const y1 = i + 1 < anchors.length ? anchors[i + 1].y : y0 + 18;
    const band = items.filter((it) => it.y >= y0 - 6 && it.y < y1 - 6);

    const carItem = band.find((it) => within(it.x, QCOL_FASTSLOW.CAR) && /^[0-9]+$/.test(it.text));
    const firstName = band
      .filter((it) => within(it.x, QCOL_FASTSLOW.FIRSTNAME))
      .sort((a, b) => a.x - b.x)
      .map((it) => it.text)
      .join(" ");
    const lastNameRaw = band
      .filter((it) => within(it.x, QCOL_FASTSLOW.LASTNAME))
      .sort((a, b) => a.x - b.x)
      .map((it) => it.text)
      .join(" ");
    const lastNameClean = lastNameRaw.replace(/\s*\([A-Za-z]\)\s*$/, "").trim();
    const fullName = `${firstName} ${lastNameClean}`.replace(/\s+/g, " ").trim();
    if (!fullName) continue;

    const bestTimeItem = band.find((it) => within(it.x, QCOL_FASTSLOW.BESTTIME) && /^\d{1,2}[.,]\d{3}$/.test(it.text));
    const groupItem = band.find((it) => within(it.x, QCOL_FASTSLOW.GROUP) && /^[A-Z]$/.test(it.text));

    rows.push({
      car: carItem ? carItem.text : "",
      fullName,
      bestTime: bestTimeItem ? bestTimeItem.text.replace(",", ".") : null,
      group: groupItem ? groupItem.text : null,
    });
  }
  return rows;
}

function detectQualifyingVariant(items) {
  const lines = clusterByY(items, 3).sort((a, b) => a.y - b.y);
  const topText = lines.slice(0, 6).map((l) => l.text).join(" ");
  if (/GK4/i.test(topText)) {
    return "gk4";
  }
  if (/Fast\s+Group\s*\/\s*Slow\s+Group/i.test(topText) || /Result\s+Qualifying/i.test(topText)) {
    return "fastslow";
  }
  if (/Total\s+Qualifying/i.test(topText)) {
    return "totalpractice";
  }
  // A plain "<Class> - Qualifying Practice" sheet: same layout family as a
  // heat result (stacked name) but different column x-positions, no group column.
  return "plainpractice";
}

// GK4's qualifying sheet: single-line "Firstname Lastname", no group column.
function parseQualifyingRowsFromItemsGK4(items) {
  const posAnchors = items
    .filter((it) => within(it.x, GK4_QCOL.POS) && /^[0-9]+$/.test(it.text))
    .sort((a, b) => a.y - b.y);

  const anchors = [];
  for (const a of posAnchors) {
    if (anchors.length && Math.abs(anchors[anchors.length - 1].y - a.y) < 3) continue;
    anchors.push(a);
  }
  if (!anchors.length) return [];

  const rows = [];
  for (let i = 0; i < anchors.length; i++) {
    const y0 = anchors[i].y;
    const y1 = i + 1 < anchors.length ? anchors[i + 1].y : y0 + 16;
    const band = items.filter((it) => it.y >= y0 - 6 && it.y < y1 - 6);

    const carItem = band.find((it) => within(it.x, GK4_QCOL.CAR) && /^[0-9]+$/.test(it.text));
    const fullName = band
      .filter((it) => within(it.x, GK4_QCOL.NAME))
      .sort((a, b) => a.x - b.x)
      .map((it) => it.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!fullName) continue;

    rows.push({ car: carItem ? carItem.text : "", fullName, bestTime: null, group: null });
  }
  return rows;
}

function parseQualifyingClassNameGK4(items, tableTopY) {
  const above = items.filter((it) => it.x < 250 && it.y < tableTopY - 5);
  const lines = clusterByY(above, 3).sort((a, b) => a.y - b.y);
  return lines[1] ? lines[1].text.trim() : "Onbekende klasse";
}

function parseQualifyingClassName(items, tableTopY, knownClassNames, variant) {
  const above = items.filter((it) => it.x < 300 && it.y < tableTopY - 8);
  const lines = clusterByY(above, 3).sort((a, b) => a.y - b.y);
  const classLine = (lines[1] ? lines[1].text : lines[0] ? lines[0].text : "").trim();

  // "<Class> - Qualifying Practice" (e.g. "Mini Rookie - Qualifying Practice")
  const dashMatch = classLine.match(/^(.*?)\s*-\s*(?:Total\s+)?Qualifying(?:\s+Practice)?\s*$/i);
  if (dashMatch) return dashMatch[1].trim();

  for (const known of knownClassNames) {
    if (classLine.toLowerCase() === known.toLowerCase() || classLine.toLowerCase().startsWith(`${known.toLowerCase()} `)) {
      return known;
    }
  }
  // The "fastslow" template's class line has no trailing track name (e.g.
  // just "X30 Junior") - trust it as-is instead of chopping off a real word.
  if (variant === "fastslow") return classLine || "Onbekende klasse";
  // Fallback: this line is "<class name> <track>" with no delimiter (e.g. "X30 Senior Genk") -
  // assume the last word is the track name.
  const words = classLine.split(/\s+/).filter(Boolean);
  if (words.length > 1) return words.slice(0, -1).join(" ");
  return classLine || "Onbekende klasse";
}

// Qualifying PDFs title their event slightly differently from heat PDFs (e.g.
// "Iame Series Benelux Round 4" vs "IAME Series Benelux Round 4 Genk"), so we
// can't match on exact eventName text. Match on the round number against races
// we already know about instead - this works regardless of which race tab is
// currently active, which matters for background auto-import.
function findRaceForQualifying(page1Items) {
  // The event name is reliably the first position-sorted line on every
  // template seen so far (Camp Company and GK4/Orbits alike) - run it through
  // the same deriveRaceKey used for heats so matching stays consistent even
  // as more championships/templates are added.
  const lines = clusterByY(page1Items, 3).sort((a, b) => a.y - b.y);
  const titleGuess = lines[0] ? lines[0].text : "";
  const guessKey = deriveRaceKey(titleGuess);
  const guessMatch = heats.find((h) => (h.raceKey || deriveRaceKey(h.eventName)) === guessKey);
  if (guessMatch) return { eventName: guessMatch.eventName, raceKey: guessMatch.raceKey || deriveRaceKey(guessMatch.eventName) };

  // No heat for this race yet - this qualifying PDF may be the very first
  // data uploaded for it (a preliminary, quali-only classification). Use its
  // own title as the race identity instead of guessing at some other race
  // that happens to be active, which would wrongly attach it there.
  if (titleGuess) return { eventName: titleGuess, raceKey: guessKey };

  if (activeRace) {
    const match = heats.find((h) => (h.raceKey || deriveRaceKey(h.eventName)) === activeRace);
    if (match) return { eventName: match.eventName, raceKey: activeRace };
  }
  if (heats.length) return { eventName: heats[0].eventName, raceKey: heats[0].raceKey || deriveRaceKey(heats[0].eventName) };
  return null;
}

async function parseQualifyingPdf(file, pdf, page1Items) {
  const variant = detectQualifyingVariant(page1Items);
  const cols = variant === "fastslow" ? QCOL_FASTSLOW : variant === "totalpractice" ? QCOL : variant === "gk4" ? GK4_QCOL : QCOL_PLAIN;

  const allRows = [];
  let tableTopY = null;
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const items = pageNum === 1 ? page1Items : await extractPageItems(await pdf.getPage(pageNum));
    if (pageNum === 1) {
      const anchorYs = items.filter((it) => within(it.x, cols.POS) && /^[0-9]+$/.test(it.text)).map((it) => it.y);
      tableTopY = anchorYs.length ? Math.min(...anchorYs) : null;
    }
    if (variant === "fastslow") {
      allRows.push(...parseQualifyingRowsFromItemsFastSlow(items));
    } else if (variant === "gk4") {
      allRows.push(...parseQualifyingRowsFromItemsGK4(items));
    } else {
      allRows.push(...parseQualifyingRowsFromItems(items, cols));
    }
  }
  if (!allRows.length) {
    throw new Error("Kon geen qualifying-tabel herkennen in dit PDF.");
  }
  const race = findRaceForQualifying(page1Items);
  if (!race) {
    throw new Error("Kon de race niet herkennen in dit PDF.");
  }
  const { eventName, raceKey } = race;
  const entries = allRows.map((r, idx) => ({ ...r, pos: idx + 1 }));

  const knownClassNames = [...new Set(heats.filter((h) => (h.raceKey || deriveRaceKey(h.eventName)) === raceKey).map((h) => h.className))];
  const className =
    variant === "gk4"
      ? tableTopY
        ? parseQualifyingClassNameGK4(page1Items, tableTopY)
        : knownClassNames[0] || "Onbekende klasse"
      : tableTopY
        ? parseQualifyingClassName(page1Items, tableTopY, knownClassNames, variant)
        : knownClassNames[0] || "Onbekende klasse";
  const printedAt = parsePrintedAt(page1Items);

  return {
    id: `${raceKey}::${className}`,
    className,
    eventName,
    raceKey,
    fileName: file.name,
    uploadedAt: new Date().toISOString(),
    printedAt,
    entries,
  };
}

function looksLikeQualifyingPdf(items) {
  // Words in the PDF's internal content-stream order don't always match reading
  // order, so words from the title can end up non-adjacent in a naive join.
  // Sort by position (like the title-block parsing does) before testing, and
  // only look at the title area - "Qualifying" never appears there on a heat
  // result PDF, whichever qualifying template this turns out to be.
  const lines = clusterByY(items, 3).sort((a, b) => a.y - b.y);
  const titleText = lines.slice(0, 6).map((l) => l.text).join(" ");
  return /\bQualifying\b/i.test(titleText);
}

async function parseUploadedFile(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const page1 = await pdf.getPage(1);
  const items1 = await extractPageItems(page1);

  if (looksLikeQualifyingPdf(items1)) {
    return { docType: "qualifying", record: await parseQualifyingPdf(file, pdf, items1) };
  }
  return { docType: "heat", record: buildHeatRecord(file, items1) };
}

/* ---------------- UI ---------------- */

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const parseStatus = document.getElementById("parseStatus");
const heatsList = document.getElementById("heatsList");
const classificationsContainer = document.getElementById("classificationsContainer");
const resetBtn = document.getElementById("resetBtn");
const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");
const toggleHeatsBtn = document.getElementById("toggleHeatsBtn");
const highlightedContainer = document.getElementById("highlightedContainer");
const raceSelect = document.getElementById("raceSelect");
const classSelect = document.getElementById("classSelect");
const heatModalOverlay = document.getElementById("heatModalOverlay");
const heatModalBody = document.getElementById("heatModalBody");
const heatModalClose = document.getElementById("heatModalClose");

function showHeatModal(heatId) {
  const heat = heats.find((h) => h.id === heatId);
  if (!heat) return;

  const rows = [...heat.rows]
    .sort((a, b) => a.rank - b.rank)
    .map(
      (row) => `<tr>
        <td class="pos">${row.resultCode || row.rank}</td>
        <td class="name-cell">${row.fullName} <span class="car-number">#${row.car}</span></td>
        <td class="num total">${row.points !== null ? row.points : "–"}</td>
      </tr>`
    )
    .join("");

  heatModalBody.innerHTML = `
    <h2>${heat.className} — ${heat.heatLabel}</h2>
    <p class="heat-modal-meta">${heat.eventName || ""}</p>
    <div style="overflow-x:auto;">
      <table class="classification">
        <thead>
          <tr>
            <th>Pos</th>
            <th>Rijder</th>
            <th class="num">Punten</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
  heatModalOverlay.hidden = false;
}

function closeHeatModal() {
  heatModalOverlay.hidden = true;
}

heatModalClose.addEventListener("click", closeHeatModal);
heatModalOverlay.addEventListener("click", (e) => {
  if (e.target === heatModalOverlay) closeHeatModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !heatModalOverlay.hidden) closeHeatModal();
});

const HEATS_COLLAPSED_KEY = "kartingHeatsCollapsed.v1";
let heatsCollapsed = localStorage.getItem(HEATS_COLLAPSED_KEY) !== "false"; // collapsed by default

function applyHeatsCollapsedState() {
  heatsList.classList.toggle("collapsed", heatsCollapsed);
  toggleHeatsBtn.setAttribute("aria-expanded", String(!heatsCollapsed));
  toggleHeatsBtn.querySelector(".chevron").textContent = heatsCollapsed ? "▸" : "▾";
}

toggleHeatsBtn.addEventListener("click", () => {
  heatsCollapsed = !heatsCollapsed;
  localStorage.setItem(HEATS_COLLAPSED_KEY, String(heatsCollapsed));
  applyHeatsCollapsedState();
});

applyHeatsCollapsedState();

const CLASS_COLLAPSED_KEY = "kartingClassCollapsed.v1";
let collapsedClasses = new Set(JSON.parse(localStorage.getItem(CLASS_COLLAPSED_KEY)) || []);

function toggleClassCollapsed(className) {
  if (collapsedClasses.has(className)) {
    collapsedClasses.delete(className);
  } else {
    collapsedClasses.add(className);
  }
  localStorage.setItem(CLASS_COLLAPSED_KEY, JSON.stringify([...collapsedClasses]));
  render();
}

let heats = loadHeats();
let highlights = loadHighlights();
let activeRace = loadActiveRace();
let qualifying = loadQualifying();

const ACTIVE_CLASS_KEY = "kartingActiveClass.v1";
let activeClass = localStorage.getItem(ACTIVE_CLASS_KEY) || null;

raceSelect.addEventListener("change", () => {
  activeRace = raceSelect.value;
  saveActiveRace(activeRace);
  activeClass = null;
  localStorage.removeItem(ACTIVE_CLASS_KEY);
  render();
});

classSelect.addEventListener("change", () => {
  activeClass = classSelect.value;
  localStorage.setItem(ACTIVE_CLASS_KEY, activeClass);
  render();
});

const SHOW_HEATS_KEY = "kartingShowHeatColumns.v1";
let showHeatColumns = localStorage.getItem(SHOW_HEATS_KEY) !== "false"; // shown by default
const SHOW_ANEED_KEY = "kartingShowANeed.v1";
let showANeedPref = localStorage.getItem(SHOW_ANEED_KEY) !== "false"; // "Nodig voor A" column, shown by default

function toggleHighlight(key) {
  if (highlights.has(key)) {
    highlights.delete(key);
  } else {
    highlights.add(key);
  }
  saveHighlights(highlights);
  render();
}

// Same revision logic as mergeHeat: a qualifying upload with the same race+class
// replaces the previous one only if it isn't an older revision.
function mergeQualifying(parsed) {
  const idx = qualifying.findIndex((q) => q.id === parsed.id);
  if (idx === -1) {
    qualifying.push(parsed);
    return "added";
  }
  const existing = qualifying[idx];
  if (existing.printedAt && parsed.printedAt && parsed.printedAt < existing.printedAt) {
    return "skipped-older-revision";
  }
  qualifying[idx] = parsed;
  return existing.printedAt && parsed.printedAt && parsed.printedAt > existing.printedAt
    ? "replaced-with-revision"
    : "replaced";
}

// Qualifying sheets and heat sheets don't always name a class identically
// (e.g. qualifying "Senior" vs heats "X30 Senior"). Treat two names as the same
// class when they're equal or one is the other with extra leading words.
function classesMatch(a, b) {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  return x === y || x.endsWith(` ${y}`) || y.endsWith(` ${x}`);
}

function findQualifyingFor(raceKey, className) {
  const inRace = qualifying.filter((q) => (q.raceKey || deriveRaceKey(q.eventName)) === raceKey);
  return inRace.find((q) => q.className === className) || inRace.find((q) => classesMatch(q.className, className));
}

function getQualiPosMap(raceKey, className) {
  const q = findQualifyingFor(raceKey, className);
  if (!q) return null;
  const map = new Map();
  for (const e of q.entries) map.set(e.fullName, e.pos);
  return map;
}

// Everyone races each other group exactly once, so the number of qualifying
// groups (A, B, C, ...) minus one gives the total number of heats per driver -
// derived from the data itself instead of guessed.
function getTotalHeatsForClass(raceKey, className) {
  const q = findQualifyingFor(raceKey, className);
  if (!q) return null;
  const groups = new Set(q.entries.map((e) => e.group).filter(Boolean));
  return groups.size > 1 ? groups.size - 1 : null;
}

function activeQualifying() {
  return qualifying.filter((q) => (q.raceKey || deriveRaceKey(q.eventName)) === activeRace);
}

function removeQualifying(id) {
  qualifying = qualifying.filter((q) => q.id !== id);
  saveQualifying(qualifying);
  render();
}

function getRaces() {
  const byKey = new Map();
  for (const h of heats) {
    const key = h.raceKey || deriveRaceKey(h.eventName);
    if (!byKey.has(key)) byKey.set(key, { firstSeen: h.uploadedAt, count: 0, eventNames: new Map() });
    const r = byKey.get(key);
    r.count += 1;
    if (h.uploadedAt < r.firstSeen) r.firstSeen = h.uploadedAt;
    r.eventNames.set(h.eventName, (r.eventNames.get(h.eventName) || 0) + 1);
  }
  // A race can also exist with only a qualifying PDF uploaded so far (the
  // preliminary, quali-only classification) - make sure it still shows up in
  // the race selector even though there's no heat for it yet.
  for (const q of qualifying) {
    const key = q.raceKey || deriveRaceKey(q.eventName);
    if (!byKey.has(key)) byKey.set(key, { firstSeen: q.uploadedAt, count: 0, eventNames: new Map() });
    const r = byKey.get(key);
    if (q.uploadedAt < r.firstSeen) r.firstSeen = q.uploadedAt;
    if (!r.eventNames.has(q.eventName)) r.eventNames.set(q.eventName, 0);
  }
  return [...byKey.entries()]
    .map(([raceKey, info]) => {
      // Different documents for the same race can title themselves slightly
      // differently - use the longest (most descriptive) variant seen as the label.
      const eventName = [...info.eventNames.keys()].sort((a, b) => b.length - a.length)[0];
      return { raceKey, eventName, label: deriveRaceLabel(eventName), firstSeen: info.firstSeen, count: info.count };
    })
    .sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
}

function activeHeats() {
  return heats.filter((h) => (h.raceKey || deriveRaceKey(h.eventName)) === activeRace);
}

function renderSelectors(races, classifications) {
  if (!races.length) {
    raceSelect.innerHTML = '<option value="">Geen races</option>';
    raceSelect.disabled = true;
  } else {
    raceSelect.disabled = false;
    raceSelect.innerHTML = races
      .map((r) => `<option value="${r.raceKey.replace(/"/g, "&quot;")}">${r.eventName}</option>`)
      .join("");
    raceSelect.value = activeRace;
  }

  if (!classifications.length) {
    classSelect.innerHTML = '<option value="">Geen klasses</option>';
    classSelect.disabled = true;
    return;
  }
  classSelect.disabled = false;
  if (!classifications.some((c) => c.className === activeClass)) {
    activeClass = classifications[0].className;
    localStorage.setItem(ACTIVE_CLASS_KEY, activeClass);
  }
  classSelect.innerHTML = classifications
    .map((c) => `<option value="${c.className.replace(/"/g, "&quot;")}">${c.className}</option>`)
    .join("");
  classSelect.value = activeClass;
}

searchInput.addEventListener("input", () => renderSearchResults(computeClassifications(activeHeats())));

function setStatus(msg, kind) {
  parseStatus.textContent = msg;
  parseStatus.className = "status" + (kind ? ` ${kind}` : "");
}

// Merges a freshly parsed heat into `heats`. If a heat with the same id already
// exists (same race/class/heat), the one with the latest "Printed" stamp from
// the timing software wins - so an older revision uploaded after a newer one
// (or in a different order) never overwrites the newer result.
function mergeHeat(parsed) {
  const idx = heats.findIndex((h) => h.id === parsed.id);
  if (idx === -1) {
    heats.push(parsed);
    return "added";
  }
  const existing = heats[idx];
  if (existing.printedAt && parsed.printedAt && parsed.printedAt < existing.printedAt) {
    return "skipped-older-revision";
  }
  heats[idx] = parsed;
  return existing.printedAt && parsed.printedAt && parsed.printedAt > existing.printedAt
    ? "replaced-with-revision"
    : "replaced";
}

async function handleFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"));
  if (!files.length) {
    setStatus("Geen geldige PDF's geselecteerd.", "err");
    return;
  }
  setStatus(`Bezig met inlezen van ${files.length} bestand(en)...`);
  let heatCount = 0;
  let qualiCount = 0;
  let revisionCount = 0;
  let skippedCount = 0;
  let lastRaceKey = null;
  const errors = [];
  for (const file of files) {
    try {
      const { docType, record } = await parseUploadedFile(file);
      if (docType === "qualifying") {
        const outcome = mergeQualifying(record);
        if (outcome === "replaced-with-revision") revisionCount++;
        if (outcome === "skipped-older-revision") skippedCount++;
        qualiCount++;
      } else {
        const outcome = mergeHeat(record);
        if (outcome === "replaced-with-revision") revisionCount++;
        if (outcome === "skipped-older-revision") skippedCount++;
        lastRaceKey = record.raceKey;
        heatCount++;
      }
    } catch (e) {
      errors.push(`${file.name}: ${e.message}`);
    }
  }
  saveHeats(heats);
  saveQualifying(qualifying);
  if (lastRaceKey) {
    activeRace = lastRaceKey;
    saveActiveRace(activeRace);
  }
  render();
  const notes = [];
  if (revisionCount) notes.push(`${revisionCount} revisie(s) automatisch overgenomen`);
  if (skippedCount) notes.push(`${skippedCount} oudere revisie(s) genegeerd`);
  const noteText = notes.length ? ` (${notes.join(", ")})` : "";
  const parts = [];
  if (heatCount) parts.push(`${heatCount} heat(s)`);
  if (qualiCount) parts.push(`${qualiCount} qualifying`);
  const summary = parts.length ? parts.join(" en ") + " geladen" : "Niets geladen";
  if (errors.length) {
    setStatus(`${summary}${noteText}. Fout bij: ${errors.join(" | ")}`, "err");
  } else {
    setStatus(`${summary}${noteText}.`, "ok");
  }
}

dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", (e) => handleFiles(e.target.files));

["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  })
);
dropzone.addEventListener("drop", (e) => {
  if (e.dataTransfer.files && e.dataTransfer.files.length) {
    handleFiles(e.dataTransfer.files);
  }
});

resetBtn.addEventListener("click", () => {
  const current = activeHeats();
  const currentQuali = activeQualifying();
  if (!current.length && !currentQuali.length) return;
  const activeRaceInfo = getRaces().find((r) => r.raceKey === activeRace);
  const label = activeRaceInfo ? activeRaceInfo.label : "deze race";
  if (!confirm(`Alle heats en qualifying van ${label} wissen?`)) return;
  heats = heats.filter((h) => (h.raceKey || deriveRaceKey(h.eventName)) !== activeRace);
  qualifying = qualifying.filter((q) => (q.raceKey || deriveRaceKey(q.eventName)) !== activeRace);
  saveHeats(heats);
  saveQualifying(qualifying);
  render();
  setStatus(`Heats en qualifying van ${label} gewist.`, "ok");
});

function removeHeat(id) {
  heats = heats.filter((h) => h.id !== id);
  saveHeats(heats);
  render();
}

function renderHeatsList(heatsSubset, qualifyingSubset) {
  if (!heatsSubset.length && !qualifyingSubset.length) {
    heatsList.innerHTML = '<p class="empty-hint">Nog geen heats geladen voor deze race.</p>';
    return;
  }
  const sorted = [...heatsSubset].sort((a, b) => a.className.localeCompare(b.className) || a.heatLabel.localeCompare(b.heatLabel));
  heatsList.innerHTML = "";
  for (const h of sorted) {
    const row = document.createElement("div");
    row.className = "heat-row";
    row.innerHTML = `
      <div class="heat-info">
        <span class="heat-title">${h.className} — ${h.heatLabel}</span>
        <span class="heat-meta">${h.eventName || ""} · ${h.rows.length} rijders · ${h.fileName}</span>
      </div>
      <button class="btn-danger btn-small" type="button">Verwijderen</button>
    `;
    row.querySelector("button").addEventListener("click", () => {
      if (!confirm(`Heat "${h.className} — ${h.heatLabel}" verwijderen?`)) return;
      removeHeat(h.id);
    });
    heatsList.appendChild(row);
  }
  for (const q of qualifyingSubset) {
    const row = document.createElement("div");
    row.className = "heat-row quali-row";
    row.innerHTML = `
      <div class="heat-info">
        <span class="heat-title">🏁 Qualifying — ${q.className}</span>
        <span class="heat-meta">${q.eventName || ""} · ${q.entries.length} rijders · ${q.fileName}</span>
      </div>
      <button class="btn-danger btn-small" type="button">Verwijderen</button>
    `;
    row.querySelector("button").addEventListener("click", () => {
      if (!confirm(`Qualifying "${q.className}" verwijderen?`)) return;
      removeQualifying(q.id);
    });
    heatsList.appendChild(row);
  }
}

// Per driver: what do they still need in the remaining heats to end at or
// below the estimated A-final points cutoff? Heat points per finishing
// position are read from the uploaded heats themselves (in this data P1 isn't
// always 1 point), so this doesn't assume "points = position".
function attachAFinalNeeds(drivers, heatCols, totalHeats, cutoff) {
  // Uncertainty of the cutoff estimate shrinks as more of the round's heats
  // have been run (checked against a full real round: the estimate was off by
  // up to ~6 points halfway, ~2 near the end, exact once every heat was done).
  const groupCount = totalHeats + 1;
  const totalPairHeats = (groupCount * (groupCount - 1)) / 2;
  const remainingShare = Math.max(0, 1 - heatCols.length / totalPairHeats);
  const margin = remainingShare > 0 ? Math.ceil(1 + 5 * remainingShare) : 0;
  const pointsByRank = new Map();
  let worstPerHeat = 0;
  for (const h of heatCols) {
    for (const row of h.rows) {
      if (row.points === null || row.resultCode) continue;
      if (!pointsByRank.has(row.rank) || row.points > pointsByRank.get(row.rank)) pointsByRank.set(row.rank, row.points);
      if (row.points > worstPerHeat) worstPerHeat = row.points;
    }
  }
  if (!pointsByRank.size) return;
  const maxRank = Math.max(...pointsByRank.keys());
  const pointsFor = (rank) => (pointsByRank.has(rank) ? pointsByRank.get(rank) : rank);
  const bestPerHeat = Math.min(...pointsByRank.values());

  for (const d of drivers) {
    const remaining = totalHeats - d.heatsCount;
    const budget = cutoff - d.total;
    // The cutoff is only an estimate: treat "clearly in/out" as being at least
    // `margin` points away from it, everything closer stays undecided.
    if (remaining <= 0) {
      d.aNeed = {
        status: d.total <= cutoff - margin ? "in" : d.total > cutoff + margin ? "out-done" : "edge",
        remaining: 0,
        budget,
      };
    } else if (d.total + remaining * worstPerHeat <= cutoff - margin) {
      d.aNeed = { status: "safe", remaining, budget };
    } else if (d.total + remaining * bestPerHeat > cutoff + margin) {
      d.aNeed = { status: "out", remaining, budget };
    } else {
      const avgPoints = budget / remaining;
      let maxPos = 1;
      for (let q = 1; q <= maxRank; q++) if (pointsFor(q) <= avgPoints) maxPos = q;
      d.aNeed = { status: "need", remaining, budget, avgPoints, maxPos };
    }
  }
}

function aNeedCell(d) {
  const n = d.aNeed;
  if (!n) return `<td class="a-need">–</td>`;
  const tip = `Nog ${n.remaining} heat(s) · nu ${d.total} punten · grens ~${d.total + n.budget} → nog max ${Math.max(n.budget, 0)} punten te verdelen`;
  if (n.status === "edge") return `<td class="a-need a-edge" title="Alle heats gereden, maar te dicht bij de geschatte grens (~${d.total + n.budget}) om te zeggen — wacht op de andere rijders">≈ Op de grens</td>`;
  if (n.status === "in") return `<td class="a-need a-safe" title="Alle heats gereden, onder de geschatte grens">✓ A-finale</td>`;
  if (n.status === "out-done") return `<td class="a-need a-out" title="Alle heats gereden, boven de geschatte grens">✗ Niet gehaald</td>`;
  if (n.status === "safe") return `<td class="a-need a-safe" title="${tip} — ook met de slechtste uitslagen onder de grens">✓ Veilig</td>`;
  if (n.status === "out") return `<td class="a-need a-out" title="${tip} — zelfs met alleen winnen niet meer haalbaar">✗ Buiten bereik</td>`;
  const label = n.remaining === 1 ? `P${n.maxPos} of beter` : `gem. P${n.maxPos} of beter`;
  return `<td class="a-need a-required" title="${tip}">${label}${n.remaining > 1 ? ` <small>(${n.remaining} heats)</small>` : ""}</td>`;
}

function computeClassifications(heatsSubset) {
  const raceKey = heatsSubset.length ? heatsSubset[0].raceKey || deriveRaceKey(heatsSubset[0].eventName) : activeRace;

  const byClass = new Map();
  for (const h of heatsSubset) {
    if (!byClass.has(h.className)) byClass.set(h.className, []);
    byClass.get(h.className).push(h);
  }

  const classifications = [];
  for (const [className, classHeats] of [...byClass.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const heatCols = classHeats
      .slice()
      .sort((a, b) => a.heatLabel.localeCompare(b.heatLabel, undefined, { numeric: true }));

    const driverMap = new Map(); // fullName -> { fullName, perHeat: {id: points}, total, heatsCount }
    for (const h of heatCols) {
      for (const row of h.rows) {
        if (row.points === null) continue;
        if (!driverMap.has(row.fullName)) {
          driverMap.set(row.fullName, { fullName: row.fullName, car: row.car, perHeat: {}, total: 0, heatsCount: 0 });
        }
        const d = driverMap.get(row.fullName);
        d.perHeat[h.id] = { points: row.points, code: row.resultCode, heatPos: row.rank };
        d.total += row.points;
        d.heatsCount += 1;
        d.car = row.car;
      }
    }

    const qualiMap = getQualiPosMap(raceKey, className);
    const drivers = [...driverMap.values()]
      .sort((a, b) => {
        if (a.total !== b.total) return a.total - b.total;
        if (qualiMap) {
          const qa = qualiMap.get(a.fullName);
          const qb = qualiMap.get(b.fullName);
          if (qa !== undefined && qb !== undefined && qa !== qb) return qa - qb;
          if (qa !== undefined && qb === undefined) return -1;
          if (qb !== undefined && qa === undefined) return 1;
        }
        if (a.heatsCount !== b.heatsCount) return b.heatsCount - a.heatsCount;
        return a.fullName.localeCompare(b.fullName);
      })
      .map((d, idx) => ({
        ...d,
        pos: idx + 1,
        key: `${className}::${d.fullName}`,
        qualiPos: qualiMap ? qualiMap.get(d.fullName) : undefined,
      }));

    const totalHeats = getTotalHeatsForClass(raceKey, className);
    let projectedACutoff = null;
    let projectedBCutoff = null;
    let projectedSampleSize = 0;
    if (totalHeats) {
      const projected = drivers
        .filter((d) => d.heatsCount > 0)
        .map((d) => Math.round((d.total / d.heatsCount) * totalHeats))
        .sort((a, b) => a - b);
      projectedSampleSize = projected.length;
      // Early in the round only some groups have raced, so `projected` holds
      // just part of the field. The cutoff is "the Nth best of the WHOLE field",
      // so take the same share of the sample (e.g. 36/63 of 42 drivers) instead
      // of the raw 36th - otherwise the estimate comes out far too high.
      const fieldSize = Math.max(drivers.length, qualiMap ? qualiMap.size : 0);
      const share = (cutoff) => Math.max(1, Math.round((cutoff * projected.length) / fieldSize));
      if (projected.length >= A_FINAL_CUTOFF) projectedACutoff = projected[share(A_FINAL_CUTOFF) - 1];
      if (projected.length >= B_FINAL_CUTOFF) projectedBCutoff = projected[share(B_FINAL_CUTOFF) - 1];
    }
    if (totalHeats && projectedACutoff !== null) {
      attachAFinalNeeds(drivers, heatCols, totalHeats, projectedACutoff);
    }

    classifications.push({
      className,
      heatCols,
      drivers,
      hasQualifying: !!qualiMap,
      totalHeats,
      projectedACutoff,
      projectedBCutoff,
      projectedSampleSize,
    });
  }

  // A class with qualifying uploaded but no heats yet doesn't show up above at
  // all (byClass is built from heats). Show a preliminary list based on
  // qualifying order instead, so there's something to see right away.
  for (const qRecord of qualifying.filter((q) => (q.raceKey || deriveRaceKey(q.eventName)) === raceKey)) {
    if ([...byClass.keys()].some((name) => classesMatch(name, qRecord.className))) continue;
    const drivers = [...qRecord.entries]
      .sort((a, b) => a.pos - b.pos)
      .map((e) => ({
        fullName: e.fullName,
        car: e.car,
        perHeat: {},
        total: null,
        heatsCount: 0,
        pos: e.pos,
        key: `${qRecord.className}::${e.fullName}`,
        qualiPos: e.pos,
      }));
    classifications.push({
      className: qRecord.className,
      heatCols: [],
      drivers,
      hasQualifying: true,
      qualiOnly: true,
      totalHeats: getTotalHeatsForClass(raceKey, qRecord.className),
      projectedACutoff: null,
      projectedBCutoff: null,
      projectedSampleSize: 0,
    });
  }

  classifications.sort((a, b) => a.className.localeCompare(b.className));
  return classifications;
}

function renderClassifications(classifications) {
  classificationsContainer.innerHTML = "";
  if (!classifications.length) return;

  {
    const selected = classifications.find((c) => c.className === activeClass) || classifications[0];
    const { className, heatCols, drivers, hasQualifying, qualiOnly, totalHeats, projectedACutoff, projectedBCutoff, projectedSampleSize } = selected;
    // GK4 doesn't work with qualifying groups or an A/B-final split at all -
    // none of that is relevant there, so hide it entirely for GK4 races. A
    // qualifying-only preliminary list (no heats raced yet) doesn't have a
    // real A/B-final split either, since it's not based on points.
    const isGK4Race = activeRace && activeRace.startsWith("gk4-round-");
    const suppressFinals = isGK4Race || qualiOnly;
    const showHeatsUI = showHeatColumns && heatCols.length > 0;
    const block = document.createElement("section");
    block.className = "panel class-block";
    const aNeedAvailable = !suppressFinals && projectedACutoff !== null;
    const showANeed = aNeedAvailable && showANeedPref;
    const colCount = 4 + (showHeatsUI ? 1 : 0) + (showANeed ? 1 : 0); // Pos, Rijder, [Resultaten], Totaal, Heats, [A-finale]
    const resultsHeaderCell = showHeatsUI ? `<th>Resultaten per heat</th>` : "";
    const rowsHtml = drivers.map((d) => {
      const resultsCell = showHeatsUI
        ? `<td class="results-cell"><div class="results-wrap">${heatCols
            .filter((h) => d.perHeat[h.id])
            .map((h) => {
              const entry = d.perHeat[h.id];
              const heatNum = (h.heatLabel.match(/(\d+)/) || [, h.heatLabel])[1];
              const codeTag = entry.code ? ` <span class="result-code">${entry.code}</span>` : "";
              return `<span class="result-chip" data-heat-id="${h.id.replace(/"/g, "&quot;")}" title="Bekijk volledige uitslag van ${h.heatLabel}">H${heatNum} - P${entry.heatPos}${codeTag}</span>`;
            })
            .join("")}</div></td>`
        : "";
      const isHighlighted = highlights.has(d.key);
      const qualifiesA = !suppressFinals && drivers.length > A_FINAL_CUTOFF && d.pos <= A_FINAL_CUTOFF;
      const qualifiesB = !suppressFinals && drivers.length > A_FINAL_CUTOFF && d.pos > A_FINAL_CUTOFF && d.pos <= B_FINAL_CUTOFF;
      const posTitleParts = [];
      if (qualifiesA) posTitleParts.push("Kwalificeert voor de A-finale");
      if (qualifiesB) posTitleParts.push("Kwalificeert voor de B-finale");
      if (d.qualiPos !== undefined) posTitleParts.push(`Qualifying P${d.qualiPos}`);
      let html = `<tr class="${isHighlighted ? "highlighted" : ""} ${qualifiesA ? "qualifies-a" : ""} ${qualifiesB ? "qualifies-b" : ""}" data-key="${d.key.replace(/"/g, "&quot;")}">
          <td class="pos ${d.pos === 1 ? "pos-first" : ""}" title="${posTitleParts.join(" · ")}">${d.pos}</td>
          <td class="name-cell">
            <button type="button" class="star-btn ${isHighlighted ? "starred" : ""}" title="Highlight rijder" aria-label="Highlight ${d.fullName}">${isHighlighted ? "★" : "☆"}</button>
            ${d.fullName} <span class="car-number">#${d.car}</span>
          </td>
          ${resultsCell}
          <td class="num total">${d.total !== null ? d.total : "–"}</td>
          <td class="num">${d.heatsCount}</td>
          ${showANeed ? aNeedCell(d) : ""}
        </tr>`;
      if (!suppressFinals && d.pos === A_FINAL_CUTOFF && drivers.length > A_FINAL_CUTOFF) {
        html += `<tr class="cutoff-row"><td colspan="${colCount}">A-finale grens — top ${A_FINAL_CUTOFF}</td></tr>`;
      }
      if (!suppressFinals && d.pos === B_FINAL_CUTOFF && drivers.length > B_FINAL_CUTOFF) {
        html += `<tr class="cutoff-row cutoff-row-b"><td colspan="${colCount}">B-finale grens — P${A_FINAL_CUTOFF + 1} t/m ${B_FINAL_CUTOFF}</td></tr>`;
      }
      return html;
    });
    const bodyRows = rowsHtml.join("");
    // Heats are rotating group-pairs (e.g. "Heat 1 E-F", "Heat 2 C-D") - a driver
    // only appears in the heat numbers matching their own group, so comparing
    // against the total number of uploaded heat files is wrong. What matters is
    // whether drivers have raced a different number of heats *from each other*.
    const unevenHeats = new Set(drivers.map((d) => d.heatsCount)).size > 1;

    const isCollapsed = collapsedClasses.has(className);
    block.innerHTML = `
      <div class="panel-header">
        <button type="button" class="panel-toggle class-toggle" aria-expanded="${!isCollapsed}">
          <span class="chevron">${isCollapsed ? "▸" : "▾"}</span> <h2 style="display:inline">${className}</h2>
        </button>
      </div>
      <div class="class-collapsible ${isCollapsed ? "collapsed" : ""}">
        <p class="class-meta">${
          qualiOnly
            ? `Voorlopige volgorde op basis van de qualifying — er zijn nog geen heats geüpload voor deze klasse.`
            : `Klassement over ${heatCols.length} heat(s) — punten opgeteld, laagste totaal bovenaan. Klik de ster om een rijder te highlighten.${hasQualifying ? " Bij gelijke punten beslist de qualifying (snelste tijd wint)." : ""}`
        }</p>
        ${unevenHeats ? '<p class="class-warning">⚠ Niet alle rijders hebben evenveel heats gereden — dit klassement is nog niet volledig.</p>' : ""}
        ${
          suppressFinals
            ? ""
            : `<p class="class-projection">${
                totalHeats
                  ? projectedACutoff !== null
                    ? `📊 Geschatte grens A-finale: <strong>~${projectedACutoff} punten</strong>${
                        projectedBCutoff !== null ? ` · B-finale: <strong>~${projectedBCutoff} punten</strong>` : ""
                      } — schatting o.b.v. gemiddelde punten per heat (${totalHeats} heats totaal per rijder, ${projectedSampleSize} rijders met data), kan nog wijzigen.`
                    : `📊 A/B-finale grens: nog geen schatting mogelijk — pas vanaf ${A_FINAL_CUTOFF} rijders met minstens 1 heat gereden (nu ${projectedSampleSize}).`
                  : hasQualifying
                    ? `📊 A/B-finale grens: kon het aantal groepen niet bepalen uit de geüploade qualifying-PDF.`
                    : `📊 A/B-finale grens: upload de "Total Qualifying Practice" PDF van deze klasse om een schatting te zien.`
              }</p>`
        }
        <div class="toggles-row">
          ${
            heatCols.length > 0
              ? `<label class="show-heats-toggle">
                  <input type="checkbox" class="show-heats-checkbox" ${showHeatColumns ? "checked" : ""} />
                  Toon resultaten per heat
                </label>`
              : ""
          }
          ${
            aNeedAvailable
              ? `<label class="show-heats-toggle">
                  <input type="checkbox" class="show-aneed-checkbox" ${showANeedPref ? "checked" : ""} />
                  Toon "Nodig voor A"
                </label>`
              : ""
          }
        </div>
        <div style="overflow-x:auto;">
          <table class="classification">
            <thead>
              <tr>
                <th>Pos</th>
                <th>Rijder</th>
                ${resultsHeaderCell}
                <th class="num">Totaal</th>
                <th class="num">Heats</th>
                ${showANeed ? '<th title="Wat je in de resterende heats nog nodig hebt voor de A-finale, o.b.v. de geschatte grens">Nodig voor A</th>' : ""}
              </tr>
            </thead>
            <tbody>${bodyRows}</tbody>
          </table>
        </div>
      </div>
    `;
    block.querySelector(".class-toggle").addEventListener("click", () => toggleClassCollapsed(className));
    block.querySelector(".show-heats-checkbox")?.addEventListener("change", (e) => {
      showHeatColumns = e.target.checked;
      localStorage.setItem(SHOW_HEATS_KEY, String(showHeatColumns));
      render();
    });
    block.querySelector(".show-aneed-checkbox")?.addEventListener("change", (e) => {
      showANeedPref = e.target.checked;
      localStorage.setItem(SHOW_ANEED_KEY, String(showANeedPref));
      render();
    });
    block.querySelectorAll(".star-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        toggleHighlight(btn.closest("tr").dataset.key);
      });
    });
    block.querySelectorAll(".result-chip").forEach((chip) => {
      chip.addEventListener("click", () => showHeatModal(chip.dataset.heatId));
    });
    classificationsContainer.appendChild(block);
  }
}

function renderSearchResults(classifications) {
  const query = searchInput.value.trim().toLowerCase();
  if (!query) {
    searchResults.innerHTML = "";
    return;
  }

  const matches = [];
  for (const { className, drivers } of classifications) {
    for (const d of drivers) {
      if (d.fullName.toLowerCase().includes(query)) {
        matches.push({ ...d, className });
      }
    }
  }

  if (!matches.length) {
    searchResults.innerHTML = '<p class="empty-hint">Geen rijder gevonden.</p>';
    return;
  }

  searchResults.innerHTML = "";
  for (const m of matches) {
    const isHighlighted = highlights.has(m.key);
    const row = document.createElement("div");
    row.className = "search-result-row";
    row.innerHTML = `
      <div class="sr-info">
        <span class="sr-name">${m.fullName}</span>
        <span class="sr-meta">${m.className} · P${m.pos} · ${m.total} punten</span>
      </div>
      <button type="button" class="star-btn ${isHighlighted ? "starred" : ""}" title="Highlight rijder" aria-label="Highlight ${m.fullName}">${isHighlighted ? "★" : "☆"}</button>
    `;
    row.querySelector(".star-btn").addEventListener("click", () => toggleHighlight(m.key));
    searchResults.appendChild(row);
  }
}

function renderHighlighted(classifications) {
  const selected = classifications.find((c) => c.className === activeClass);
  const followed = [];
  if (selected) {
    for (const d of selected.drivers) {
      if (highlights.has(d.key)) followed.push({ ...d, classDriverCount: selected.drivers.length });
    }
  }

  if (!followed.length) {
    highlightedContainer.innerHTML = '<p class="empty-hint">Nog geen rijders gehighlight in deze klasse. Klik op een ster om een rijder te volgen.</p>';
    return;
  }

  followed.sort((a, b) => a.pos - b.pos);
  const showANeed = showANeedPref && followed.some((d) => d.aNeed);

  const bodyRows = followed
    .map((d) => {
      const isGK4Race = activeRace && activeRace.startsWith("gk4-round-");
      const qualifiesA = !isGK4Race && d.classDriverCount > A_FINAL_CUTOFF && d.pos <= A_FINAL_CUTOFF;
      const qualifiesB = !isGK4Race && d.classDriverCount > A_FINAL_CUTOFF && d.pos > A_FINAL_CUTOFF && d.pos <= B_FINAL_CUTOFF;
      return `<tr class="${qualifiesA ? "qualifies-a" : ""} ${qualifiesB ? "qualifies-b" : ""}">
        <td class="name-cell">
          <button type="button" class="star-btn starred" title="Highlight verwijderen" aria-label="Highlight ${d.fullName} verwijderen">★</button>
          ${d.fullName} <span class="car-number">#${d.car}</span>
        </td>
        <td class="num pos ${d.pos === 1 ? "pos-first" : ""}" title="${qualifiesA ? "Kwalificeert voor de A-finale" : qualifiesB ? "Kwalificeert voor de B-finale" : ""}">${d.pos}</td>
        <td class="num total">${d.total}</td>
        <td class="num">${d.heatsCount}</td>
        ${showANeed ? aNeedCell(d) : ""}
      </tr>`;
    })
    .join("");

  highlightedContainer.innerHTML = `
    <div style="overflow-x:auto;">
      <table class="classification">
        <thead>
          <tr>
            <th>Rijder</th>
            <th class="num">Positie</th>
            <th class="num">Punten</th>
            <th class="num">Heats</th>
            ${showANeed ? '<th title="Wat je in de resterende heats nog nodig hebt voor de A-finale, o.b.v. de geschatte grens">Nodig voor A</th>' : ""}
          </tr>
        </thead>
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
  `;
  followed.forEach((d, i) => {
    highlightedContainer.querySelectorAll(".star-btn")[i].addEventListener("click", () => toggleHighlight(d.key));
  });
}

function render() {
  const races = getRaces();
  if (!races.some((r) => r.raceKey === activeRace)) {
    activeRace = races.length ? races[races.length - 1].raceKey : null;
    saveActiveRace(activeRace);
  }

  const currentHeats = activeHeats();
  const classifications = computeClassifications(currentHeats);
  renderSelectors(races, classifications);
  renderHeatsList(currentHeats, activeQualifying());
  renderHighlighted(classifications);
  renderClassifications(classifications);
  renderSearchResults(classifications);
}

render();
