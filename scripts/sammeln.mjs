/**
 * Bayazit Fußball-Ergebnisse – Daten-Sammler
 *
 * Läuft automatisch über GitHub Actions (siehe .github/workflows/ergebnisse.yml).
 * Holt die beendeten Spiele mit allen Details (Ereignisse, Aufstellung, Statistik, Noten)
 * und die Tabellen und speichert alles dauerhaft im Ordner data/.
 *
 * Datenquelle: API-Football – über deinen Cloudflare-Worker (der kennt den Schlüssel).
 * Alternativ: GitHub-Secret API_FOOTBALL_KEY (dann direkt bei API-Football).
 *
 * Sparsam: Gratis-Plan = 100 Abrufe pro Tag und ca. 10 pro Minute.
 * 1 Abruf liefert bis zu 20 Spiele inklusive aller Details.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const TZ = "Europe/Berlin";

const WORKER = (process.env.WORKER_URL || "https://fussball-live.bayazit-tekin.workers.dev").replace(/\/+$/, "");
const KEY = process.env.API_FOOTBALL_KEY || "";
const DIRECT = "https://v3.football.api-sports.io";

const RESERVE = Number(process.env.RESERVE || 4);          // so viele Abrufe pro Tag immer übrig lassen
const MAX_RUN = Number(process.env.MAX_RUN || 0);          // 0 = automatisch
const PAUSE_MS = Number(process.env.PAUSE_MS || 13000);    // Pause zwischen Abrufen (Gratis-Plan ist streng)
const BACKFILL_FROM = process.env.BACKFILL_FROM || "2026-08-01"; // so weit zurück werden alte Spieltage nachgeholt
const DRY = process.env.DRY === "1";

/* ---------------- Ligen (gleich wie früher auf der Live-Seite) ---------------- */
const GERMANY_TOP = [78, 79, 80, 81, 82];                  // Bundesliga, 2. Liga, 3. Liga, DFB-Pokal, Frauen-Bundesliga
const LEAGUES = {
  "World": [2, 3, 848, 531, 15, 1, 4, 5, 32, 960, 10],
  "England": [39, 40, 41, 45, 48],
  "Spain": [140, 141, 143],
  "Italy": [135, 136, 137],
  "France": [61, 62, 66],
  "Turkey": [203, 204, 206],
  "Netherlands": [88, 89, 90],
  "Portugal": [94, 95, 96],
  "Austria": [218, 219, 220],
  "Switzerland": [207, 208, 209],
  "Belgium": [144, 145],
  "Scotland": [179, 180, 181],
  "Greece": [197, 198],
  "Denmark": [119, 120],
  "Poland": [106, 107],
  "Czech-Republic": [345, 346],
  "Croatia": [210, 211],
  "Sweden": [113, 114],
  "Norway": [103, 104],
  "Brazil": [71, 72],
  "Argentina": [128, 129],
  "USA": [253, 255],
  "Mexico": [262, 263],
  "Saudi-Arabia": [307, 308],
  "Japan": [98, 99]
};
const COUNTRY_ORDER = ["Germany", ...Object.keys(LEAGUES)];
const LEAGUE_COUNTRY = new Map();
for (const [c, ids] of Object.entries(LEAGUES)) ids.forEach(id => LEAGUE_COUNTRY.set(id, c));
GERMANY_TOP.forEach(id => LEAGUE_COUNTRY.set(id, "Germany"));

// Tabellen werden für diese Ligen gesammelt (Pokale haben keine Tabelle)
const CUPS = new Set([81, 45, 48, 143, 137, 66, 206, 90, 96, 220, 209, 181, 1, 4, 5, 10, 32, 531, 960, 15]);

const LIVE = new Set(["1H", "HT", "2H", "ET", "BT", "P", "SUSP", "INT", "LIVE"]);
const DONE = new Set(["FT", "AET", "PEN"]);
const DONE_NODETAIL = new Set(["AWD", "WO"]);
const DEAD = new Set(["CANC", "ABD", "PST"]);

