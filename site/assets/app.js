/* CMV Antiviral Resistance Database — static single-page app.
   All data is pre-built JSON in ./data/; all filtering is client-side. */
"use strict";

const DATA = { meta: null, genes: [], mutations: [], byGm: new Map(),
               pheno: null, phenoStudies: null, studies: null, bibtex: null,
               patients: {} };
const DRUG_ABBR = { Ganciclovir: "GCV", Cidofovir: "CDV", Foscarnet: "FOS",
                    Letermovir: "LMV", Maribavir: "MBV" };
const TIER_LABEL = { "meta-analysed": "meta-analysed", "geometric-mean": "geometric mean",
                     "single-value": "single study" };
const view = () => document.getElementById("view");

/* ---------- helpers ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const arr = x => Array.isArray(x) ? x : (x == null ? [] : [x]);
const geneOf = gm => (gm.match(/^(UL\d+)_/) || [])[1] || null;
function matchesCodon(gm, codon) {
  const c = +codon;
  return gm.split("/").some(tok => {
    const body = tok.replace(/^UL\d+_/, "");
    const nums = (body.match(/\d+/g) || []).map(Number);
    if (/^DEL\d+-\d+$/i.test(body)) return c >= nums[0] && c <= nums[1];
    return nums.includes(c);
  });
}
const num = (n, d = 2) => (n == null || isNaN(n)) ? "—" : Number(n).toFixed(d).replace(/\.?0+$/, "");
const spinner = (msg = "Loading…") => `<div class="spinner">${esc(msg)}</div>`;

function levelChip(level, { muted = false } = {}) {
  const l = level || "Unknown";
  return `<span class="chip chip--${l}${muted ? " chip--muted" : ""}">${l}</span>`;
}
async function getJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
async function ensure(key, path) {
  if (DATA[key] == null) DATA[key] = await getJSON(path);
  return DATA[key];
}
async function ensurePatients(gene) {
  if (!DATA.patients[gene]) {
    try { DATA.patients[gene] = await getJSON(`data/patients/${gene}.json`); }
    catch { DATA.patients[gene] = {}; }
  }
  return DATA.patients[gene];
}

/* ---------- boot ---------- */
async function boot() {
  try {
    const [meta, genes, mutations] = await Promise.all([
      getJSON("data/meta.json"), getJSON("data/genes.json"), getJSON("data/mutations.json")
    ]);
    DATA.meta = meta; DATA.genes = genes; DATA.mutations = mutations;
    mutations.forEach(m => DATA.byGm.set(m.gene_mutation, m));

    document.getElementById("data-version").textContent = "data " + meta.data_version;
    document.getElementById("foot-version").textContent = meta.data_version;
    document.getElementById("foot-counts").textContent =
      `${meta.counts.single_mutations} mutations · ${meta.counts.studies} studies`;

    setupDisclaimer();
    setupGlobalSearch();
    window.addEventListener("hashchange", route);
    route();
  } catch (e) {
    view().innerHTML = `<div class="empty">Could not load the database.<br><span class="small">${esc(e.message)}</span></div>`;
  }
}

function setupDisclaimer() {
  let ok = false;
  try { ok = localStorage.getItem("cmv-disclaimer-ack") === "1"; } catch {}
  const bar = document.getElementById("disclaimer");
  if (!ok) bar.hidden = false;
  document.getElementById("disclaimer-ack").onclick = () => {
    bar.hidden = true;
    try { localStorage.setItem("cmv-disclaimer-ack", "1"); } catch {}
  };
}

function setupGlobalSearch() {
  const inp = document.getElementById("global-search");
  inp.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    const q = inp.value.trim();
    const cur = parseHash();
    const mode = cur.params.get("mode") || "phenotype";
    location.hash = `#/search?mode=${mode}&q=${encodeURIComponent(q)}`;
  });
}

