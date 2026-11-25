// Headless smoke test for site/assets/app.js — run with: deno run -A test/smoke.mjs
// Stubs a minimal DOM + fetch (served from site/data) and drives every route,
// asserting each view renders some HTML without throwing.

const ROOT = new URL("../site/", import.meta.url);
let FAIL = 0;
const ok = (c, m) => { console.log((c ? "  ok  " : "FAIL  ") + m); if (!c) FAIL++; };

/* ---- DOM shim ---- */
class El {
  constructor(tag = "div") { this.tag = tag; this._html = ""; this.children = []; this.dataset = {};
    this.style = {}; this.classList = { add() {}, remove() {}, toggle() {} }; this.hidden = false; }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = String(v); }
  get textContent() { return this._text || ""; }
  appendChild(c) { this.children.push(c); this._html += (c._html || "<node>"); return c; }
  addEventListener() {} removeEventListener() {} setAttribute() {} focus() {}
  querySelectorAll() { return []; }
  querySelector() { return new El(); }
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
  cloneNode() { const e = new El(); e._html = this._html; e.querySelectorAll = () => []; return e; }
  remove() {}
  get content() { return this; }
}
const ids = {};
const elById = id => (ids[id] ||= new El());
["view", "data-version", "foot-version", "foot-counts", "disclaimer", "disclaimer-ack",
 "global-search", "tpl-about"].forEach(elById);
elById("tpl-about")._html = "<div class='prose'>about</div>";

globalThis.document = {
  getElementById: elById,
  createElement: t => new El(t),
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  body: new El("body"),
  documentElement: { clientWidth: 1200 }
};
globalThis.window = { addEventListener() {}, scrollTo() {}, scrollX: 0, scrollY: 0,
  getComputedStyle: () => ({}) };
globalThis.location = { hash: "#/" };
globalThis.localStorage = { _s: {}, getItem(k) { return this._s[k] ?? null; },
  setItem(k, v) { this._s[k] = String(v); } };
globalThis.navigator = { clipboard: { writeText: async () => {} } };
globalThis.Blob = class { constructor(p) { this.parts = p; } };
globalThis.URL.createObjectURL = () => "blob:x";
globalThis.URL.revokeObjectURL = () => {};

