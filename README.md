# CMV Antiviral Resistance Database

A public, static web resource cataloguing cytomegalovirus (CMV) antiviral-resistance
mutations — combining a phenotype meta-analysis with clinical/patient reports.

**Research use only.** This resource summarises published research and must not be used
to inform clinical practice or individual patient management.

- **Site:** https://virusnerd5.github.io/cmv-resistance-db/
- **Pipeline:** [CMVResistanceFinder](https://github.com/viRusneRd5/CMVResistanceFinder)
  ([doi:10.5281/zenodo.24520720](https://doi.org/10.5281/zenodo.24520720)) — detects resistance
  mutations in CMV sequencing data and interprets them against this database's phenotype data.
- **Data licence:** CC BY 4.0 · **Code licence:** MIT

## How it works

The site is 100% static: `build.R` turns three CSV exports + a BibTeX file into a
small JSON payload, and a vanilla-JS single-page app (`site/`) filters it entirely
in the browser. No server, no database engine.

```
data/source/     3 CSV exports from the systematic-review project + cmv_resistance_db.bib
                 (committed verbatim — never hand-edited; fix issues upstream)
data/reference/  genes.csv — hand-maintained gene metadata (function, target drugs)
data/tidy/       canonical tidy tables written by build.R (committed; reviewable diffs)
data/tidy/needs_review.csv   records quarantined by validation (excluded from the site)
data/tidy/references.bib     published bibliography: cited studies only, url fields removed
build.R          source -> data/tidy/ -> site/data/*.json
R/helpers.R      parsing / classification / BibTeX helpers
site/            the web app (index.html, assets/) — site/data/ is generated, git-ignored
test/smoke.mjs   headless smoke test (Deno)
```

## Build locally

```bash
conda env create -f environment.yml
conda activate cmv-resistance-db      # or the maintainer's superset env, cmv-rf
Rscript build.R
deno run --allow-net --allow-read scripts/serve.mjs 8000   # open http://localhost:8000
```

(`python3 -m http.server` also works, but rejects requests carrying large SSO
cookies when reached via a `*.uq.edu.au` hostname — use `scripts/serve.mjs`, an
incognito window, or an SSH tunnel to `localhost`.)

`Rscript build.R` writes `data/tidy/*.csv`, `site/data/*.json` and `BUILD_REPORT.md`.
Review `BUILD_REPORT.md` and `data/tidy/needs_review.csv` after every run.

### Test

```bash
deno run -A test/smoke.mjs
```

## Updating the data

1. Re-export the three CSVs from the systematic-review project into `data/source/`
   (keep the `_YYYYMMDD` suffix — the newest date becomes the site's data version).
2. Update `data/source/cmv_resistance_db.bib` if new studies were added.
3. `Rscript build.R`, then check `BUILD_REPORT.md` and `needs_review.csv`.
   Fix any new malformed mutation names **in the export**, not here.
4. Commit `data/source/` and the regenerated `data/tidy/` in a PR. CI rebuilds,
   runs the smoke test, and checks `data/tidy/` is current.
5. Merge, then tag `data-vYYYY-MM-DD` and update `CHANGELOG.md`.

## Deploy

GitHub Actions (`.github/workflows/build.yml`) builds and validates the payload
on every push and PR. Deployment to GitHub Pages is **opt-in**:

1. Make the repo public (Pages needs a paid plan on private repos), then
   **Settings → Pages → Source: GitHub Actions**.
2. Add a repo variable **`PAGES_ENABLED=true`**
   (Settings → Secrets and variables → Actions → Variables).

Until then the `deploy` job is skipped (the `build` job still runs everything).

## Data model

| table | grain |
|---|---|
| `genes` | one gene (+ resistance / phenotype / patient counts) |
| `mutations` | one mutation entity — single mutations and phenotyped combinations |
| `phenotype_overall` | mutation × drug — pooled EC₅₀ ratio + resistance level |
| `phenotype_studies` | mutation × drug × study × assay — individual EC₅₀ measurements |
| `patient_observations` | study × patient × mutation — exploded from `/`-joined genotypes |
| `studies` | one study (`bibtexkey`) — citation, DOI, PubMed, raw BibTeX |

The site also serves `phenotype_overall` and `phenotype_studies` as downloads
(`site/data/downloads/phenotype_summary.csv`, `phenotype_measurements.csv`) plus
`references.bib`, linked from the About page.

Resistance level from the EC₅₀ ratio: Susceptible `<2`, Low `2–<5`, Medium `5–<15`,
High `≥15`. Levels are taken verbatim from the source data.

## Contact

Errors or new submissions: please [open an issue](https://github.com/viRusneRd5/cmv-resistance-db/issues/new/choose).