/* ---------- router ---------- */
function parseHash() {
  const h = location.hash.replace(/^#\/?/, "");
  const [path, qs] = h.split("?");
  return { parts: path.split("/").filter(Boolean), params: new URLSearchParams(qs || "") };
}
function setActiveNav(name) {
  document.querySelectorAll("header nav a").forEach(a =>
    a.classList.toggle("active", a.dataset.route === name));
}
function route() {
  const { parts, params } = parseHash();
  window.scrollTo(0, 0);
  if (parts[0] === "mutation" && parts[1]) { setActiveNav("search"); return renderDetail(decodeURIComponent(parts.slice(1).join("/"))); }
  if (parts[0] === "search") { setActiveNav("search"); return renderSearch(params); }
  if (parts[0] === "about") { setActiveNav("about"); return renderAbout(); }
  setActiveNav("home"); renderHome();
}

/* ---------- home: gene summary ---------- */
function renderHome() {
  const m = DATA.meta;
  const link = (gene, mode, extra = "") =>
    `#/search?mode=${mode}&gene=${gene}${extra}`;
  const rows = DATA.genes.map(g => `
    <tr>
      <td>
        <a class="gene-name" href="${link(g.gene, "phenotype")}">${esc(g.gene)}</a>
        <div class="small muted">${esc(g.protein)}</div>
      </td>
      <td class="small">${esc(g.function)}</td>
      <td>${(g.target_drugs || "").split(";").filter(Boolean)
            .map(d => `<span class="chip tag">${esc(d.trim())}</span>`).join(" ") || "<span class='muted'>—</span>"}</td>
      <td class="num"><a class="count-link" href="${link(g.gene, "phenotype", "&level=Low,Medium,High")}">${g.n_resistance}</a></td>
      <td class="num"><a class="count-link" href="${link(g.gene, "phenotype")}">${g.n_phenotyped}</a></td>
      <td class="num"><a class="count-link" href="${link(g.gene, "patient")}">${g.n_in_patients}</a></td>
    </tr>`).join("");
  const totalCombo = DATA.genes.reduce((s, g) => s + (g.n_combo || 0), 0);

  view().innerHTML = `
    <h1>CMV antiviral-resistance mutations by gene</h1>
    <p class="page-intro">Phenotype meta-analysis and patient reports for cytomegalovirus
      antiviral-resistance mutations. Choose a gene to browse, use the search box above, or
      go straight to <a href="#/search">Search</a>. Counts below cover single mutations;
      ${totalCombo} phenotyped mutation combinations are held separately.</p>
    <table class="grid">
      <thead><tr>
        <th>Gene</th><th>Function</th><th>Target drugs</th>
        <th class="num">Resistance<br>mutations</th>
        <th class="num">Phenotype<br>characterised</th>
        <th class="num">Seen in<br>patients</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="small muted" style="margin-top:14px">
      <strong>Resistance mutations</strong>: distinct single mutations rated Low, Medium or High for
      at least one drug. Data version ${esc(m.data_version)}.</p>`;
}

/* ---------- search ---------- */
const FACET = {
  population: "populations", transplant: "transplant_types",
  age: "age_groups", disease: "cmv_diseases"
};
function uniqueFacet(field) {
  const s = new Set();
  DATA.mutations.forEach(m => arr(m[field]).forEach(v => s.add(v)));
  return [...s].sort();
}

function renderSearch(params) {
  const mode = params.get("mode") === "patient" ? "patient" : "phenotype";
  const f = {
    gene: params.get("gene") || "",
    q: params.get("q") || "",
    drug: params.get("drug") || "",
    level: (params.get("level") || "").split(",").filter(Boolean),
    tier: params.get("tier") || "",
    combos: params.get("combos") || "exclude",
    population: params.get("population") || "",
    transplant: params.get("transplant") || "",
    age: params.get("age") || "",
    disease: params.get("disease") || "",
    ymin: params.get("ymin") || "",
    ymax: params.get("ymax") || ""
  };
  const genesList = DATA.genes.map(g => g.gene);

  const opt = (val, cur) => `<option value="${esc(val)}"${val === cur ? " selected" : ""}>${esc(val || "Any")}</option>`;
  const sel = (id, cur, vals, label) => `
    <label class="field">${label}
      <select id="flt-${id}">${["", ...vals].map(v => opt(v, cur)).join("")}</select>
    </label>`;

  const commonFilters = `
    ${sel("gene", f.gene, genesList, "Gene")}
    <label class="field">Mutation / codon
      <input id="flt-q" type="search" value="${esc(f.q)}" placeholder="A594V or 594">
    </label>`;

  const phenoFilters = `
    ${sel("drug", f.drug, DATA.meta.drugs, "Drug")}
    <label class="field">Resistance level
      <select id="flt-level" multiple size="4">
        ${["Susceptible", "Low", "Medium", "High"].map(v =>
          `<option value="${v}"${f.level.includes(v) ? " selected" : ""}>${v}</option>`).join("")}
      </select>
    </label>
    ${sel("tier", f.tier, ["meta-analysed", "geometric-mean", "single-value"], "Evidence tier")}
    <label class="field">Combinations
      <select id="flt-combos">
        <option value="exclude"${f.combos === "exclude" ? " selected" : ""}>Exclude</option>
        <option value="include"${f.combos === "include" ? " selected" : ""}>Include</option>
        <option value="only"${f.combos === "only" ? " selected" : ""}>Only combinations</option>
      </select>
    </label>`;

  const patientFilters = `
    ${sel("population", f.population, uniqueFacet("populations"), "Population")}
    ${sel("transplant", f.transplant, uniqueFacet("transplant_types"), "Transplant type")}
    ${sel("age", f.age, uniqueFacet("age_groups"), "Age group")}
    ${sel("disease", f.disease, uniqueFacet("cmv_diseases"), "CMV disease")}
    <label class="field yr">Year from
      <input id="flt-ymin" type="number" min="1980" max="2100" value="${esc(f.ymin)}"></label>
    <label class="field yr">Year to
      <input id="flt-ymax" type="number" min="1980" max="2100" value="${esc(f.ymax)}"></label>`;

  view().innerHTML = `
    <div class="crumb"><a href="#/">Home</a> / Search</div>
    <div class="toolbar">
      <div class="mode-toggle" role="tablist">
        <button id="mode-phenotype" class="${mode === "phenotype" ? "on" : ""}">Phenotype</button>
        <button id="mode-patient" class="${mode === "patient" ? "on" : ""}">Patient reports</button>
      </div>
      <div class="filters">
        ${commonFilters}
        ${mode === "phenotype" ? phenoFilters : patientFilters}
        <div class="filter-actions">
          <button class="btn primary" id="apply">Apply</button>
          <button class="btn" id="clear">Clear</button>
        </div>
      </div>
    </div>
    <div class="result-meta">
      <span id="result-count" class="small muted"></span>
      <button class="btn small" id="dl-csv" style="margin-left:auto">Download CSV</button>
    </div>
    <div id="results"></div>`;

  document.getElementById("mode-phenotype").onclick = () => location.hash = `#/search?mode=phenotype`;
  document.getElementById("mode-patient").onclick = () => location.hash = `#/search?mode=patient`;
  document.getElementById("clear").onclick = () => location.hash = `#/search?mode=${mode}`;
  document.getElementById("apply").onclick = () => applySearch(mode);
  view().querySelectorAll("#flt-q, #flt-ymin, #flt-ymax").forEach(el =>
    el.addEventListener("keydown", e => { if (e.key === "Enter") applySearch(mode); }));

  buildResultsTable(mode, f);
}

function applySearch(mode) {
  const g = id => { const el = document.getElementById(id); return el ? el.value.trim() : ""; };
  const p = new URLSearchParams();
  p.set("mode", mode);
  const put = (k, v) => { if (v) p.set(k, v); };
  put("gene", g("flt-gene"));
  put("q", g("flt-q"));
  if (mode === "phenotype") {
    put("drug", g("flt-drug"));
    const lv = [...(document.getElementById("flt-level")?.selectedOptions || [])].map(o => o.value);
    if (lv.length) p.set("level", lv.join(","));
    put("tier", g("flt-tier"));
    const combos = g("flt-combos");
    if (combos && combos !== "exclude") p.set("combos", combos);
  } else {
    put("population", g("flt-population"));
    put("transplant", g("flt-transplant"));
    put("age", g("flt-age"));
    put("disease", g("flt-disease"));
    put("ymin", g("flt-ymin"));
    put("ymax", g("flt-ymax"));
  }
  location.hash = "#/search?" + p.toString();
}

function filterMutations(mode, f) {
  const q = f.q.toLowerCase();
  const codon = /^\d+$/.test(f.q) ? f.q : null;
  return DATA.mutations.filter(m => {
    if (mode === "phenotype") {
      if (f.combos === "exclude" && m.is_combination) return false;
      if (f.combos === "only" && !m.is_combination) return false;
      if (!m.phenotype_characterised) return false;
    } else {
      if (!m.seen_in_patients) return false;
    }
    if (f.gene && !String(m.gene).split(/;\s*/).includes(f.gene)) return false;
    if (q) {
      if (codon) { if (!matchesCodon(m.gene_mutation, codon)) return false; }
      else if (!(m.gene_mutation + " " + m.display_change).toLowerCase().includes(q)) return false;
    }
    if (mode === "phenotype") {
      let ds = m.drug_summary;
      if (f.drug) ds = ds.filter(d => d.drug === f.drug);
      if (f.level.length && !ds.some(d => f.level.includes(d.level))) return false;
      if (f.tier && !ds.some(d => d.tier === f.tier)) return false;
    } else {
      for (const [key, field] of Object.entries(FACET)) {
        if (f[key] && !arr(m[field]).includes(f[key])) return false;
      }
      if (f.ymin && !(m.year_max == null || m.year_max >= +f.ymin)) return false;
      if (f.ymax && !(m.year_min == null || m.year_min <= +f.ymax)) return false;
    }
    return true;
  });
}

let TABLE = null;
function buildResultsTable(mode, f) {
  const rows = filterMutations(mode, f);
  document.getElementById("result-count").textContent =
    `${rows.length} mutation${rows.length === 1 ? "" : "s"}`;

  const mutCol = {
    title: "Mutation", field: "display_change", widthGrow: 2, minWidth: 150,
    formatter: c => {
      const m = c.getRow().getData();
      const tag = m.is_combination ? ` <span class="tier-badge">combination</span>` : "";
      return `<a href="#/mutation/${encodeURIComponent(m.gene_mutation)}">${esc(m.gene)} ${esc(m.display_change)}</a>${tag}`;
    }
  };
  let cols;
  if (mode === "phenotype") {
    const drugCol = drug => ({
      title: DRUG_ABBR[drug], field: "d_" + drug, hozAlign: "center", width: 90, headerSort: true,
      formatter: c => {
        const d = c.getRow().getData().drug_summary.find(x => x.drug === drug);
        if (!d || d.level === "Unknown") return `<span class="chip chip--Unknown">—</span>`;
        const muted = d.tier === "single-value";
        return levelChip(d.level, { muted });
      },
      sorter: (a, b, ar, br) => {
        const order = { Unknown: 0, Susceptible: 1, Low: 2, Medium: 3, High: 4 };
        const g = r => order[(r.drug_summary.find(x => x.drug === drug) || {}).level || "Unknown"];
        return g(ar.getData()) - g(br.getData());
      }
    });
    cols = [
      mutCol,
      { title: "Type", field: "variant_type", width: 120 },
      ...DATA.meta.drugs.map(drugCol),
      { title: "Patient studies", field: "n_patient_studies", hozAlign: "right", width: 90 }
    ];
  } else {
    cols = [
      mutCol,
      { title: "Type", field: "variant_type", width: 110 },
      { title: "Studies", field: "n_patient_studies", hozAlign: "right", width: 80 },
      { title: "Reports", field: "n_patient_records", hozAlign: "right", width: 80 },
      { title: "Populations", field: "populations", widthGrow: 2, minWidth: 140,
        formatter: c => arr(c.getValue()).map(v => `<span class="chip tag">${esc(v)}</span>`).join(" ") },
      { title: "Transplant type", field: "transplant_types", widthGrow: 2, minWidth: 140,
        formatter: c => arr(c.getValue()).map(v => `<span class="chip tag">${esc(v)}</span>`).join(" ") || "<span class='muted'>—</span>" }
    ];
  }

  if (TABLE) { try { TABLE.destroy(); } catch {} }
  TABLE = new Tabulator("#results", {
    data: rows, columns: cols, layout: "fitColumns",
    pagination: true, paginationSize: 50, paginationSizeSelector: [25, 50, 100, 250],
    placeholder: "No mutations match these filters.",
    initialSort: [{ column: "display_change", dir: "asc" }]
  });

  document.getElementById("dl-csv").onclick = () => {
    const flat = rows.map(m => {
      const base = {
        gene: m.gene, mutation: m.display_change, gene_mutation: m.gene_mutation,
        variant_type: m.variant_type, is_combination: m.is_combination,
        patient_studies: m.n_patient_studies, patient_reports: m.n_patient_records
      };
      if (mode === "phenotype") DATA.meta.drugs.forEach(d => {
        const x = m.drug_summary.find(y => y.drug === d) || {};
        base[d] = x.level || "Unknown";
        base[d + "_ec50_ratio"] = x.ec50_ratio ?? "";
      });
      else {
        base.populations = arr(m.populations).join("; ");
        base.transplant_types = arr(m.transplant_types).join("; ");
      }
      return base;
    });
    downloadCSV(flat, `cmv-${mode}-search.csv`);
  };
}

function downloadCSV(rows, filename) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const cell = v => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...rows.map(r => cols.map(c => cell(r[c])).join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ---------- mutation detail ---------- */
async function renderDetail(gm) {
  const m = DATA.byGm.get(gm);
  if (!m) { view().innerHTML = `<div class="empty">Unknown mutation: <code>${esc(gm)}</code></div>`; return; }
  view().innerHTML = `
    <div class="crumb"><a href="#/">Home</a> / <a href="#/search?mode=phenotype&gene=${esc(m.gene)}">${esc(m.gene)}</a> / ${esc(m.display_change)}</div>
    <div class="detail-head">
      <span class="mut">${esc(m.gene)} ${esc(m.display_change)}</span>
      <span class="gene-tag">${esc(geneProtein(m.gene))}</span>
    </div>
    <div class="kv">
      <span><b>Type:</b> ${esc(m.variant_type)}</span>
      <span><b>Worst level:</b> ${levelChip(m.worst_level)}</span>
      <span><b>Phenotype:</b> ${m.phenotype_characterised ? "characterised" : "not characterised"}</span>
      <span><b>Patient reports:</b> ${m.n_patient_records} across ${m.n_patient_studies} stud${m.n_patient_studies === 1 ? "y" : "ies"}</span>
    </div>
    <div id="d-pheno">${spinner("Loading phenotype data…")}</div>
    <div id="d-patient">${spinner("Loading patient reports…")}</div>`;

  renderPhenoSection(m).catch(e => document.getElementById("d-pheno").innerHTML =
    `<div class="empty">Phenotype data failed to load: ${esc(e.message)}</div>`);
  renderPatientSection(m).catch(e => document.getElementById("d-patient").innerHTML =
    `<div class="empty">Patient data failed to load: ${esc(e.message)}</div>`);
}

function geneProtein(gene) {
  const parts = String(gene).split(/;\s*/);
  return parts.map(g => (DATA.genes.find(x => x.gene === g) || {}).protein || g).join("; ");
}

async function renderPhenoSection(m) {
  const el = document.getElementById("d-pheno");
  if (!m.phenotype_characterised) {
    el.innerHTML = `<div class="section-card dim"><h2>Phenotype</h2>
      <p class="muted">No recombinant-phenotyping data for this mutation.
      ${m.in_combinations && m.in_combinations.length ? "" : "It appears only in patient reports."}</p>
      ${combosBlock(m)}</div>`;
    return;
  }
  const [pheno, pstudies] = await Promise.all([
    ensure("pheno", "data/phenotype_overall.json"),
    ensure("phenoStudies", "data/phenotype_studies.json")
  ]);
  await ensure("studies", "data/studies.json");
  const overall = pheno[m.gene_mutation] || [];
  const studies = pstudies[m.gene_mutation] || [];
  const order = { Ganciclovir: 0, Cidofovir: 1, Foscarnet: 2, Letermovir: 3, Maribavir: 4 };
  overall.sort((a, b) => order[a.drug] - order[b.drug]);

  const blocks = overall.map(o => {
    const s = studies.filter(x => x.drug === o.drug);
    const tier = TIER_LABEL[o.tier] || o.tier;
    let stat;
    if (o.tier === "meta-analysed") {
      const ns = arr(o.bibtex_meta).length || o.n_studies;
      stat = `pooled EC<sub>50</sub> ratio <b>${num(o.ec50_ratio)}</b>
        (95% CI ${num(o.ci_lb)}–${num(o.ci_ub)}); ${o.k} value${o.k === 1 ? "" : "s"} from ${ns} stud${ns === 1 ? "y" : "ies"}; I² ${num(o.i2, 0)}%`;
    } else if (o.tier === "geometric-mean") {
      stat = `geometric-mean EC<sub>50</sub> ratio <b>${num(o.ec50_ratio)}</b> from ${o.n_vals} values (${o.n_studies} stud${o.n_studies === 1 ? "y" : "ies"}); no confidence interval`;
    } else {
      stat = `single reported EC<sub>50</sub> ratio <b>${num(o.ec50_ratio)}</b>`;
    }
    const cites = arr(o.bibtex_meta).length ? arr(o.bibtex_meta) : arr(o.bibtex_geo);
    return `
      <div class="drug-block">
        <div class="drug-head">
          <span class="dname">${esc(o.drug)}</span>
          ${levelChip(o.level, { muted: o.tier === "single-value" })}
          <span class="tier-badge">${esc(tier)}</span>
        </div>
        <div class="stat-line">${stat}</div>
        ${o.tier === "meta-analysed" ? ciPlot(o, s) : ""}
        ${cites.length ? `<div class="small muted">Sources: ${cites.map(refSpan).join(", ")}</div>` : ""}
        ${s.length ? studyTable(s) : ""}
      </div>`;
  }).join("");

  el.innerHTML = `<div class="section-card">
    <h2>Phenotype</h2>
    ${blocks || "<p class='muted'>No per-drug phenotype rows.</p>"}
    ${combosBlock(m)}
  </div>`;
  wireRefs(el);
}

function combosBlock(m) {
  const combos = arr(m.in_combinations);
  if (!combos.length) return "";
  return `<div class="drug-block">
    <h3>Also characterised in combination</h3>
    <div class="comutations">
      ${combos.map(c => {
        const cm = DATA.byGm.get(c);
        const label = cm ? `${cm.gene} ${cm.display_change}` : c;
        return `<a class="chip tag" href="#/mutation/${encodeURIComponent(c)}">${esc(label)}</a>`;
      }).join(" ")}
    </div>
    <p class="small muted">Effects of a combination are not attributed to any single component.</p>
  </div>`;
}

function studyTable(rows) {
  const tr = rows.map(r => `<tr>
    <td>${refSpan(r.bibtexkey)}</td>
    <td>${esc(r.assay || "—")}</td>
    <td>${esc(r.cell_type || "—")}</td>
    <td>${esc(r.reference_strain || "—")}</td>
    <td>${r.wt_ec50 == null ? "—" : num(r.wt_ec50)}${r.wt_sd != null ? " ± " + num(r.wt_sd) : ""}</td>
    <td>${r.mut_ec50 == null ? "—" : num(r.mut_ec50)}${r.mut_sd != null ? " ± " + num(r.mut_sd) : ""}</td>
    <td><b>${num(r.ec50_ratio ?? r.ec50_ratio_calc)}</b></td>
    <td>${r.in_meta ? "yes" : "no"}</td>
  </tr>`).join("");
  return `<details style="margin-top:8px"><summary class="small muted">${rows.length} individual assay${rows.length === 1 ? "" : "s"}</summary>
    <table class="pt-table" style="margin-top:6px">
      <thead><tr><th>Study</th><th>Assay</th><th>Cells</th><th>Strain</th><th>WT EC₅₀</th><th>Mut EC₅₀</th><th>Ratio</th><th>In meta</th></tr></thead>
      <tbody>${tr}</tbody></table></details>`;
}

/* pooled point + 95% CI on a log axis, scaled to this mutation's own data,
   with the individual study ratios overlaid and a labelled x-axis. */
function ciPlot(o, studies) {
  if (!(o.ec50_ratio > 0)) return "";
  const studyVals = studies
    .map(s => s.ec50_ratio ?? s.ec50_ratio_calc)
    .filter(v => v != null && v > 0);
  const pts = [o.ec50_ratio, o.ci_lb, o.ci_ub, ...studyVals].filter(v => v != null && v > 0);
  if (pts.length < 2) return "";

  let lo = Math.min(...pts), hi = Math.max(...pts);
  const pad = (Math.log10(hi) - Math.log10(lo)) * 0.18 || 0.3;   // ~18% each side
  lo = Math.pow(10, Math.log10(lo) - pad);
  hi = Math.pow(10, Math.log10(hi) + pad);

  const W = 600, H = 104, padL = 48, padR = 48, axisY = 46;
  const x = v => +(padL + (Math.log10(v) - Math.log10(lo)) /
    (Math.log10(hi) - Math.log10(lo)) * (W - padL - padR)).toFixed(1);

  const cand = [0.2, 0.3, 0.5, 0.7, 1, 1.5, 2, 3, 4, 5, 7, 10, 15, 20, 30, 50, 70,
                100, 150, 200, 300, 500, 700, 1000, 1500, 2000];
  let ticks = cand.filter(t => t >= lo && t <= hi);
  if (ticks.length > 7) { const k = Math.ceil(ticks.length / 7); ticks = ticks.filter((_, i) => i % k === 0); }
  if (ticks.length < 3) {                              // range too narrow for the grid — space our own
    const r = hi / lo;
    ticks = [0, 0.25, 0.5, 0.75, 1].map(f => lo * Math.pow(r, f));
    ticks = [...new Set(ticks.map(v => v >= 10 ? Math.round(v) : +v.toPrecision(2)))];
  }
  const tlab = v => (v >= 10 ? Math.round(v) : +v.toPrecision(2)) + "×";
  const thr = [[2, "Low"], [5, "Med"], [15, "High"]].filter(([t]) => t > lo && t < hi);

  const cx = x(o.ec50_ratio);
  return `<svg class="ciplot" viewBox="0 0 ${W} ${H}" role="img"
    aria-label="Pooled EC50 ratio ${num(o.ec50_ratio)}×, 95% CI ${num(o.ci_lb)}× to ${num(o.ci_ub)}×">
    ${thr.map(([t, lab]) => `
      <line class="thr" x1="${x(t)}" y1="18" x2="${x(t)}" y2="${axisY}"/>
      <text class="thr-lab" x="${x(t)}" y="14" text-anchor="middle">${lab}</text>`).join("")}
    <line class="axis" x1="${padL}" y1="${axisY}" x2="${W - padR}" y2="${axisY}"/>
    ${ticks.map(t => `
      <line class="axis" x1="${x(t)}" y1="${axisY}" x2="${x(t)}" y2="${axisY + 5}"/>
      <text class="tick-lab" x="${x(t)}" y="${axisY + 18}" text-anchor="middle">${tlab(t)}</text>`).join("")}
    ${o.ci_lb != null && o.ci_ub != null ? `
      <line class="pooled" stroke-width="3" x1="${x(o.ci_lb)}" y1="${axisY}" x2="${x(o.ci_ub)}" y2="${axisY}"/>
      <line class="pooled" stroke-width="1.5" x1="${x(o.ci_lb)}" y1="${axisY - 5}" x2="${x(o.ci_lb)}" y2="${axisY + 5}"/>
      <line class="pooled" stroke-width="1.5" x1="${x(o.ci_ub)}" y1="${axisY - 5}" x2="${x(o.ci_ub)}" y2="${axisY + 5}"/>` : ""}
    ${studyVals.map(v => `<circle class="study-pt" cx="${x(v)}" cy="${axisY}" r="3"/>`).join("")}
    <circle class="pooled-pt" cx="${cx}" cy="${axisY}" r="4.5"/>
    <text class="pooled-lab" x="${cx}" y="${axisY - 10}" text-anchor="middle">${num(o.ec50_ratio)}×</text>
    <text class="cap-lab" x="${W / 2}" y="${H - 6}" text-anchor="middle">EC₅₀ ratio vs wild-type (log scale) — ● pooled, ○ individual studies</text>
  </svg>`;
}

const TRANSPLANT_ECHO = new Set(["SCT", "SOT", "HIV", "Congenital CMV", "Other"]);
const splitMulti = v => String(v ?? "").split(/;\s*/).map(s => s.trim()).filter(Boolean);

async function renderPatientSection(m) {
  const el = document.getElementById("d-patient");
  const gene = geneOf(m.gene_mutation) || String(m.gene).split(/;\s*/)[0];
  const [pdata] = await Promise.all([ensurePatients(gene), ensure("studies", "data/studies.json")]);
  const all = (pdata[m.gene_mutation] || []).slice();
  if (!all.length) {
    el.innerHTML = `<div class="section-card dim"><h2>Patient reports</h2>
      <p class="muted">This mutation has not been reported in a patient in the included studies.</p></div>`;
    return;
  }
  all.sort((a, b) => (a.year || 0) - (b.year || 0) || a.bibtexkey.localeCompare(b.bibtexkey));

  // filter fields — only offered when they actually vary within these reports
  const FIELDS = [
    { id: "population", label: "Population", get: r => [r.population] },
    { id: "transplant", label: "Transplant type",
      get: r => splitMulti(r.specific_type).filter(v => !TRANSPLANT_ECHO.has(v)) },
    { id: "age", label: "Age group", get: r => [r.age_group] },
    { id: "disease", label: "CMV disease", get: r => splitMulti(r.cmv_disease) }
  ].map(f => {
    const opts = [...new Set(all.flatMap(f.get).filter(v => v && v !== "Unknown"))].sort();
    return { ...f, opts };
  }).filter(f => f.opts.length > 1);

  const state = {};
  const apply = () => all.filter(r => FIELDS.every(f => {
    const want = state[f.id];
    return !want || f.get(r).includes(want);
  }));

  el.innerHTML = `<div class="section-card">
    <h2>Patient reports</h2>
    <div class="callout">Patients often carry several mutations at once, and a mutation's presence
      in a patient with a poor outcome is <strong>not</strong> evidence that it caused the outcome.
      Every mutation reported for each patient is listed below — and not every mutation present in a
      patient is necessarily reported by the original study.</div>
    ${FIELDS.length ? `<div class="pt-filters">
      ${FIELDS.map(f => `<label class="field">${f.label}
        <select data-flt="${f.id}"><option value="">Any</option>
        ${f.opts.map(v => `<option>${esc(v)}</option>`).join("")}</select></label>`).join("")}
      <button class="btn small" id="pt-clear">Clear</button>
    </div>` : ""}
    <p class="small muted" id="pt-count"></p>
    <div id="pt-groups"></div>`;

  const groupsEl = el.querySelector("#pt-groups");
  const countEl = el.querySelector("#pt-count");
  const render = () => {
    const obs = apply();
    const byStudy = new Map();
    obs.forEach(o => { if (!byStudy.has(o.bibtexkey)) byStudy.set(o.bibtexkey, []); byStudy.get(o.bibtexkey).push(o); });
    countEl.textContent = `${obs.length} report${obs.length === 1 ? "" : "s"} across `
      + `${byStudy.size} stud${byStudy.size === 1 ? "y" : "ies"}`
      + (obs.length === all.length ? "" : ` (of ${all.length})`);
    groupsEl.innerHTML = [...byStudy.entries()].map(([key, rows]) => {
      const body = rows.map(r => {
        const co = (r.all_mutations_in_patient || "").split("/").map(t => t.trim())
          .filter(t => t && t !== m.gene_mutation);
        const sub = splitMulti(r.specific_type).filter(v => !TRANSPLANT_ECHO.has(v)).join(", ");
        return `<tr>
          <td>${esc(r.patient_number || "—")}</td>
          <td>${esc(r.country || "—")}</td>
          <td>${esc(r.population || "—")}${sub ? `<div class="small muted">${esc(sub)}</div>` : ""}</td>
          <td>${esc(r.age_group || "—")}</td>
          <td>${esc(r.cmv_disease || "—")}</td>
          <td>${esc(r.outcome || "—")}</td>
          <td class="comutations">${co.length ? co.map(c => {
            const cm = DATA.byGm.get(c);
            return `<a class="chip tag" href="#/mutation/${encodeURIComponent(c)}">${esc(cm ? cm.gene + " " + cm.display_change : c)}</a>`;
          }).join(" ") : "<span class='muted'>none</span>"}</td>
          <td class="small">${esc(r.clinical_comments || "")}</td>
        </tr>`;
      }).join("");
      return `<div class="study-group">
        <h4>${refSpan(key)}</h4>
        <table class="pt-table">
          <thead><tr><th>Patient</th><th>Country</th><th>Population</th><th>Age</th><th>CMV disease</th><th>Outcome</th><th>Other mutations in patient</th><th>Clinical comments</th></tr></thead>
          <tbody>${body}</tbody></table>
      </div>`;
    }).join("") || `<p class="muted">No reports match these filters.</p>`;
    wireRefs(groupsEl);
  };

  el.querySelectorAll("select[data-flt]").forEach(s =>
    s.addEventListener("change", () => { state[s.dataset.flt] = s.value; render(); }));
  const clr = el.querySelector("#pt-clear");
  if (clr) clr.onclick = () => {
    el.querySelectorAll("select[data-flt]").forEach(s => { s.value = ""; delete state[s.dataset.flt]; });
    render();
  };
  render();
}

/* ---------- reference popover ---------- */
function refSpan(key) {
  const s = (DATA.studies || {})[key];
  const label = s ? s.short_cite || key : key;
  return `<span class="ref" data-key="${esc(key)}" tabindex="0" role="button">${esc(label)}</span>`;
}
function wireRefs(root) {
  root.querySelectorAll(".ref").forEach(sp => {
    sp.addEventListener("click", e => { e.stopPropagation(); showRefPopover(sp); });
  });
}
let POP = null;
function closePop() { if (POP) { POP.remove(); POP = null; document.removeEventListener("click", closePop); } }
async function showRefPopover(sp) {
  closePop();
  const key = sp.dataset.key;
  const s = (DATA.studies || {})[key] || {};
  POP = document.createElement("div");
  POP.className = "popover";
  POP.innerHTML = `
    <div class="cite">${esc(s.citation || key)}</div>
    <div class="pill-links">
      ${s.doi_url ? `<a href="${esc(s.doi_url)}" target="_blank" rel="noopener">DOI</a>` : ""}
      ${s.pubmed_url ? `<a href="${esc(s.pubmed_url)}" target="_blank" rel="noopener">PubMed</a>` : ""}
      <button data-bib="${esc(key)}">Copy BibTeX</button>
    </div>`;
  document.body.appendChild(POP);
  const r = sp.getBoundingClientRect();
  POP.style.top = (window.scrollY + r.bottom + 6) + "px";
  POP.style.left = Math.max(8, Math.min(window.scrollX + r.left, window.scrollX + document.documentElement.clientWidth - POP.offsetWidth - 8)) + "px";
  POP.addEventListener("click", e => e.stopPropagation());
  POP.querySelector("[data-bib]").onclick = async ev => {
    const btn = ev.currentTarget;
    try {
      const bib = await ensure("bibtex", "data/bibtex.json");
      await navigator.clipboard.writeText(bib[key] || "");
      btn.textContent = "Copied ✓";
    } catch { btn.textContent = "Copy failed"; }
  };
  setTimeout(() => document.addEventListener("click", closePop), 0);
}

/* ---------- about ---------- */
function renderAbout() {
  const node = document.getElementById("tpl-about").content.cloneNode(true);
  node.querySelectorAll(".dv").forEach(e => e.textContent = DATA.meta.data_version);
  node.querySelectorAll(".bd").forEach(e => e.textContent = DATA.meta.build_date);
  view().innerHTML = "";
  view().appendChild(node);
}

boot();
