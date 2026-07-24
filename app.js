/* Karting Klassement - client-side PDF result parser + cumulative classification
   Tuned for the "Camp Company / MW Raceconsulting" timing PDF layout
   (columns identified by fixed x-position ranges, in PDF points). */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const STORAGE_KEY = "kartingHeats.v1";
const HIGHLIGHT_KEY = "kartingHighlights.v1";
const ACTIVE_RACE_KEY = "kartingActiveRace.v1";

const COL = {
  RANK: [16, 25],
  CAR: [48, 66],
  NAME: [70, 156],
  POINTS: [554, 585],
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

function within(x, [lo, hi]) {
  return x >= lo && x <= hi;
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
  // The timing software stamps every export with "Printed: DD.MM.YYYY / HH:MM".
  // A later stamp for the same heat means it's a newer, revised export.
  const rawText = items.map((it) => it.text).join(" ");
  const m = rawText.match(/Printed:\s*(\d{2})\.(\d{2})\.(\d{4})\s*\/\s*(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min] = m;
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:00`;
}

function parseTitleBlock(items, tableTopY) {
  const above = items.filter((it) => it.x < 350 && it.y < tableTopY - 15);
  const lines = clusterByY(above, 3).sort((a, b) => a.y - b.y);
  const eventName = lines[0] ? lines[0].text : "";
  const classLine = lines[1] ? lines[1].text : "";
  let className = classLine;
  let heatLabel = "";
  const m = classLine.match(/^(.*?)\s*-\s*(Heat\s+\d+\s*[A-Za-z0-9\-]*)\s*$/i);
  if (m) {
    className = m[1].trim();
    heatLabel = m[2].trim();
  }
  return { eventName, className: className || "Onbekende klasse", heatLabel: heatLabel || classLine || "Heat" };
}

function parseRows(items) {
  const rankAnchors = items
    .filter((it) => within(it.x, COL.RANK) && /^[0-9]+$/.test(it.text))
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

    rows.push({
      rank: i + 1,
      car: carItem ? carItem.text : "",
      firstName,
      lastName: lastNameClean,
      fullName,
      points: pointsItem ? parseInt(pointsItem.text, 10) : null,
    });
  }
  return { rows, tableTopY: Math.min(...anchors.map((a) => a.y)) };
}

async function parsePdfFile(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const page = await pdf.getPage(1);
  const items = await extractPageItems(page);

  const { rows, tableTopY } = parseRows(items);
  if (!rows.length) {
    throw new Error("Kon geen resultatentabel herkennen in dit PDF.");
  }
  const { eventName, className, heatLabel } = parseTitleBlock(items, tableTopY);
  const printedAt = parsePrintedAt(items);

  return {
    id: `${eventName}::${className}::${heatLabel}`,
    className,
    heatLabel,
    eventName,
    fileName: file.name,
    uploadedAt: new Date().toISOString(),
    printedAt,
    rows,
  };
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
const raceTabs = document.getElementById("raceTabs");

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

let heats = loadHeats();
let highlights = loadHighlights();
let activeRace = loadActiveRace();

function toggleHighlight(key) {
  if (highlights.has(key)) {
    highlights.delete(key);
  } else {
    highlights.add(key);
  }
  saveHighlights(highlights);
  render();
}

function getRaces() {
  const byRace = new Map();
  for (const h of heats) {
    if (!byRace.has(h.eventName)) byRace.set(h.eventName, { firstSeen: h.uploadedAt, count: 0 });
    const r = byRace.get(h.eventName);
    r.count += 1;
    if (h.uploadedAt < r.firstSeen) r.firstSeen = h.uploadedAt;
  }
  return [...byRace.entries()]
    .map(([eventName, info]) => ({ eventName, label: deriveRaceLabel(eventName), ...info }))
    .sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
}

function activeHeats() {
  return heats.filter((h) => h.eventName === activeRace);
}

function renderRaceTabs(races) {
  if (!races.length) {
    raceTabs.innerHTML = "";
    return;
  }
  raceTabs.innerHTML = "";
  for (const r of races) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "race-tab" + (r.eventName === activeRace ? " active" : "");
    btn.textContent = r.eventName;
    btn.addEventListener("click", () => {
      activeRace = r.eventName;
      saveActiveRace(activeRace);
      render();
    });
    raceTabs.appendChild(btn);
  }
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
  let okCount = 0;
  let revisionCount = 0;
  let skippedCount = 0;
  let lastEventName = null;
  const errors = [];
  for (const file of files) {
    try {
      const parsed = await parsePdfFile(file);
      const outcome = mergeHeat(parsed);
      if (outcome === "replaced-with-revision") revisionCount++;
      if (outcome === "skipped-older-revision") skippedCount++;
      lastEventName = parsed.eventName;
      okCount++;
    } catch (e) {
      errors.push(`${file.name}: ${e.message}`);
    }
  }
  saveHeats(heats);
  if (lastEventName) {
    activeRace = lastEventName;
    saveActiveRace(activeRace);
  }
  render();
  const notes = [];
  if (revisionCount) notes.push(`${revisionCount} revisie(s) automatisch overgenomen`);
  if (skippedCount) notes.push(`${skippedCount} oudere revisie(s) genegeerd`);
  const noteText = notes.length ? ` (${notes.join(", ")})` : "";
  if (errors.length) {
    setStatus(`${okCount} heat(s) geladen${noteText}. Fout bij: ${errors.join(" | ")}`, "err");
  } else {
    setStatus(`${okCount} heat(s) succesvol geladen${noteText}.`, "ok");
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
  if (!current.length) return;
  const label = deriveRaceLabel(activeRace);
  if (!confirm(`Alle heats van ${label} wissen?`)) return;
  heats = heats.filter((h) => h.eventName !== activeRace);
  saveHeats(heats);
  render();
  setStatus(`Heats van ${label} gewist.`, "ok");
});

function removeHeat(id) {
  heats = heats.filter((h) => h.id !== id);
  saveHeats(heats);
  render();
}

function renderHeatsList(heatsSubset) {
  if (!heatsSubset.length) {
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
}

function computeClassifications(heatsSubset) {
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
        d.perHeat[h.id] = row.points;
        d.total += row.points;
        d.heatsCount += 1;
        d.car = row.car;
      }
    }

    const drivers = [...driverMap.values()]
      .sort((a, b) => a.total - b.total || b.heatsCount - a.heatsCount || a.fullName.localeCompare(b.fullName))
      .map((d, idx) => ({ ...d, pos: idx + 1, key: `${className}::${d.fullName}` }));

    classifications.push({ className, heatCols, drivers });
  }
  return classifications;
}

function renderClassifications(classifications) {
  classificationsContainer.innerHTML = "";
  if (!classifications.length) return;

  for (const { className, heatCols, drivers } of classifications) {
    const block = document.createElement("section");
    block.className = "panel class-block";
    const heatHeaderCells = heatCols.map((h) => `<th class="num" title="${h.eventName || ""}">${h.heatLabel}</th>`).join("");
    const bodyRows = drivers
      .map((d) => {
        const heatCells = heatCols
          .map((h) => `<td class="num">${d.perHeat[h.id] !== undefined ? d.perHeat[h.id] : "–"}</td>`)
          .join("");
        const isHighlighted = highlights.has(d.key);
        return `<tr class="${isHighlighted ? "highlighted" : ""}" data-key="${d.key.replace(/"/g, "&quot;")}">
          <td class="pos">${d.pos}</td>
          <td class="name-cell">
            <button type="button" class="star-btn ${isHighlighted ? "starred" : ""}" title="Highlight rijder" aria-label="Highlight ${d.fullName}">${isHighlighted ? "★" : "☆"}</button>
            ${d.fullName}
          </td>
          <td class="num">${d.car}</td>
          ${heatCells}
          <td class="num total">${d.total}</td>
          <td class="num">${d.heatsCount}</td>
        </tr>`;
      })
      .join("");

    block.innerHTML = `
      <h2>${className}</h2>
      <p class="class-meta">Klassement over ${heatCols.length} heat(s) — punten opgeteld, laagste totaal bovenaan. Klik de ster om een rijder te highlighten.</p>
      <div style="overflow-x:auto;">
        <table class="classification">
          <thead>
            <tr>
              <th>Pos</th>
              <th>Rijder</th>
              <th class="num">#</th>
              ${heatHeaderCells}
              <th class="num">Totaal</th>
              <th class="num">Heats</th>
            </tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    `;
    block.querySelectorAll(".star-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        toggleHighlight(btn.closest("tr").dataset.key);
      });
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
  const followed = [];
  for (const { className, drivers } of classifications) {
    for (const d of drivers) {
      if (highlights.has(d.key)) followed.push({ ...d, className });
    }
  }

  if (!followed.length) {
    highlightedContainer.innerHTML = '<p class="empty-hint">Nog geen rijders gehighlight. Klik op een ster om een rijder te volgen.</p>';
    return;
  }

  followed.sort((a, b) => a.className.localeCompare(b.className) || a.pos - b.pos);

  const bodyRows = followed
    .map(
      (d) => `<tr>
        <td class="name-cell">
          <button type="button" class="star-btn starred" title="Highlight verwijderen" aria-label="Highlight ${d.fullName} verwijderen">★</button>
          ${d.fullName}
        </td>
        <td>${d.className}</td>
        <td class="num pos">${d.pos}</td>
        <td class="num total">${d.total}</td>
        <td class="num">${d.heatsCount}</td>
      </tr>`
    )
    .join("");

  highlightedContainer.innerHTML = `
    <div style="overflow-x:auto;">
      <table class="classification">
        <thead>
          <tr>
            <th>Rijder</th>
            <th>Klasse</th>
            <th class="num">Positie</th>
            <th class="num">Punten</th>
            <th class="num">Heats</th>
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
  if (!races.some((r) => r.eventName === activeRace)) {
    activeRace = races.length ? races[races.length - 1].eventName : null;
    saveActiveRace(activeRace);
  }
  renderRaceTabs(races);

  const currentHeats = activeHeats();
  const classifications = computeClassifications(currentHeats);
  renderHeatsList(currentHeats);
  renderHighlighted(classifications);
  renderClassifications(classifications);
  renderSearchResults(classifications);
}

render();