globalThis.fetch = async (p) => {
  const path = String(p).replace(/^\.?\//, "");
  try {
    const txt = await Deno.readTextFile(new URL(path, ROOT));
    return { ok: true, status: 200, json: async () => JSON.parse(txt) };
  } catch (e) {
    return { ok: false, status: 404, json: async () => { throw e; } };
  }
};

let LAST_TABLE = null;
globalThis.Tabulator = class {
  constructor(sel, cfg) { this.sel = sel; this.cfg = cfg; LAST_TABLE = this;
    // exercise every column formatter/sorter against the first few rows
    const rows = (cfg.data || []).slice(0, 5);
    for (const col of cfg.columns) {
      for (const r of rows) {
        const cell = { getValue: () => r[col.field], getRow: () => ({ getData: () => r }) };
        if (col.formatter) col.formatter(cell);
        if (col.sorter && rows.length > 1) {
          const rc = x => ({ getData: () => x });
          col.sorter(r[col.field], rows[0][col.field], rc(r), rc(rows[0]));
        }
      }
    }
  }
  destroy() {} setData() {} on() {}
};

/* ---- load app.js with internals exposed ---- */
let src = await Deno.readTextFile(new URL("assets/app.js", ROOT));
src = src.replace(/\bboot\(\);\s*$/, "");
src += `\nglobalThis.__app = { boot, route, renderHome, renderSearch, renderDetail, renderAbout,
  filterMutations, parseHash, DATA };`;
const mod = "data:application/javascript;base64," + btoa(unescape(encodeURIComponent(src)));
await import(mod);
const A = globalThis.__app;

/* ---- run ---- */
await A.boot();
ok(A.DATA.meta && A.DATA.mutations.length > 1000, `boot loaded ${A.DATA.mutations.length} mutations`);
ok(A.DATA.genes.length === 6, `6 curated genes (${A.DATA.genes.length})`);
ok(!A.DATA.genes.some(g => g.gene === "UL44" || g.gene === "UL104"), "UL44 / UL104 excluded");
ok(!A.DATA.mutations.some(m => /UL(44|104)_/.test(m.gene_mutation)), "no UL44 / UL104 mutations");

A.renderHome();
ok(elById("view").innerHTML.includes("resistance"), "home renders");

for (const hash of [
  "#/search?mode=phenotype",
  "#/search?mode=phenotype&gene=UL54&level=Medium,High&combos=include",
  "#/search?mode=phenotype&q=594",
  "#/search?mode=patient",
  "#/search?mode=patient&gene=UL97&population=HSCT&ymin=2015",
]) {
  location.hash = hash;
  const { params } = A.parseHash();
  try { A.renderSearch(params); ok(LAST_TABLE && LAST_TABLE.cfg.data.length >= 0,
    `search ${hash} -> ${LAST_TABLE.cfg.data.length} rows`); }
  catch (e) { ok(false, `search ${hash}: ${e.message}\n${e.stack}`); }
}

// filter sanity
const pheno = A.filterMutations("phenotype", { q: "", gene: "UL97", level: [], tier: "", combos: "exclude" });
ok(pheno.every(m => m.gene === "UL97" && !m.is_combination), `UL97 phenotype filter (${pheno.length})`);
const codon = A.filterMutations("phenotype", { q: "594", gene: "", level: [], tier: "", combos: "exclude" });
ok(codon.some(m => m.gene_mutation === "UL97_A594V") &&
   codon.every(m => (m.gene_mutation.match(/\d+/g) || []).map(Number).includes(594) ||
                    /DEL(\d+)-(\d+)/i.test(m.gene_mutation)),
  `codon 594 search (${codon.length})`);

for (const gm of ["UL97_A594V", "UL54_A594V", "UL27_A406V/UL27_C415*", "UL44_NOPE" ]) {
  try {
    await A.renderDetail(gm);
    await new Promise(r => setTimeout(r, 30));
    const h = elById("view").innerHTML;
    ok(h.length > 50, `detail ${gm} renders (${h.length} chars)`);
  } catch (e) { ok(false, `detail ${gm}: ${e.message}\n${e.stack}`); }
}

// a mutation with patient reports renders the patient section + filters
const pat = A.DATA.mutations.find(m => m.gene === "UL97" && m.seen_in_patients && m.n_patient_records > 5);
if (pat) {
  await A.renderDetail(pat.gene_mutation);
  await new Promise(r => setTimeout(r, 30));
  ok(elById("view").innerHTML.includes("report"), `patient section ${pat.gene_mutation}`);
}

A.renderAbout();
ok(true, "about renders");

if (Deno.env.get("DUMP")) {
  const D = Deno.env.get("DUMP");
  A.renderHome();
  await Deno.writeTextFile(D + "/render-home.html", elById("view").innerHTML);
  location.hash = "#/search?mode=phenotype&gene=UL97";
  A.renderSearch(A.parseHash().params);
  await Deno.writeTextFile(D + "/render-search.html", elById("view").innerHTML);
  await A.renderDetail("UL97_A594V");
  await new Promise(r => setTimeout(r, 50));
  await Deno.writeTextFile(D + "/render-detail.html", elById("view").innerHTML);
  location.hash = "#/search?mode=patient&gene=UL97";
  A.renderSearch(A.parseHash().params);
  await Deno.writeTextFile(D + "/render-search-patient.html", elById("view").innerHTML);
}

console.log(FAIL ? `\n${FAIL} FAILURES` : "\nALL PASS");
Deno.exit(FAIL ? 1 : 0);