function countryOf(l) { return LEAGUE_COUNTRY.get(l.id) || (l.country === "Türkiye" ? "Turkey" : l.country); }
function germanTier(n) {
  n = String(n || "");
  if (/U19|U17|U21|Junioren|Youth|Jugend/i.test(n)) return 60;
  if (/Frauen|Women|Femin/i.test(n)) return 50;
  if (/^Regionalliga/i.test(n)) return 20;
  if (/^Oberliga/i.test(n)) return 30;
  if (/Pokal|Cup/i.test(n)) return 40;
  return 45;
}
function leagueRank(l) {
  const c = countryOf(l);
  let ci = COUNTRY_ORDER.indexOf(c); if (ci < 0) ci = 900;
  const arr = c === "Germany" ? GERMANY_TOP : (LEAGUES[c] || []);
  let li = arr.indexOf(l.id);
  if (li < 0) li = c === "Germany" ? germanTier(l.name) : 80;
  return ci * 100 + li;
}
function wanted(f) { return LEAGUE_COUNTRY.has(f.league.id) || f.league.country === "Germany"; }

/* ---------------- Hilfen ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ymd(d) { return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); }
function addDays(s, n) { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10); }
function readJSON(p, d) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } }
function writeJSON(p, obj) {
  if (DRY) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
}
const dayFile = d => path.join(DATA, "tage", d + ".json");
const matchFile = (id, date) => path.join(DATA, "spiele", date.slice(0, 7), id + ".json");
const tableFile = id => path.join(DATA, "tabellen", id + ".json");
const LOGLINES = [];
const log = (...a) => { const s = a.join(" "); LOGLINES.push(s); console.log(s); };

/* ---------------- Abruf ---------------- */
let calls = 0, lastCall = 0, budget = 0, stopped = "", dateWindow = null;
async function api(endpoint, params, { free = false } = {}) {
  if (!free) {
    if (calls >= budget) { stopped = "Tagesbudget für diesen Lauf aufgebraucht"; return null; }
    const wait = lastCall + PAUSE_MS - Date.now();
    if (wait > 0) await sleep(wait);
  }
  const qs = new URLSearchParams(params).toString();
  const url = KEY ? `${DIRECT}/${endpoint}?${qs}` : `${WORKER}/${endpoint}?${qs}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    lastCall = Date.now();
    if (!free) calls++;
    let j;
    try {
      const r = await fetch(url, { headers: KEY ? { "x-apisports-key": KEY } : {} });
      j = await r.json();
    } catch (e) { log("  ! Netzwerkfehler", endpoint, e.message); return null; }
    const errs = j && j.errors ? (Array.isArray(j.errors) ? j.errors : Object.values(j.errors)) : [];
    if (!errs.length) return j.response;
    const msg = errs.join(" · ");
    if (/per minute|too many/i.test(msg) && attempt === 0) { log("  … Minuten-Grenze, warte 65 s"); await sleep(65000); continue; }
    if (/request limit for the day/i.test(msg)) { stopped = "Tageskontingent von API-Football aufgebraucht"; budget = calls; }
    log("  ! API-Fehler", endpoint, qs, msg);
    const win = msg.match(/from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/);
    if (win) dateWindow = {from: win[1], to: win[2]};
    return null;
  }
  return null;
}

/* ---------------- Daten verschlanken ---------------- */
function slimFixture(f) {
  return {
    fixture: {
      id: f.fixture.id, date: f.fixture.date, timestamp: f.fixture.timestamp, referee: f.fixture.referee || null,
      venue: { name: f.fixture.venue && f.fixture.venue.name || null, city: f.fixture.venue && f.fixture.venue.city || null },
      status: { short: f.fixture.status.short, elapsed: f.fixture.status.elapsed ?? null, extra: f.fixture.status.extra ?? null }
    },
    league: { id: f.league.id, name: f.league.name, country: f.league.country, logo: f.league.logo, round: f.league.round, season: f.league.season, rank: leagueRank(f.league) },
    teams: {
      home: { id: f.teams.home.id, name: f.teams.home.name, logo: f.teams.home.logo, winner: f.teams.home.winner },
      away: { id: f.teams.away.id, name: f.teams.away.name, logo: f.teams.away.logo, winner: f.teams.away.winner }
    },
    goals: f.goals,
    score: f.score
  };
}
function slimDetail(f) {
  const p = x => x ? { id: x.id ?? null, name: x.name ?? null } : { id: null, name: null };
  return {
    id: f.fixture.id,
    saved: new Date().toISOString(),
    fixture: slimFixture(f),
    events: (f.events || []).map(e => ({ time: { elapsed: e.time.elapsed, extra: e.time.extra ?? null }, team: { id: e.team && e.team.id }, player: p(e.player), assist: p(e.assist), type: e.type, detail: e.detail, comments: e.comments || null })),
    lineups: (f.lineups || []).map(l => ({
      team: { id: l.team.id, name: l.team.name, logo: l.team.logo, colors: l.team.colors || null },
      coach: { name: l.coach && l.coach.name || null },
      formation: l.formation || null,
      startXI: (l.startXI || []).map(x => ({ player: { id: x.player.id, name: x.player.name, number: x.player.number, pos: x.player.pos, grid: x.player.grid } })),
      substitutes: (l.substitutes || []).map(x => ({ player: { id: x.player.id, name: x.player.name, number: x.player.number, pos: x.player.pos, grid: null } }))
    })),
    statistics: (f.statistics || []).map(s => ({ team: { id: s.team.id }, statistics: s.statistics })),
    players: (f.players || []).map(t => ({
      team: { id: t.team.id, name: t.team.name, logo: t.team.logo },
      players: (t.players || []).map(x => {
        const s = (x.statistics && x.statistics[0]) || {};
        const g = s.games || {}, gl = s.goals || {};
        return { player: { id: x.player.id, name: x.player.name }, statistics: [{ games: { rating: g.rating ?? null, captain: !!g.captain, minutes: g.minutes ?? null, substitute: !!g.substitute }, goals: { total: gl.total ?? null, assists: gl.assists ?? null } }] };
      }).filter(x => x.statistics[0].games.minutes || x.statistics[0].games.rating)
    }))
  };
}
const isRich = d => (d.lineups && d.lineups.length) || (d.statistics && d.statistics.length);

/* ---------------- Hauptablauf ---------------- */
async function main() {
  const today = ymd(new Date());
  const hourBerlin = Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hour12: false }).format(new Date()));
  log(`Lauf: ${new Date().toISOString()} (Berlin ${today}, ${hourBerlin} Uhr) · Quelle: ${KEY ? "API-Football direkt" : WORKER}`);

  // Kontingent abfragen (zählt bei API-Football nicht mit)
  const st = await api("status", {}, { free: true });
  const req = st && st.requests ? st.requests : null;
  const limit = req ? req.limit_day : 100;
  const used = req ? req.current : 0;
  const pro = limit > 1000;
  const free = Math.max(0, limit - used - RESERVE);
  if (pro) budget = Math.min(free, 400);
  else {
    // Gratis-Plan: Abrufe über den Tag verteilen, damit abends (wenn die meisten Spiele enden) genug übrig ist.
    // Das Kontingent wird um 0 Uhr UTC zurückgesetzt. Anteile pro geplantem Lauf (UTC-Stunde):
    const SHARE = { 0: 10, 5: 10, 11: 6, 13: 6, 15: 8, 17: 12, 19: 14, 21: 14, 23: 16 };
    const h = new Date().getUTCHours();
    const keep = Object.entries(SHARE).filter(([hh]) => Number(hh) > h).reduce((s, [, v]) => s + v, 0);
    budget = Math.max(Math.min(free, SHARE[h] || 6), free - keep);
  }
  if (MAX_RUN) budget = Math.min(budget, MAX_RUN);
  log(`Kontingent: ${used}/${limit} verbraucht → dieser Lauf darf ${budget} Abrufe machen`);
  if (!st) log("  (Status nicht lesbar – rechne vorsichtig mit Gratis-Plan)");

  /* 1) Tageslisten aktualisieren: heute, gestern und alle gespeicherten Tage mit offenen Spielen */
  const dates = new Set([today]);
  if (hourBerlin < 10) dates.add(addDays(today, -1));
  for (let i = 1; i <= 7; i++) {
    const d = addDays(today, -i);
    const day = readJSON(dayFile(d), null);
    if (day && day.fixtures.some(f => !DONE.has(f.fixture.status.short) && !DONE_NODETAIL.has(f.fixture.status.short) && !DEAD.has(f.fixture.status.short))) dates.add(d);
  }
  const touched = new Set();
  for (const d of [...dates].sort().reverse()) {
    const list = await api("fixtures", { date: d, timezone: TZ });
    if (!list) break;
    const mine = list.filter(wanted).map(slimFixture);
    writeJSON(dayFile(d), { date: d, updated: new Date().toISOString(), fixtures: mine });
    touched.add(d);
    log(`Tag ${d}: ${mine.length} Spiele (${mine.filter(f => DONE.has(f.fixture.status.short)).length} beendet)`);
  }

  /* 2) Aufgabenliste: Details für beendete Spiele, Tabellen, alte Tage nachholen */
  const files = fs.existsSync(path.join(DATA, "tage")) ? fs.readdirSync(path.join(DATA, "tage")).filter(f => f.endsWith(".json")).map(f => f.slice(0, 10)).sort() : [];
  const pending = [];          // {id, date, score}
  const tablesNeeded = new Map(); // leagueId -> {league, season, lastMatchTs}
  const tables = readJSON(path.join(DATA, "tabellen", "_stand.json"), {});
  const now = Date.now();
  for (const d of files) {
    const day = readJSON(dayFile(d), null); if (!day) continue;
    const age = Math.round((Date.parse(today) - Date.parse(d)) / 864e5);
    for (const f of day.fixtures) {
      if (!DONE.has(f.fixture.status.short)) continue;
      if (now - f.fixture.timestamp * 1000 < 115 * 60e3) continue;   // frisch beendet → Daten noch nicht final, später
      const mf = matchFile(f.fixture.id, d);
      const have = readJSON(mf, null);
      let score = f.league.rank + Math.min(age, 60) * 40;
      if (have) {
        if (isRich(have) || age > 1 || have.retried) continue;          // schon komplett
        if (!pro && f.league.rank >= 500) continue;                    // Gratis-Plan: untere Ligen nicht nochmal
        score += 3000;                                                  // nur Grunddaten → später nochmal versuchen
      }
      pending.push({ id: f.fixture.id, date: d, score, retry: !!have });
      // Tabelle: Liga hatte ein beendetes Spiel nach der letzten Tabellen-Aktualisierung
      if (!CUPS.has(f.league.id)) {
        const t = tables[f.league.id];
        const ts = f.fixture.timestamp * 1000;
        if (!t || t.at < ts + 100 * 60e3) {
          const cur = tablesNeeded.get(f.league.id);
          if (!cur || cur.lastTs < ts) tablesNeeded.set(f.league.id, { league: f.league, season: f.league.season, lastTs: ts, age });
        }
      }
    }
    // auch Ligen ohne neue Spiele, die noch nie eine Tabelle hatten (nur aktuelle Woche)
  }
  pending.sort((a, b) => a.score - b.score);

  const tasks = [];
  // Details in Paketen à 20 Spiele, nach Wichtigkeit sortiert
  // Pro-Plan: 20 Spiele pro Abruf · Gratis-Plan: nur 1 Spiel pro Abruf (Sammelabruf gesperrt)
  const per = pro ? 20 : 1;
  for (let i = 0; i < pending.length; i += per) {
    const chunk = pending.slice(i, i + per);
    tasks.push({ kind: "details", score: chunk[0].score, chunk });
  }
  // Tabellen: wichtige Ligen fast gleich wichtig wie Details, untere deutsche Ligen später
  for (const [id, t] of tablesNeeded) {
    if (t.age > 3) continue;
    tasks.push({ kind: "table", score: t.league.rank + 15 + t.age * 40, id, t });
  }
  // Alte Spieltage nachholen (nur Liste; die Details kommen in späteren Läufen)
  const haveDays = new Set(files);
  const prevIx = readJSON(path.join(DATA, "index.json"), {});
  const minBack = !pro && prevIx.window ? addDays(today, -1) : BACKFILL_FROM;   // Gratis-Plan: nur gestern bis morgen erlaubt
  let back = addDays(today, -1), backCount = 0;
  while (back >= minBack && backCount < 3) {
    if (!haveDays.has(back)) { tasks.push({ kind: "backfill", score: 6000 + backCount, date: back }); backCount++; }
    back = addDays(back, -1);
  }
  tasks.sort((a, b) => a.score - b.score);
  log(`Offen: ${pending.length} Spiele ohne Details, ${tablesNeeded.size} Tabellen, ${backCount} alte Tage`);

  /* 3) Abarbeiten, solange Budget da ist */
  let gotDetails = 0, gotTables = 0, gotDays = 0;
  for (const t of tasks) {
    if (calls >= budget) break;
    if (t.kind === "backfill" && dateWindow && (t.date < dateWindow.from || t.date > dateWindow.to)) continue;
    if (t.kind === "details") {
      const ids = t.chunk.map(x => x.id);
      const r = await api("fixtures", ids.length > 1 ? { ids: ids.join("-"), timezone: TZ } : { id: ids[0], timezone: TZ });
      if (!r) { if (stopped) break; continue; }
      for (const f of r) {
        const m = t.chunk.find(x => x.id === f.fixture.id); if (!m) continue;
        const det = slimDetail(f);
        if (m.retry) det.retried = true;
        writeJSON(matchFile(f.fixture.id, m.date), det);
        touched.add(m.date);
        gotDetails++;
      }
    } else if (t.kind === "table") {
      const r = await api("standings", { league: t.id, season: t.t.season });
      if (!r) { if (stopped) break; continue; }
      const L = r[0] && r[0].league;
      if (!L) { tables[t.id] = { at: Date.now(), none: true }; continue; }
      const standings = (L.standings || []).map(g => g.map(x => ({
        rank: x.rank, team: { id: x.team.id, name: x.team.name, logo: x.team.logo }, points: x.points, goalsDiff: x.goalsDiff,
        group: x.group, form: x.form, description: x.description,
        all: { played: x.all.played, win: x.all.win, draw: x.all.draw, lose: x.all.lose, goals: x.all.goals }
      })));
      writeJSON(tableFile(t.id), { league: { id: L.id, name: L.name, country: L.country, logo: L.logo, season: L.season }, updated: new Date().toISOString(), standings });
      tables[t.id] = { at: Date.now(), name: L.name, season: L.season };
      gotTables++;
    } else if (t.kind === "backfill") {
      const list = await api("fixtures", { date: t.date, timezone: TZ });
      if (!list) { if (stopped) break; continue; }
      const mine = list.filter(wanted).map(slimFixture);
      writeJSON(dayFile(t.date), { date: t.date, updated: new Date().toISOString(), fixtures: mine });
      touched.add(t.date);
      gotDays++;
    }
  }
  writeJSON(path.join(DATA, "tabellen", "_stand.json"), tables);

  /* 4) Übersicht schreiben (welche Tage, wie viele Spiele, welche mit Details) */
  const all = fs.existsSync(path.join(DATA, "tage")) ? fs.readdirSync(path.join(DATA, "tage")).filter(f => f.endsWith(".json")).map(f => f.slice(0, 10)).sort() : [];
  const days = {};
  for (const d of all) {
    const day = readJSON(dayFile(d), null); if (!day) continue;
    let det = 0, fin = 0, changed = false;
    for (const f of day.fixtures) {
      if (DONE.has(f.fixture.status.short) || DONE_NODETAIL.has(f.fixture.status.short)) fin++;
      const ex = fs.existsSync(matchFile(f.fixture.id, d));
      if (ex) det++;
      if (!!f._d !== ex) { f._d = ex ? 1 : 0; changed = true; }
    }
    if (changed) writeJSON(dayFile(d), day);
    days[d] = { n: day.fixtures.length, f: fin, d: det };
  }
  const tableList = {};
  for (const [id, t] of Object.entries(tables)) if (!t.none && fs.existsSync(tableFile(id))) tableList[id] = { name: t.name, season: t.season, at: new Date(t.at).toISOString() };
  writeJSON(path.join(DATA, "index.json"), {
    updated: new Date().toISOString(),
    plan: { used: used + calls, limit, pro },
    days, tables: tableList, window: dateWindow || prevIx.window || null,
    lastRun: { calls, details: gotDetails, tables: gotTables, backfill: gotDays, open: Math.max(0, pending.length - gotDetails), note: stopped || null }
  });
  if (dateWindow) log(`Hinweis: Der Gratis-Plan erlaubt nur Tage von ${dateWindow.from} bis ${dateWindow.to}.`);
  log(`Fertig: ${calls} Abrufe · ${gotDetails} Spiele mit Details · ${gotTables} Tabellen · ${gotDays} alte Tage${stopped ? " · Stopp: " + stopped : ""}`);
}

main().catch(e => { console.error(e); LOGLINES.push("FEHLER: " + (e && e.stack || e)); process.exitCode = 1; })
  .finally(() => { try { writeJSON(path.join(DATA, "protokoll.json"), {at: new Date().toISOString(), lines: LOGLINES.slice(-200)}); } catch (e) {} });
