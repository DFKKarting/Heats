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
const B_FINAL_MIN_DRIVERS = 8; // a B-final is only actually run with at least this many drivers in it

// A distinct color per sub-class (e.g. KA100's 140/155, X30 Master-SC's M/SC)
// so it's visually obvious at a glance which sub-class a driver is in.
// Medium-saturation tones (not the very light pastels a dark-only palette
// would use) so the badge text stays legible on both the dark and light theme.
const SUBCLASS_PALETTE = [
  { color: "#2f8fd8", bg: "rgba(47, 143, 216, 0.15)", border: "rgba(47, 143, 216, 0.4)" },
  { color: "#9b6fd1", bg: "rgba(155, 111, 209, 0.15)", border: "rgba(155, 111, 209, 0.4)" },
  { color: "#1fae9f", bg: "rgba(31, 174, 159, 0.15)", border: "rgba(31, 174, 159, 0.4)" },
  { color: "#d1802e", bg: "rgba(209, 128, 46, 0.15)", border: "rgba(209, 128, 46, 0.4)" },
  { color: "#c25a9e", bg: "rgba(194, 90, 158, 0.15)", border: "rgba(194, 90, 158, 0.4)" },
];
function subClassStyle(subClass, subClassOrder) {
  const idx = Math.max(0, subClassOrder.indexOf(subClass));
  const c = SUBCLASS_PALETTE[idx % SUBCLASS_PALETTE.length];
  return `color:${c.color};background:${c.bg};border-color:${c.border};`;
}

// Whether a field of this size gets a B-final at all: only the drivers beyond
// the A-final cutoff (up to the B-final cap) would race it, and with too few
// of them there's no separate B-final race.
function hasBFinal(fieldSize) {
  const inBRange = Math.max(0, Math.min(fieldSize, B_FINAL_CUTOFF) - A_FINAL_CUTOFF);
  return inBRange >= B_FINAL_MIN_DRIVERS;
}

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

// IAME international events (e.g. the IAME Finals, "IWF26") are timed by Apex
// Timing - a completely different template again: one-line "LASTNAME
// Firstname" driver column, and points awarded the other way round (the
// winner gets the MOST points, 50-44-41-...), so the standings sort highest
// total first instead of lowest. Column positions differ between its sheets
// (heat results, grouped and single-series qualifying, ...), so they're read
// from the header row instead of hardcoded - see apexColumns().

// raceKey is stored on each record so it stays stable across reloads, but
// deriveRaceKey() has changed shape a few times as more championships were
// added (e.g. an old "round-4" from before races became series-aware). A
// record saved under an older version keeps its stale key forever otherwise,
// silently splitting one real race into two. Re-derive it from the record's
// own eventName on every load so previously-saved data heals itself instead
// of needing a re-upload.
function migrateRaceKey(record, idParts) {
  const freshKey = deriveRaceKey(record.eventName);
  if (record.raceKey !== freshKey) {
    record.raceKey = freshKey;
    record.id = idParts(freshKey).join("::");
  }
  return record;
}

function loadHeats() {
  try {
    const heats = JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    return heats.map((h) => migrateRaceKey(h, (key) => [key, h.className, h.heatLabel]));
  } catch {
    return [];
  }
}

function saveHeats(heats) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(heats));
}

function loadQualifying() {
  try {
    const qualifying = JSON.parse(localStorage.getItem(QUALIFYING_KEY)) || [];
    return qualifying.map((q) => migrateRaceKey(q, (key) => [key, q.className]));
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

// The round number embedded in an event title (e.g. "... Round 6 ..." -> 6),
// or null for a title without one.
function deriveRoundNumber(eventName) {
  const m = eventName && eventName.match(/\bRound\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// A normalized, stopword-stripped key for the championship a title belongs
// to (e.g. "IAME Series Benelux Round 4" and "IAME Benelux Round 4 Genk" both
// give "benelux", while "GK4 Kart Series Round 4" gives "gk4" - so the two
// don't collide just because they share a round number). Used both to keep
// raceKey series-aware and to group races by championship in the UI.
const SERIES_STOPWORDS = new Set(["series", "iame", "kart", "karting"]);
function deriveSeriesKey(eventName) {
  if (!eventName) return "unknown-series";
  const raw = deriveSeriesLabel(eventName);
  const words = raw
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w && !SERIES_STOPWORDS.has(w))
    .sort();
  return words.join("-") || "series";
}

// A human-readable championship name - the part of the title before "Round
// N", e.g. "IAME Series Benelux" or "GK4 Kart Series". Different documents
// for the same championship can word this slightly differently; the UI picks
// the longest variant seen as the display label (see getChampionships()).
function deriveSeriesLabel(eventName) {
  if (!eventName) return "Onbekend kampioenschap";
  const m = eventName.match(/^(.*?)\s+Round\s+\d+/i);
  return (m ? m[1] : eventName).trim();
}

// The track/circuit name, when the title has one trailing "Round N" (e.g.
// "IAME Series Benelux Round 6 Mariembourg" -> "Mariembourg"). The
// championship itself is already shown by its own picker, so the round
// picker doesn't need to repeat it too.
function deriveTrackLabel(eventName) {
  if (!eventName) return "";
  const m = eventName.match(/\bRound\s+\d+\s+(.*)$/i);
  return m ? m[1].trim() : "";
}

// Different documents for the same physical event sometimes title themselves
// slightly differently (e.g. "IAME Benelux Round 1" vs "IAME Series Benelux
// Round 1 Mariembourg"). Group races by round number instead of exact string
// match so they don't fragment into duplicate tabs.
function deriveRaceKey(eventName) {
  if (!eventName) return "unknown-race";
  const roundNumber = deriveRoundNumber(eventName);
  if (roundNumber === null) return eventName.trim().toLowerCase();
  // Different championships can both use "Round N" numbering (e.g. IAME
  // Benelux Round 4 vs GK4 Kart Series Round 4) - fold in a normalized series
  // name (stripped of generic/variable words) so they don't collide, while
  // still unifying slightly differently worded titles for the same series
  // (e.g. "IAME Benelux" vs "IAME Series Benelux ... Genk").
  return `${deriveSeriesKey(eventName)}-round-${roundNumber}`;
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

// The last-name line can carry trailing markers in parentheses, e.g.
// "CUMBO (140) (L)" or "BULT (SC)": "(L)"/"(R)" are lady/rookie flags with no
// effect on classification, but the same spot is also used for a genuine
// sub-class split within the class - KA100's "(140)"/"(155)" weight brackets,
// or "X30 Master-SC"'s "(M)"/"(SC)" sub-categories. Anything other than the
// known rider flags is treated as a sub-class marker.
const NAME_MARKER_FLAGS = new Set(["R", "L"]); // rookie / lady - not a sub-class
function stripNameMarkers(rawLastName) {
  let name = rawLastName;
  let subClass = null;
  let m;
  while ((m = name.match(/\s*\(([A-Za-z0-9]+)\)\s*$/))) {
    if (!NAME_MARKER_FLAGS.has(m[1].toUpperCase())) subClass = m[1];
    name = name.slice(0, m.index).trim();
  }
  return { name, subClass };
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

// "Practice" session sheets (unscored: qualifying/free practice) prepend a
// couple of metadata lines - "Track: ..." and "Session Started: ..." - above
// the actual event/class title block. Heat and "Total Qualifying" sheets
// don't have these, so title parsing there assumes line 0 is the event name
// and line 1 the class - which breaks on a practice sheet unless these lines
// are filtered out first.
function skipMetaLines(lines) {
  return lines.filter((l) => !/^(Track|Session Started)\s*:/i.test(l.text.trim()));
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
  const lines = skipMetaLines(clusterByY(above, 3).sort((a, b) => a.y - b.y));
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
    const { name: lastNameClean, subClass } = stripNameMarkers(lastName);
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
      subClass,
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
  const lines = skipMetaLines(clusterByY(above, 3).sort((a, b) => a.y - b.y));
  const eventName = lines[0] ? lines[0].text.trim() : "";
  const className = lines[1] ? lines[1].text.trim() : "Onbekende klasse";
  const heatLabel = lines[2] ? lines[2].text.trim() : "Heat";
  return { eventName, className, heatLabel, revision: null };
}

function isApexTimingDoc(items) {
  return items.some((it) => /Apex Timing/i.test(it.text));
}

// Column x-ranges keyed by the header label's first word, lowercased and
// without a trailing dot ("rnk", "no", "driver", "points", "group", ...). A
// value sits roughly under its header label - a little to its left when
// right-aligned - and never reaches the next label.
function apexColumns(items) {
  const rnk = items.find((it) => /^Rnk$/i.test(it.text.trim()));
  if (!rnk) return null;
  const header = items.filter((it) => Math.abs(it.y - rnk.y) < 3).sort((a, b) => a.x - b.x);
  const cols = {};
  header.forEach((h, i) => {
    const key = h.text.trim().split(/\s+/)[0].toLowerCase().replace(/\.$/, "");
    const next = header[i + 1];
    if (!cols[key]) cols[key] = [h.x - 6, next ? next.x - 2 : Infinity];
  });
  // Ranks are right-aligned (two digits start further left than the label),
  // and the heat sheet has an unlabeled column of small numbers just right of
  // Rnk - keep the rank range tight on that side so those aren't taken for ranks.
  cols.rnk = [rnk.x - 12, Math.min(cols.rnk[1], rnk.x + 15)];
  return cols.no && cols.driver ? { headerY: rnk.y, cols } : null;
}

// A results sheet (as opposed to the lap chart / analysis / starting grid /
// stewards' documents bundled into the same Apex Timing download) is titled
// "Results" and has the Rnk / No. / Driver header row. With a Points column
// it's a heat, without one a qualifying.
function apexSheetType(items) {
  if (!items.some((it) => it.text.trim() === "Results" && it.y < 130)) return null;
  const layout = apexColumns(items);
  if (!layout) return null;
  return layout.cols.points ? "heat" : "qualifying";
}

// "WIBOWO Muhammad" / "SØRLIE SMISTAD Ole Alexander": the all-caps words are
// the last name, the rest the first name(s).
function splitApexName(raw) {
  const words = raw.split(/\s+/).filter(Boolean);
  const isUpper = (w) => /\p{L}/u.test(w) && w === w.toUpperCase();
  const lastName = words.filter(isUpper).join(" ");
  const firstName = words.filter((w) => !isUpper(w)).join(" ");
  return { firstName, lastName, fullName: `${firstName} ${lastName}`.trim() };
}

// Classified drivers have a rank; DSQ/DNS/DNF drivers are listed after them
// under "Not classified" (often on the next page) with no rank, just a code
// in the Gap column and sometimes negative points - so rows are anchored on
// the car number, not the rank, or those drivers would silently disappear.
function parseRowsApex(items) {
  const { headerY, cols } = apexColumns(items);
  const carAnchors = items
    .filter((it) => it.y > headerY + 5 && within(it.x, cols.no) && /^[0-9]+$/.test(it.text))
    .sort((a, b) => a.y - b.y);

  const anchors = [];
  for (const a of carAnchors) {
    if (anchors.length && Math.abs(anchors[anchors.length - 1].y - a.y) < 3) continue;
    anchors.push(a);
  }

  const rows = [];
  for (let i = 0; i < anchors.length; i++) {
    const y0 = anchors[i].y;
    const y1 = i + 1 < anchors.length ? anchors[i + 1].y : y0 + 14;
    const band = items.filter((it) => it.y >= y0 - 5 && it.y < y1 - 5);

    const rawName = band
      .filter((it) => within(it.x, cols.driver))
      .sort((a, b) => a.x - b.x)
      .map((it) => it.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!rawName) continue;
    const { firstName, lastName, fullName } = splitApexName(rawName);

    const rankItem = band.find((it) => within(it.x, cols.rnk) && /^[0-9]+$/.test(it.text));
    const codeItem = band.find((it) => /^(DSQ|DQ|DNF|DNS|EXC|NC)$/i.test(it.text.trim()));
    const pointsItem = band.find((it) => within(it.x, cols.points) && /^-?[0-9]+$/.test(it.text.trim()));
    const resultCode = rankItem ? null : codeItem ? codeItem.text.trim().toUpperCase() : "NC";
    // A non-finisher without a printed points value gets its points filled in
    // per the regulations afterwards (see fillMissingApexPoints).
    const points = pointsItem ? parseInt(pointsItem.text, 10) : null;

    rows.push({
      car: anchors[i].text,
      firstName,
      lastName,
      fullName,
      points,
      resultCode,
    });
  }
  return rows;
}

// Title block: heat ("Qualifying Heat E-F") and class ("X30 MINI") at the top,
// event code + date range ("IWF26 (ITA)  20-24/10/2026") in the footer.
function parseTitleBlockApex(items) {
  const header = items.find((it) => /^Rnk\b/.test(it.text));
  const headerY = header ? header.y : 140;
  const top = clusterByY(
    items.filter((it) => it.x < 300 && it.y < headerY - 3),
    3
  ).filter((l) => !/^Results$/i.test(l.text));
  const heatLabel = top[0] ? top[0].text : "Heat";
  const className = top[1] ? top[1].text : "Onbekende klasse";

  const footer = items.find((it) => /\d{1,2}-\d{1,2}\/\d{1,2}\/\d{4}\s*$/.test(it.text));
  const eventCode = footer ? footer.text.replace(/\s+\d{1,2}-\d{1,2}\/\d{1,2}\/\d{4}\s*$/, "").trim() : "";
  const year = footer ? footer.text.match(/(\d{4})\s*$/)[1] : null;
  const eventName = `IAME Finals${eventCode ? ` ${eventCode}` : ""}`;

  // There's no "Printed:" stamp - use the session start date with the latest
  // posting time instead, so a re-posted (revised) result still sorts newer.
  let printedAt = null;
  const start = items.map((it) => it.text.match(/Start(?: Time)?\s*:\s*(\d{2})\/(\d{2})\s*-\s*(\d{2}):(\d{2})/)).find(Boolean);
  if (start && year) {
    const [, dd, mm, hh, min] = start;
    const postingLabel = items.find((it) => /^Posting Time/i.test(it.text));
    const postingTimes = postingLabel
      ? items
          .filter((it) => Math.abs(it.y - postingLabel.y) < 10 && it.x > postingLabel.x)
          .map((it) => it.text.match(/(\d{2}):(\d{2})\s*$/))
          .filter(Boolean)
          .map((m) => `${m[1]}:${m[2]}`)
          .sort()
      : [];
    const time = postingTimes.length ? postingTimes[postingTimes.length - 1] : `${hh}:${min}`;
    printedAt = `${year}-${mm}-${dd}T${time}:00`;
  }
  return { eventName, className, heatLabel, printedAt };
}

// The sheet normally prints a non-finisher's points itself (often negative),
// but not always. Fill the gap with the regulations' rule: the last
// classified driver's points minus 5 for a DSQ/black flag, minus 1 for a
// non-starter - so the heat still counts for that driver.
function fillMissingApexPoints(rows) {
  const classified = rows.filter((r) => !r.resultCode && r.points !== null);
  if (!classified.length) return;
  const lastPoints = Math.min(...classified.map((r) => r.points));
  for (const r of rows) {
    if (r.points !== null || !r.resultCode) continue;
    r.points = /^(DSQ|DQ|EXC)$/.test(r.resultCode) ? lastPoints - 5 : lastPoints - 1;
    r.pointsEstimated = true;
  }
}

async function buildApexHeatRecord(file, pdf, items1) {
  if (apexSheetType(items1) !== "heat") {
    throw new Error("Geen resultatenpagina gevonden in dit Apex Timing PDF.");
  }
  // A big field can spill over onto the next page(s); the download then
  // continues with lap chart / analysis pages, which aren't results.
  const rows = parseRowsApex(items1);
  for (let p = 2; p <= pdf.numPages; p++) {
    const items = await extractPageItems(await pdf.getPage(p));
    if (apexSheetType(items) !== "heat") break;
    rows.push(...parseRowsApex(items));
  }
  if (!rows.length) {
    throw new Error("Kon geen resultatentabel herkennen in dit PDF.");
  }
  rows.forEach((r, idx) => (r.rank = idx + 1));
  fillMissingApexPoints(rows);

  const { eventName, className, heatLabel, printedAt } = parseTitleBlockApex(items1);
  const raceKey = deriveRaceKey(eventName);
  return {
    id: `${raceKey}::${className}::${heatLabel}`,
    className,
    heatLabel,
    eventName,
    raceKey,
    revision: null,
    fileName: file.name,
    uploadedAt: new Date().toISOString(),
    printedAt,
    scoring: "high",
    rows,
  };
}

// Drivers without a time are listed unranked under "Not classified", so rows
// are anchored on the car number instead of the rank. Grouped qualifying has a
// Group column (A, B, ...); a single-series one doesn't.
function parseQualifyingRowsApex(items) {
  const { headerY, cols } = apexColumns(items);
  const carAnchors = items
    .filter((it) => it.y > headerY + 5 && within(it.x, cols.no) && /^[0-9]+$/.test(it.text))
    .sort((a, b) => a.y - b.y);

  const rows = [];
  for (const anchor of carAnchors) {
    const line = items.filter((it) => Math.abs(it.y - anchor.y) < 3);
    const rawName = line
      .filter((it) => within(it.x, cols.driver))
      .sort((a, b) => a.x - b.x)
      .map((it) => it.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!rawName) continue;
    const posItem = line.find((it) => within(it.x, cols.rnk) && /^[0-9]+$/.test(it.text));
    const groupItem = cols.group && line.find((it) => within(it.x, cols.group) && /^[A-Z]$/.test(it.text.trim()));
    rows.push({
      ...splitApexName(rawName),
      car: anchor.text,
      rank: posItem ? parseInt(posItem.text, 10) : null,
      group: groupItem ? groupItem.text.trim() : null,
    });
  }
  return rows;
}

async function buildApexQualifyingRecord(file, pdf, items1) {
  const rows = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const items = p === 1 ? items1 : await extractPageItems(await pdf.getPage(p));
    if (apexSheetType(items) !== "qualifying") break;
    rows.push(...parseQualifyingRowsApex(items));
  }
  if (!rows.length) {
    throw new Error("Kon geen qualifying-tabel herkennen in dit PDF.");
  }
  // Ranked drivers in rank order, then the unranked "Not classified" ones.
  const ranked = rows.filter((r) => r.rank !== null).sort((a, b) => a.rank - b.rank);
  const unranked = rows.filter((r) => r.rank === null);
  const entries = [...ranked, ...unranked].map(({ rank, ...r }, idx) => ({ ...r, pos: idx + 1 }));

  const { eventName, className, printedAt } = parseTitleBlockApex(items1);
  const raceKey = deriveRaceKey(eventName);
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
    const { name: lastNameClean, subClass } = stripNameMarkers(lastName);
    const fullName = `${firstName} ${lastNameClean}`.replace(/\s+/g, " ").trim();
    if (!fullName) continue;

    const bestTimeItem = band.find((it) => within(it.x, cols.BESTTIME) && /^\d{1,2}:?\d{2}\.\d{3}$/.test(it.text));
    const groupItem = cols.GROUP ? band.find((it) => within(it.x, cols.GROUP) && /^[A-Z]$/.test(it.text)) : null;

    rows.push({
      car: carItem ? carItem.text : "",
      fullName,
      bestTime: bestTimeItem ? bestTimeItem.text : null,
      group: groupItem ? groupItem.text : null,
      subClass,
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
    const { name: lastNameClean, subClass } = stripNameMarkers(lastNameRaw);
    const fullName = `${firstName} ${lastNameClean}`.replace(/\s+/g, " ").trim();
    if (!fullName) continue;

    const bestTimeItem = band.find((it) => within(it.x, QCOL_FASTSLOW.BESTTIME) && /^\d{1,2}[.,]\d{3}$/.test(it.text));
    const groupItem = band.find((it) => within(it.x, QCOL_FASTSLOW.GROUP) && /^[A-Z]$/.test(it.text));

    rows.push({
      car: carItem ? carItem.text : "",
      fullName,
      bestTime: bestTimeItem ? bestTimeItem.text.replace(",", ".") : null,
      group: groupItem ? groupItem.text : null,
      subClass,
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
  const lines = skipMetaLines(clusterByY(above, 3).sort((a, b) => a.y - b.y));
  return lines[1] ? lines[1].text.trim() : "Onbekende klasse";
}

function parseQualifyingClassName(items, tableTopY, knownClassNames, variant) {
  const above = items.filter((it) => it.x < 300 && it.y < tableTopY - 8);
  const lines = skipMetaLines(clusterByY(above, 3).sort((a, b) => a.y - b.y));
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
  const lines = skipMetaLines(clusterByY(page1Items, 3).sort((a, b) => a.y - b.y));
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
  // Release each document once parsed - the automatic import can go through
  // hundreds of PDFs in one go, and kept-open documents crash the tab.
  try {
    return await parseOpenedPdf(file, pdf);
  } finally {
    pdf.destroy();
  }
}

async function parseOpenedPdf(file, pdf) {
  const page1 = await pdf.getPage(1);
  const items1 = await extractPageItems(page1);

  // Checked first: an Apex Timing heat is titled "Qualifying Heat ...", which
  // would otherwise be mistaken for a qualifying sheet.
  if (isApexTimingDoc(items1)) {
    if (apexSheetType(items1) === "qualifying") {
      return { docType: "qualifying", record: await buildApexQualifyingRecord(file, pdf, items1) };
    }
    return { docType: "heat", record: await buildApexHeatRecord(file, pdf, items1) };
  }
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
const refreshBtn = document.getElementById("refreshBtn");
const searchInput = document.getElementById("searchInput");
const searchResults = document.getElementById("searchResults");
const toggleHeatsBtn = document.getElementById("toggleHeatsBtn");
const highlightedContainer = document.getElementById("highlightedContainer");
const yearSelect = document.getElementById("yearSelect");
const seriesSelect = document.getElementById("seriesSelect");
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

const THEME_KEY = "kartingTheme.v1";
const themeToggle = document.getElementById("themeToggle");
function applyTheme(theme) {
  if (theme === "light") {
    document.documentElement.dataset.theme = "light";
    themeToggle.textContent = "☀️";
  } else {
    delete document.documentElement.dataset.theme;
    themeToggle.textContent = "🌙";
  }
}
applyTheme(localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark");
themeToggle.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
});

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
// Persist any raceKey migration done during loading right away, so raw
// storage is corrected immediately rather than waiting for the next upload.
saveHeats(heats);
saveQualifying(qualifying);

const ACTIVE_CLASS_KEY = "kartingActiveClass.v1";
let activeClass = localStorage.getItem(ACTIVE_CLASS_KEY) || null;

// Year and championship are just a filtered path to a round (activeRace) -
// they're not persisted on their own, only ever re-derived from it in
// resolveActiveSelectors(), except for the moment right after the user picks
// a different year/championship here, before a round has been chosen yet.
let activeYear = null;
let activeSeriesKey = null;

function selectRace(raceKey) {
  activeRace = raceKey;
  saveActiveRace(activeRace);
  activeClass = null;
  localStorage.removeItem(ACTIVE_CLASS_KEY);
  render();
}

yearSelect.addEventListener("change", () => {
  activeYear = parseInt(yearSelect.value, 10);
  const championships = getChampionships(getRaces(), activeYear);
  // Keep the same championship if it also raced in the newly picked year,
  // otherwise fall back to the first one alphabetically.
  const champ = championships.find((c) => c.seriesKey === activeSeriesKey) || championships[0];
  activeSeriesKey = champ ? champ.seriesKey : null;
  const rounds = activeSeriesKey ? getRounds(getRaces(), activeYear, activeSeriesKey) : [];
  selectRace(rounds.length ? rounds[rounds.length - 1].raceKey : null);
});

seriesSelect.addEventListener("change", () => {
  activeSeriesKey = seriesSelect.value;
  const rounds = getRounds(getRaces(), activeYear, activeSeriesKey);
  selectRace(rounds.length ? rounds[rounds.length - 1].raceKey : null);
});

raceSelect.addEventListener("change", () => {
  selectRace(raceSelect.value);
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

function getQualiPosMap(raceKey, className, driverId = (e) => e.fullName) {
  const q = findQualifyingFor(raceKey, className);
  if (!q) return null;
  const map = new Map();
  for (const e of q.entries) map.set(driverId(e), e.pos);
  return map;
}

// A driver's sub-class (e.g. KA100's "140"/"155" weight brackets, or X30
// Master-SC's "M"/"SC" split - a marker after the last name) - fall back to
// the qualifying sheet when a heat row didn't carry it for some reason.
function getSubClassMap(raceKey, className) {
  const q = findQualifyingFor(raceKey, className);
  if (!q) return null;
  const map = new Map();
  for (const e of q.entries) if (e.subClass) map.set(e.fullName, e.subClass);
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
    if (!byKey.has(key)) byKey.set(key, { firstSeen: h.uploadedAt, count: 0, eventNames: new Map(), printedDates: [] });
    const r = byKey.get(key);
    r.count += 1;
    if (h.uploadedAt < r.firstSeen) r.firstSeen = h.uploadedAt;
    r.eventNames.set(h.eventName, (r.eventNames.get(h.eventName) || 0) + 1);
    if (h.printedAt) r.printedDates.push(h.printedAt);
  }
  // A race can also exist with only a qualifying PDF uploaded so far (the
  // preliminary, quali-only classification) - make sure it still shows up in
  // the race selector even though there's no heat for it yet.
  for (const q of qualifying) {
    const key = q.raceKey || deriveRaceKey(q.eventName);
    if (!byKey.has(key)) byKey.set(key, { firstSeen: q.uploadedAt, count: 0, eventNames: new Map(), printedDates: [] });
    const r = byKey.get(key);
    if (q.uploadedAt < r.firstSeen) r.firstSeen = q.uploadedAt;
    if (!r.eventNames.has(q.eventName)) r.eventNames.set(q.eventName, 0);
    if (q.printedAt) r.printedDates.push(q.printedAt);
  }
  return [...byKey.entries()]
    .map(([raceKey, info]) => {
      // Different documents for the same race can title themselves slightly
      // differently - use the longest (most descriptive) variant seen as the label.
      const eventName = [...info.eventNames.keys()].sort((a, b) => b.length - a.length)[0];
      // The season year isn't in the title anywhere, so it comes from the
      // timing software's own "Printed:" timestamp on the earliest document
      // for this race (falls back to the upload time if that's missing).
      const earliestPrinted = info.printedDates.length ? [...info.printedDates].sort()[0] : info.firstSeen;
      const year = new Date(earliestPrinted).getFullYear();
      return {
        raceKey,
        eventName,
        label: deriveRaceLabel(eventName),
        firstSeen: info.firstSeen,
        count: info.count,
        year: Number.isFinite(year) ? year : null,
        seriesKey: deriveSeriesKey(eventName),
        seriesLabel: deriveSeriesLabel(eventName),
        roundNumber: deriveRoundNumber(eventName),
      };
    })
    .sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
}

// Distinct years across all known races, newest first.
function getYears(races) {
  return [...new Set(races.map((r) => r.year).filter((y) => y !== null))].sort((a, b) => b - a);
}

// Distinct championships within a given year, each with the longest (most
// descriptive) championship label seen for it.
function getChampionships(races, year) {
  const map = new Map();
  for (const r of races) {
    if (r.year !== year) continue;
    if (!map.has(r.seriesKey) || r.seriesLabel.length > map.get(r.seriesKey).length) {
      map.set(r.seriesKey, r.seriesLabel);
    }
  }
  return [...map.entries()].map(([seriesKey, label]) => ({ seriesKey, label })).sort((a, b) => a.label.localeCompare(b.label));
}

// Rounds of one championship within a given year, in round order.
function getRounds(races, year, seriesKey) {
  return races
    .filter((r) => r.year === year && r.seriesKey === seriesKey)
    .sort((a, b) => (a.roundNumber ?? 0) - (b.roundNumber ?? 0));
}

function activeHeats() {
  return heats.filter((h) => (h.raceKey || deriveRaceKey(h.eventName)) === activeRace);
}

function renderSelectors(races, classifications) {
  if (!races.length) {
    yearSelect.innerHTML = '<option value="">Geen jaren</option>';
    yearSelect.disabled = true;
    seriesSelect.innerHTML = '<option value="">Geen kampioenschappen</option>';
    seriesSelect.disabled = true;
    raceSelect.innerHTML = '<option value="">Geen rondes</option>';
    raceSelect.disabled = true;
  } else {
    const years = getYears(races);
    yearSelect.disabled = false;
    yearSelect.innerHTML = years.map((y) => `<option value="${y}">${y}</option>`).join("");
    yearSelect.value = String(activeYear);

    const championships = getChampionships(races, activeYear);
    seriesSelect.disabled = false;
    seriesSelect.innerHTML = championships
      .map((c) => `<option value="${c.seriesKey.replace(/"/g, "&quot;")}">${c.label}</option>`)
      .join("");
    seriesSelect.value = activeSeriesKey;

    const rounds = getRounds(races, activeYear, activeSeriesKey);
    raceSelect.disabled = false;
    raceSelect.innerHTML = rounds
      .map((r) => {
        const track = deriveTrackLabel(r.eventName);
        const label = r.roundNumber !== null ? `Ronde ${r.roundNumber}${track ? ` — ${track}` : ""}` : r.label;
        return `<option value="${r.raceKey.replace(/"/g, "&quot;")}">${label}</option>`;
      })
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
  // Let the automatic import bring this race back in on its next run (it
  // only re-imports what's still published).
  localStorage.removeItem(AUTO_IMPORT_KEY);
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
// always 1 point), so this doesn't assume "points = position". Sets d.aNeed.
function attachFinalNeeds(drivers, heatCols, totalHeats, aCutoff) {
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

  // Once every driver has raced all their heats the standings are final, so
  // a final is simply the top N by position (ties on points are already split
  // by qualifying) - not "everyone at or under the cutoff points", which would
  // let a tied driver just outside the limit also show as qualified.
  const allDone = drivers.every((d) => d.heatsCount >= totalHeats);

  for (const d of drivers) {
    const remaining = totalHeats - d.heatsCount;
    const budget = aCutoff - d.total;
    if (allDone) {
      // Once every driver is done, anyone who missed the A-final but still
      // falls within the B-final range is in the B-final, not just "missed
      // out" - flag that separately so it can be shown as such.
      const status = d.pos <= A_FINAL_CUTOFF ? "in" : hasBFinal(drivers.length) && d.pos <= B_FINAL_CUTOFF ? "b-final" : "out-done";
      d.aNeed = { status, remaining: 0, budget };
      continue;
    }
    // The cutoff is only an estimate: treat "clearly in/out" as being at least
    // `margin` points away from it, everything closer stays undecided.
    if (remaining <= 0) {
      d.aNeed = { status: d.total <= aCutoff - margin ? "in" : d.total > aCutoff + margin ? "out-done" : "edge", remaining: 0, budget };
      continue;
    }
    if (d.total + remaining * worstPerHeat <= aCutoff - margin) {
      d.aNeed = { status: "safe", remaining, budget };
      continue;
    }
    if (d.total + remaining * bestPerHeat > aCutoff + margin) {
      d.aNeed = { status: "out", remaining, budget };
      continue;
    }
    const avgPoints = budget / remaining;
    // Not caught by the "out" check above (that only trips past cutoff+margin),
    // but scoring better than the best possible result doesn't exist either -
    // this is the same "too close to call" uncertainty as `edge`, just from
    // the other side of the cutoff.
    if (avgPoints < bestPerHeat) {
      d.aNeed = { status: "edge", remaining, budget };
      continue;
    }
    let maxPos = 1;
    for (let q = 1; q <= maxRank; q++) if (pointsFor(q) <= avgPoints) maxPos = q;
    d.aNeed = { status: "need", remaining, budget, avgPoints, maxPos };
  }
}

// IAME Finals / Eurocup format (highest points wins): every qualifying group
// races every other group, then the top 72 of that intermediate ranking go to
// one or two Super Heats (1st -> SH A, 2nd -> SH B, 3rd -> SH A, ...) whose
// points are added on top, and the top 36 of that total make the final.
const SUPER_HEAT_CUTOFF = 72;
const FINAL_CUTOFF = 36;

function isSuperHeat(heat) {
  return /super/i.test(heat.heatLabel);
}

function computeSuperHeatFormat(drivers, heatCols, raceKey, className, qualiMap) {
  const fieldSize = Math.max(drivers.length, qualiMap ? qualiMap.size : 0);
  const twoSuperHeats = fieldSize > FINAL_CUTOFF;

  // Super heat(s) raced: the standings now decide the final.
  if (heatCols.some(isSuperHeat)) {
    return { phase: "final", fieldSize, cutoffN: fieldSize > FINAL_CUTOFF ? FINAL_CUTOFF : null };
  }

  if (twoSuperHeats) {
    for (const d of drivers) {
      if (d.pos <= SUPER_HEAT_CUTOFF) d.superHeat = d.pos % 2 === 1 ? "A" : "B";
    }
  }

  const result = {
    phase: "heats",
    fieldSize,
    twoSuperHeats,
    cutoffN: fieldSize > SUPER_HEAT_CUTOFF ? SUPER_HEAT_CUTOFF : null,
    totalHeats: getTotalHeatsForClass(raceKey, className),
    projectedCutoff: null,
    sampleSize: 0,
    sampleNeeded: null,
  };
  if (!result.cutoffN || !result.totalHeats) return result;

  // Same scaled-sample projection as the national-series A-final estimate,
  // just ranked highest-first.
  const projected = drivers
    .filter((d) => d.heatsCount > 0)
    .map((d) => Math.round((d.total / d.heatsCount) * result.totalHeats))
    .sort((a, b) => b - a);
  const share = Math.max(1, Math.round((result.cutoffN * projected.length) / fieldSize));
  result.sampleSize = projected.length;
  result.sampleNeeded = Math.max(share, 10);
  if (result.sampleNeeded <= projected.length) {
    result.projectedCutoff = projected[share - 1];
    attachSuperHeatNeeds(drivers, heatCols, result.totalHeats, result.projectedCutoff, result.cutoffN);
  }
  return result;
}

// Like attachFinalNeeds, but for highest-points-wins: how many points a driver
// still has to collect to end at or above the estimated super heat cutoff.
function attachSuperHeatNeeds(drivers, heatCols, totalHeats, cutoff, cutoffN) {
  const groupCount = totalHeats + 1;
  const totalPairHeats = (groupCount * (groupCount - 1)) / 2;
  const remainingShare = Math.max(0, 1 - heatCols.length / totalPairHeats);
  const margin = remainingShare > 0 ? Math.ceil(1 + 5 * remainingShare) : 0;
  const pointsByRank = new Map();
  for (const h of heatCols) {
    for (const row of h.rows) {
      if (row.points === null || row.resultCode) continue;
      if (!pointsByRank.has(row.rank) || row.points < pointsByRank.get(row.rank)) pointsByRank.set(row.rank, row.points);
    }
  }
  if (!pointsByRank.size) return;
  const maxRank = Math.max(...pointsByRank.keys());
  const bestPerHeat = Math.max(...pointsByRank.values());
  const worstPerHeat = Math.min(...pointsByRank.values());
  const allDone = drivers.every((d) => d.heatsCount >= totalHeats);

  for (const d of drivers) {
    const remaining = totalHeats - d.heatsCount;
    const needed = cutoff - d.total;
    if (allDone) {
      d.aNeed = { status: d.pos <= cutoffN ? "in" : "out-done", remaining: 0, needed };
    } else if (remaining <= 0) {
      d.aNeed = { status: d.total >= cutoff + margin ? "in" : d.total < cutoff - margin ? "out-done" : "edge", remaining: 0, needed };
    } else if (d.total + remaining * worstPerHeat >= cutoff + margin) {
      d.aNeed = { status: "safe", remaining, needed };
    } else if (d.total + remaining * bestPerHeat < cutoff - margin) {
      d.aNeed = { status: "out", remaining, needed };
    } else {
      const avgPoints = needed / remaining;
      if (avgPoints > bestPerHeat) {
        d.aNeed = { status: "edge", remaining, needed };
      } else {
        let maxPos = 1;
        for (let q = 1; q <= maxRank; q++) if ((pointsByRank.get(q) ?? 0) >= avgPoints) maxPos = q;
        d.aNeed = { status: "need", remaining, needed, avgPoints, maxPos };
      }
    }
  }
}

function superHeatProjectionText(sf, hasQualifying) {
  if (sf.phase === "final") {
    return sf.cutoffN
      ? `🏁 Super heat(s) gereden — punten van heats + super heat opgeteld. De top ${sf.cutoffN} gaat naar de finale.`
      : `🏁 Super heat(s) gereden — iedereen (${sf.fieldSize} rijders) start in de finale.`;
  }
  const split = sf.twoSuperHeats
    ? ` Daar worden ze verdeeld over super heat A (P1, P3, P5, …) en B (P2, P4, P6, …); de badge toont waar je nu zou starten.`
    : ` Met ${FINAL_CUTOFF} of minder rijders is er één super heat met iedereen.`;
  const afterwards = ` Na de super heat(s) gaat de top ${FINAL_CUTOFF} (heats + super heat opgeteld) naar de finale.`;
  if (!sf.cutoffN) {
    return `📊 Alle ${sf.fieldSize} rijders gaan door naar de super heats (max ${SUPER_HEAT_CUTOFF}).${split}${afterwards}`;
  }
  const estimate = !sf.totalHeats
    ? hasQualifying
      ? " Kon het aantal groepen niet bepalen uit de qualifying-PDF, dus nog geen puntenschatting."
      : " Upload de qualifying-PDF van deze klasse om een puntenschatting te zien."
    : sf.projectedCutoff !== null
      ? ` Geschatte grens: <strong>~${sf.projectedCutoff} punten</strong> — o.b.v. gemiddelde punten per heat (${sf.totalHeats} heats per rijder, ${sf.sampleSize} rijders met data), kan nog wijzigen.`
      : ` Nog geen puntenschatting mogelijk — nog ${sf.sampleNeeded - sf.sampleSize} rijder(s) met minstens 1 heat nodig.`;
  return `📊 Top ${SUPER_HEAT_CUTOFF} gaat door naar de super heats.${estimate}${split}${afterwards}`;
}

function superNeedCell(d, cutoffN) {
  const n = d.aNeed;
  if (!n) return `<td class="a-need">–</td>`;
  const limit = d.total + n.needed;
  if (n.status === "edge") return `<td class="a-need a-edge" title="Te dicht bij de geschatte grens (~${limit}) om te zeggen.">≈ Op de grens</td>`;
  if (n.status === "in") return `<td class="a-need a-safe" title="Alle heats gereden — bij de eerste ${cutoffN}">✓ Super heat</td>`;
  if (n.status === "out-done") return `<td class="a-need a-out" title="Alle heats gereden — buiten de eerste ${cutoffN}">✗ Niet gehaald</td>`;
  if (n.status === "safe") return `<td class="a-need a-safe" title="Nog ${n.remaining} heat(s) — ook met de slechtste uitslagen boven de grens (~${limit})">✓ Veilig</td>`;
  if (n.status === "out") return `<td class="a-need a-out" title="Nog ${n.remaining} heat(s) — zelfs met alleen winnen niet meer haalbaar (grens ~${limit})">✗ Buiten bereik</td>`;
  const tip =
    n.remaining === 1
      ? `Nog 1 heat. Om de geschatte grens (~${limit}) te halen heb je nog minstens ${n.needed} punten nodig: eindig op P${n.maxPos} of beter.`
      : `Nog ${n.remaining} heats. Om de geschatte grens (~${limit}) te halen heb je nog minstens ${n.needed} punten nodig, gemiddeld ${Math.ceil(n.avgPoints * 10) / 10} per heat. Eindig dus gemiddeld op P${n.maxPos} of beter.`;
  const text = n.remaining === 1 ? `Laatste heat: P${n.maxPos} of beter` : `Gemiddeld P${n.maxPos} of beter`;
  return `<td class="a-need a-required" title="${tip}">${text}</td>`;
}

function needCell(d, key) {
  const n = d[key];
  if (!n) return `<td class="a-need">–</td>`;
  const tip = `Nog ${n.remaining} heat(s) · nu ${d.total} punten · grens ~${d.total + n.budget} → nog max ${Math.max(n.budget, 0)} punten te verdelen`;
  if (n.status === "edge") {
    const edgeTip =
      n.remaining > 0
        ? `Nog ${n.remaining} heat(s), maar zelfs met de beste uitslag land je net rond de geschatte grens (~${d.total + n.budget}) — te dicht om te zeggen.`
        : `Alle heats gereden, maar te dicht bij de geschatte grens (~${d.total + n.budget}) om te zeggen — wacht op de andere rijders.`;
    return `<td class="a-need a-edge" title="${edgeTip}">≈ Op de grens</td>`;
  }
  if (n.status === "in") return `<td class="a-need a-safe" title="Alle heats gereden — bij de eerste ${A_FINAL_CUTOFF} (bij gelijke punten beslist de qualifying)">✓ A-finale</td>`;
  if (n.status === "b-final") return `<td class="a-need a-out" title="Alle heats gereden — buiten de eerste ${A_FINAL_CUTOFF}, maar wel bij de eerste ${B_FINAL_CUTOFF} (B-finale)">B-finale</td>`;
  if (n.status === "out-done") return `<td class="a-need a-out" title="Alle heats gereden — buiten de eerste ${A_FINAL_CUTOFF}">✗ Niet gehaald</td>`;
  if (n.status === "safe") return `<td class="a-need a-safe" title="${tip} — ook met de slechtste uitslagen onder de grens">✓ Veilig</td>`;
  if (n.status === "out") return `<td class="a-need a-out" title="${tip} — zelfs met alleen winnen niet meer haalbaar">✗ Buiten bereik</td>`;
  const needTip =
    n.remaining === 1
      ? `Nog 1 heat. Om onder de geschatte grens (~${d.total + n.budget}) te blijven mag je nog max ${n.budget} punten scoren: eindig in die heat op P${n.maxPos} of beter.`
      : `Nog ${n.remaining} heats. Om onder de geschatte grens (~${d.total + n.budget}) te blijven mag je nog max ${n.budget} punten scoren, dat is gemiddeld ${Math.floor(n.avgPoints * 10) / 10} per heat. Eindig dus gemiddeld op P${n.maxPos} of beter; een slechte heat mag je goedmaken met een betere.`;
  const text = n.remaining === 1 ? `Laatste heat: P${n.maxPos} of beter` : `Gemiddeld P${n.maxPos} of beter`;
  return `<td class="a-need a-required" title="${needTip}">${text}</td>`;
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

    // IAME Finals (Apex Timing) heats give the winner the most points.
    const higherIsBetter = classHeats.some((h) => h.scoring === "high");
    // Apex Timing doesn't write a name the same way on every sheet (e.g.
    // "MEUNIER Senna" in the heats vs "SENNA Meunier" in the qualifying), but
    // the car number is fixed for the whole event there - match on that.
    const driverId = (row) => (higherIsBetter && row.car ? `#${row.car}` : row.fullName);

    const driverMap = new Map(); // driverId -> { id, fullName, perHeat: {id: points}, total, heatsCount }
    for (const h of heatCols) {
      for (const row of h.rows) {
        if (row.points === null) continue;
        const id = driverId(row);
        if (!driverMap.has(id)) {
          driverMap.set(id, { id, fullName: row.fullName, car: row.car, perHeat: {}, total: 0, heatsCount: 0, subClass: null });
        }
        const d = driverMap.get(id);
        d.perHeat[h.id] = { points: row.points, code: row.resultCode, heatPos: row.rank };
        d.total += row.points;
        d.heatsCount += 1;
        d.car = row.car;
        if (row.subClass) d.subClass = row.subClass;
      }
    }

    const qualiMap = getQualiPosMap(raceKey, className, driverId);
    // Known once qualifying is uploaded: with 36 or fewer drivers in the whole
    // field there's no A/B split at all - everyone races one final together -
    // so none of the A/B-final UI (banner, badges, "Nodig voor A" column)
    // applies, same as it doesn't for GK4.
    const noFinalSplit = !!qualiMap && qualiMap.size <= A_FINAL_CUTOFF;
    const subClassMap = getSubClassMap(raceKey, className);
    const drivers = [...driverMap.values()]
      .sort((a, b) => {
        if (a.total !== b.total) return higherIsBetter ? b.total - a.total : a.total - b.total;
        if (qualiMap) {
          const qa = qualiMap.get(a.id);
          const qb = qualiMap.get(b.id);
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
        qualiPos: qualiMap ? qualiMap.get(d.id) : undefined,
        subClass: d.subClass || (subClassMap ? subClassMap.get(d.fullName) : undefined) || null,
      }));

    // Position within your own weight class (e.g. KA100's 140/155 kg split) -
    // only meaningful once at least two different classes actually show up.
    const subClassGroups = new Map();
    for (const d of drivers) {
      if (!d.subClass) continue;
      if (!subClassGroups.has(d.subClass)) subClassGroups.set(d.subClass, []);
      subClassGroups.get(d.subClass).push(d);
    }
    const hasMultipleSubClasses = subClassGroups.size > 1;
    const subClassOrder = hasMultipleSubClasses ? [...subClassGroups.keys()].sort() : [];
    if (hasMultipleSubClasses) {
      for (const group of subClassGroups.values()) {
        group.forEach((d, idx) => {
          d.subClassPos = idx + 1;
          d.subClassSize = group.length;
        });
      }
    }

    // The A/B-final projection assumes lowest-points-wins and the 36-driver
    // A-final of the national series - neither applies to the IAME Finals.
    const totalHeats = higherIsBetter ? null : getTotalHeatsForClass(raceKey, className);
    let projectedACutoff = null;
    let projectedBCutoff = null;
    let projectedSampleSize = 0;
    let projectedSampleNeeded = null;
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
      // A handful of data points is too noisy to say anything useful, however
      // small the scaled share comes out to - require a minimum absolute
      // sample too, not just the scaled one.
      const MIN_PROJECTION_SAMPLE = 10;
      // Gate on the SCALED index being available, not the raw 36th/72nd - with
      // e.g. 25 of a 75-driver field raced so far, share(36) is only ~12, which
      // the sample already covers. Requiring the raw 36 blocked any estimate
      // until way more heats were in, even though the scaled one was already fine.
      const neededA = Math.max(share(A_FINAL_CUTOFF), MIN_PROJECTION_SAMPLE);
      const neededB = Math.max(share(B_FINAL_CUTOFF), MIN_PROJECTION_SAMPLE);
      if (fieldSize > A_FINAL_CUTOFF) {
        projectedSampleNeeded = neededA;
        if (neededA <= projected.length) projectedACutoff = projected[share(A_FINAL_CUTOFF) - 1];
      }
      if (hasBFinal(fieldSize) && neededB <= projected.length) projectedBCutoff = projected[share(B_FINAL_CUTOFF) - 1];
    }
    if (totalHeats && projectedACutoff !== null) {
      attachFinalNeeds(drivers, heatCols, totalHeats, projectedACutoff);
    }
    const superFormat = higherIsBetter ? computeSuperHeatFormat(drivers, heatCols, raceKey, className, qualiMap) : null;

    classifications.push({
      className,
      heatCols,
      drivers,
      hasQualifying: !!qualiMap,
      totalHeats,
      projectedACutoff,
      projectedBCutoff,
      projectedSampleSize,
      projectedSampleNeeded,
      hasMultipleSubClasses,
      subClassOrder,
      noFinalSplit: noFinalSplit || higherIsBetter,
      higherIsBetter,
      superFormat,
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
        subClass: e.subClass || null,
      }));
    const qSubClassGroups = new Map();
    for (const d of drivers) {
      if (!d.subClass) continue;
      if (!qSubClassGroups.has(d.subClass)) qSubClassGroups.set(d.subClass, []);
      qSubClassGroups.get(d.subClass).push(d);
    }
    const qHasMultipleSubClasses = qSubClassGroups.size > 1;
    const qSubClassOrder = qHasMultipleSubClasses ? [...qSubClassGroups.keys()].sort() : [];
    if (qHasMultipleSubClasses) {
      for (const group of qSubClassGroups.values()) {
        group.forEach((d, idx) => {
          d.subClassPos = idx + 1;
          d.subClassSize = group.length;
        });
      }
    }
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
      projectedSampleNeeded: null,
      hasMultipleSubClasses: qHasMultipleSubClasses,
      subClassOrder: qSubClassOrder,
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
    const { className, heatCols, drivers, hasQualifying, qualiOnly, totalHeats, projectedACutoff, projectedBCutoff, projectedSampleSize, projectedSampleNeeded, hasMultipleSubClasses, subClassOrder, noFinalSplit, higherIsBetter, superFormat } =
      selected;
    // IAME Finals / Eurocup: own cutoff (top 72 to the super heats, then top
    // 36 to the final) instead of the national-series A/B-final split.
    const sf = !qualiOnly ? superFormat : null;
    // GK4 doesn't work with qualifying groups or an A/B-final split at all -
    // none of that is relevant there, so hide it entirely for GK4 races. A
    // qualifying-only preliminary list (no heats raced yet) doesn't have a
    // real A/B-final split either, since it's not based on points. Same for a
    // field the qualifying shows has 36 or fewer drivers - just one final.
    const isGK4Race = activeRace && activeRace.startsWith("gk4-round-");
    const suppressFinals = isGK4Race || qualiOnly || noFinalSplit;
    const showHeatsUI = showHeatColumns && heatCols.length > 0;
    const block = document.createElement("section");
    block.className = "panel class-block";
    const aNeedAvailable = sf ? sf.projectedCutoff != null : !suppressFinals && projectedACutoff !== null;
    const needLabel = sf ? "Nodig voor super heat" : "Nodig voor A";
    const showANeed = aNeedAvailable && showANeedPref;
    const colCount = 4 + (showHeatsUI ? 1 : 0) + (showANeed ? 1 : 0); // Pos, Rijder, [Resultaten], Totaal, Heats, [A-finale]
    // Once every heat is raced, renumber the B-final group starting back at 1
    // (its own start order) instead of continuing the overall P37, P38, ...
    const allHeatsDone = !suppressFinals && !!totalHeats && drivers.every((d) => d.heatsCount >= totalHeats);
    const resultsHeaderCell = showHeatsUI ? `<th>Resultaten per heat</th>` : "";
    const rowsHtml = drivers.map((d) => {
      const resultsCell = showHeatsUI
        ? `<td class="results-cell"><div class="results-wrap">${heatCols
            .filter((h) => d.perHeat[h.id])
            .map((h) => {
              const entry = d.perHeat[h.id];
              const codeTag = entry.code ? ` <span class="result-code">${entry.code}</span>` : "";
              return `<span class="result-chip" data-heat-id="${h.id.replace(/"/g, "&quot;")}" title="Bekijk volledige uitslag van ${h.heatLabel}">P${entry.heatPos}${codeTag}</span>`;
            })
            .join("")}</div></td>`
        : "";
      const isHighlighted = highlights.has(d.key);
      const qualifiesA = !suppressFinals && drivers.length > A_FINAL_CUTOFF && d.pos <= A_FINAL_CUTOFF;
      const qualifiesB = !suppressFinals && hasBFinal(drivers.length) && d.pos > A_FINAL_CUTOFF && d.pos <= B_FINAL_CUTOFF;
      const restarted = allHeatsDone && hasBFinal(drivers.length) && d.pos > A_FINAL_CUTOFF;
      const displayPos = restarted ? d.pos - A_FINAL_CUTOFF : d.pos;
      const posTitleParts = [];
      if (qualifiesA) posTitleParts.push("Kwalificeert voor de A-finale");
      if (qualifiesB) posTitleParts.push("Kwalificeert voor de B-finale");
      if (restarted) posTitleParts.push(`Startnummer B-finale (eindpositie na de heats: P${d.pos})`);
      const sfIn = !!sf && !!sf.cutoffN && d.pos <= sf.cutoffN;
      if (sfIn) posTitleParts.push(sf.phase === "final" ? "Kwalificeert voor de finale" : "Kwalificeert voor de super heats");
      if (d.qualiPos !== undefined) posTitleParts.push(`Qualifying P${d.qualiPos}`);
      const superHeatBadge =
        sf && d.superHeat
          ? `<span class="sub-class-badge" style="${subClassStyle(d.superHeat, ["A", "B"])}" title="Zou nu in super heat ${d.superHeat} starten (oneven posities in A, even in B)">SH ${d.superHeat}</span>`
          : "";
      const weightBadge =
        hasMultipleSubClasses && d.subClass
          ? `<span class="sub-class-badge" style="${subClassStyle(d.subClass, subClassOrder)}" title="${d.subClassPos}e van ${d.subClassSize} in de ${d.subClass}-klasse">${d.subClass} · P${d.subClassPos}</span>`
          : "";
      let html = `<tr class="${isHighlighted ? "highlighted" : ""} ${qualifiesA || sfIn ? "qualifies-a" : ""} ${qualifiesB ? "qualifies-b" : ""}" data-key="${d.key.replace(/"/g, "&quot;")}">
          <td class="pos ${d.pos === 1 ? "pos-first" : ""}" title="${posTitleParts.join(" · ")}">${displayPos}</td>
          <td class="name-cell">
            <button type="button" class="star-btn ${isHighlighted ? "starred" : ""}" title="Highlight rijder" aria-label="Highlight ${d.fullName}">${isHighlighted ? "★" : "☆"}</button>
            ${d.fullName} <span class="car-number">#${d.car}</span>${weightBadge}${superHeatBadge}
          </td>
          ${resultsCell}
          <td class="num total">${d.total !== null ? d.total : "–"}</td>
          <td class="num">${d.heatsCount}</td>
          ${showANeed ? (sf ? superNeedCell(d, sf.cutoffN) : needCell(d, "aNeed")) : ""}
        </tr>`;
      if (sf && sf.cutoffN && d.pos === sf.cutoffN && drivers.length > sf.cutoffN) {
        html += `<tr class="cutoff-row"><td colspan="${colCount}">${sf.phase === "final" ? "Finale" : "Super heat"} grens — top ${sf.cutoffN}</td></tr>`;
      }
      if (!suppressFinals && d.pos === A_FINAL_CUTOFF && drivers.length > A_FINAL_CUTOFF) {
        html += `<tr class="cutoff-row"><td colspan="${colCount}">A-finale grens — top ${A_FINAL_CUTOFF}</td></tr>`;
      }
      if (!suppressFinals && d.pos === B_FINAL_CUTOFF && drivers.length > B_FINAL_CUTOFF && hasBFinal(drivers.length)) {
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
            : `Klassement over ${heatCols.length} heat(s) — punten opgeteld, ${higherIsBetter ? "hoogste" : "laagste"} totaal bovenaan. Klik de ster om een rijder te highlighten.${hasQualifying ? " Bij gelijke punten beslist de qualifying (snelste tijd wint)." : ""}`
        }</p>
        ${unevenHeats ? '<p class="class-warning">⚠ Niet alle rijders hebben evenveel heats gereden — dit klassement is nog niet volledig.</p>' : ""}
        ${sf ? `<p class="class-projection">${superHeatProjectionText(sf, hasQualifying)}</p>` : ""}
        ${
          suppressFinals
            ? ""
            : `<p class="class-projection">${
                totalHeats
                  ? projectedACutoff !== null
                    ? `📊 Geschatte grens A-finale: <strong>~${projectedACutoff} punten</strong>${
                        projectedBCutoff !== null ? ` · B-finale: <strong>~${projectedBCutoff} punten</strong>` : ""
                      } — schatting o.b.v. gemiddelde punten per heat (${totalHeats} heats totaal per rijder, ${projectedSampleSize} rijders met data), kan nog wijzigen.`
                    : `📊 A/B-finale grens: nog geen schatting mogelijk — nog ${projectedSampleNeeded - projectedSampleSize} rijder(s) met minstens 1 heat nodig (nu ${projectedSampleSize} van de ${projectedSampleNeeded} benodigd).`
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
                  Toon "${needLabel}"
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
                ${showANeed ? `<th title="Wat je in de resterende heats nog nodig hebt, o.b.v. de geschatte grens">${needLabel}</th>` : ""}
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
  const allHeatsDone = !!selected.totalHeats && selected.drivers.every((d) => d.heatsCount >= selected.totalHeats);

  const bodyRows = followed
    .map((d) => {
      const isGK4Race = (activeRace && activeRace.startsWith("gk4-round-")) || selected.noFinalSplit;
      const qualifiesA = !isGK4Race && d.classDriverCount > A_FINAL_CUTOFF && d.pos <= A_FINAL_CUTOFF;
      const qualifiesB = !isGK4Race && hasBFinal(d.classDriverCount) && d.pos > A_FINAL_CUTOFF && d.pos <= B_FINAL_CUTOFF;
      const restarted = !isGK4Race && allHeatsDone && hasBFinal(d.classDriverCount) && d.pos > A_FINAL_CUTOFF;
      const displayPos = restarted ? d.pos - A_FINAL_CUTOFF : d.pos;
      const posTitle = restarted
        ? `Startnummer B-finale (eindpositie na de heats: P${d.pos})`
        : qualifiesA
          ? "Kwalificeert voor de A-finale"
          : qualifiesB
            ? "Kwalificeert voor de B-finale"
            : "";
      const weightBadge =
        selected.hasMultipleSubClasses && d.subClass
          ? `<span class="sub-class-badge" style="${subClassStyle(d.subClass, selected.subClassOrder)}" title="${d.subClassPos}e van ${d.subClassSize} in de ${d.subClass}-klasse">${d.subClass} · P${d.subClassPos}</span>`
          : "";
      return `<tr class="${qualifiesA ? "qualifies-a" : ""} ${qualifiesB ? "qualifies-b" : ""}">
        <td class="name-cell">
          <button type="button" class="star-btn starred" title="Highlight verwijderen" aria-label="Highlight ${d.fullName} verwijderen">★</button>
          ${d.fullName} <span class="car-number">#${d.car}</span>${weightBadge}
        </td>
        <td class="num pos ${d.pos === 1 ? "pos-first" : ""}" title="${posTitle}">${displayPos}</td>
        <td class="num total">${d.total}</td>
        <td class="num">${d.heatsCount}</td>
        ${showANeed ? needCell(d, "aNeed") : ""}
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

// activeRace (the round) is the single source of truth: activeYear and
// activeSeriesKey are always re-derived from it here, so the Year/Championship
// pickers can never drift out of sync with whichever round is actually shown.
function resolveActiveSelectors(races) {
  if (!races.some((r) => r.raceKey === activeRace)) {
    activeRace = races.length ? races[races.length - 1].raceKey : null;
    saveActiveRace(activeRace);
  }
  const current = races.find((r) => r.raceKey === activeRace);
  activeYear = current ? current.year : null;
  activeSeriesKey = current ? current.seriesKey : null;
}

function render() {
  const races = getRaces();
  resolveActiveSelectors(races);

  const currentHeats = activeHeats();
  const classifications = computeClassifications(currentHeats);
  renderSelectors(races, classifications);
  renderHeatsList(currentHeats, activeQualifying());
  renderHighlighted(classifications);
  renderClassifications(classifications);
  renderSearchResults(classifications);
}

render();

/* ---------------- Automatic import ---------------- */

// A scheduled GitHub Action (scripts/fetch_apex.py) downloads new result PDFs
// from Apex Timing into data/apex/ and lists them in manifest.json. Import
// every file we haven't seen in this exact version (by hash) yet - a revised
// PDF gets a new hash and is merged like a manual re-upload would be.
// Read straight from GitHub rather than relative to the page: the app is often
// opened as a local file (file://), which can't fetch sibling files and
// wouldn't have the Action's newest commits anyway. raw.githubusercontent.com
// allows cross-origin requests (also from file://), but caches a branch URL
// for ~5 minutes - so look up the latest commit first (GitHub API, cached
// ~1 minute, 60 requests/hour) and read that exact, always-fresh version.
const AUTO_IMPORT_REPO = "DFKKarting/Heats";
const AUTO_IMPORT_KEY = "kartingAutoImported.v1";
const AUTO_IMPORT_INTERVAL_MS = 2 * 60 * 1000;
let autoImportRunning = null; // the in-flight run's promise, if any

function loadAutoImported() {
  try {
    return JSON.parse(localStorage.getItem(AUTO_IMPORT_KEY)) || {};
  } catch {
    return {};
  }
}

async function autoImportBase() {
  try {
    const resp = await fetch(`https://api.github.com/repos/${AUTO_IMPORT_REPO}/commits/master`, {
      headers: { Accept: "application/vnd.github.sha" },
      cache: "no-store",
    });
    if (resp.ok) return `https://raw.githubusercontent.com/${AUTO_IMPORT_REPO}/${(await resp.text()).trim()}/`;
  } catch {
    // fall through - e.g. rate-limited
  }
  return `https://raw.githubusercontent.com/${AUTO_IMPORT_REPO}/master/`;
}

// `manual`: started with the "Nu ophalen" button, so always report back. A
// click while a run is already going (e.g. the one at startup) just waits for
// that run instead of being silently ignored.
async function autoImport(manual = false) {
  if (autoImportRunning) {
    if (manual) setStatus("Bezig met ophalen van nieuwe resultaten...");
    return autoImportRunning;
  }
  autoImportRunning = runAutoImport(manual);
  try {
    await autoImportRunning;
  } finally {
    autoImportRunning = null;
  }
}

async function runAutoImport(manual) {
  refreshBtn.disabled = true;
  if (manual) setStatus("Bezig met ophalen van nieuwe resultaten...");
  try {
    const base = await autoImportBase();
    let manifest;
    try {
      const resp = await fetch(`${base}data/apex/manifest.json`, { cache: "no-store" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      manifest = await resp.json();
    } catch {
      if (manual) setStatus("Kon de resultaten niet ophalen — ben je online?", "err");
      return;
    }
    const seen = loadAutoImported();
    const todo = (manifest.files || []).filter((f) => seen[f.path] !== f.sha1);
    if (!todo.length) {
      if (manual) setStatus("Geen nieuwe resultaten — alles is al ingeladen.", "ok");
      return;
    }

    let heatCount = 0;
    let qualiCount = 0;
    for (const f of todo) {
      let blob;
      try {
        const resp = await fetch(`${base}${f.path}`, { cache: "no-store" });
        if (!resp.ok) continue; // not there yet / network trouble - retry next round
        blob = await resp.blob();
      } catch {
        continue;
      }
      try {
        const file = new File([blob], f.path.split("/").pop(), { type: "application/pdf" });
        const { docType, record } = await parseUploadedFile(file);
        if (docType === "qualifying") {
          mergeQualifying(record);
          qualiCount++;
        } else {
          mergeHeat(record);
          heatCount++;
        }
      } catch (e) {
        console.warn(`Automatisch inlezen mislukt voor ${f.path}:`, e);
      }
      // Marked even when parsing failed, so a broken file isn't retried forever.
      seen[f.path] = f.sha1;
      // A first import can be hundreds of files - save progress along the
      // way so an interrupted run doesn't start over from scratch.
      if (Object.keys(seen).length % 20 === 0) {
        saveHeats(heats);
        saveQualifying(qualifying);
        localStorage.setItem(AUTO_IMPORT_KEY, JSON.stringify(seen));
      }
    }
    saveHeats(heats);
    saveQualifying(qualifying);
    localStorage.setItem(AUTO_IMPORT_KEY, JSON.stringify(seen));
    render();
    const parts = [];
    if (heatCount) parts.push(`${heatCount} heat(s)`);
    if (qualiCount) parts.push(`${qualiCount} qualifying`);
    if (parts.length) setStatus(`Automatisch ingeladen: ${parts.join(" en ")}.`, "ok");
    else if (manual) setStatus("Geen nieuwe resultaten — alles is al ingeladen.", "ok");
  } finally {
    refreshBtn.disabled = false;
  }
}

refreshBtn.addEventListener("click", () => autoImport(true));
autoImport();
setInterval(() => autoImport(), AUTO_IMPORT_INTERVAL_MS);
