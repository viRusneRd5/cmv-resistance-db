# Changelog

All notable changes to the database and site. Data releases are tagged
`data-vYYYY-MM-DD` (the export date of the underlying systematic-review data).

## Unreleased

### Changed after first review

- Excluded UL44 and UL104: neither carries resistance mutations, so they were
  removed from `data/reference/genes.csv` and every derived table (1 phenotype
  entity, 29 patient observation rows dropped).
- Patient reports are now filtered on the mutation detail page (population,
  transplant type, age group, CMV disease) rather than only through Search.
- Added a **Transplant type** filter (from the source `Specific_type` column).
- Removed **Final outcome** and **Country** as Search filters (kept as columns).
- Patient counting: exact duplicate rows (same patient, genotype and clinical
  context) are collapsed; the detail page and Search now report the number of
  distinct genotype *records* ("reports"), because `patient_number` is not a
  reliable per-patient key in ~60 compilation/prevalence studies (flagged in
  `BUILD_REPORT.md`). Raw `n_patients` is still emitted in the data.
- EC50-ratio CI plots now auto-scale to each mutation's own data with a
  labelled x-axis, instead of a fixed 0.5–20× window.
- Fixed and re-included malformed patient tokens via a correction step in
  `R/helpers.R`: `L54_A693T` → `UL54_A693T`, `UL97_nI464Y` → `UL97_I464Y`,
  and `UL97_H411L` + trailing Latin-1 mojibake → `UL97_H411L`.
- Patient-tab disclaimer notes that not all mutations present in a patient are
  necessarily reported by the source study.

### Initial build

- Initial build of the CMV Antiviral Resistance Database.
- Data version 2026-09-09:
  - 1,787 single mutations, 184 phenotyped mutation combinations across 8 genes.
  - 1,320 mutation × drug phenotype rows (157 meta-analysed, 195 geometric-mean,
    968 single-value).
  - 13,016 patient observations from 393 studies.
  - 16 records quarantined to `data/tidy/needs_review.csv` pending upstream fixes.
- Static site: gene summary, phenotype/patient search, mutation detail pages,
  About & methods.
- About page: methods summary (REML random-effects, Knapp–Hartung) deferring to
  the accompanying manuscript; placeholder citation until the preprint is out.
  Contact is via GitHub issues only.
- Published bibliography is now only the studies cited by a record on the site
  (451 of 465), with `url` fields stripped (publisher PDF links carried personal
  access tokens). Written to `data/tidy/references.bib`. The `url` fields were
  also removed from `data/source/cmv_resistance_db.bib` (the only source-file
  edit; it cannot be re-exported without them).
- Home-page intro text now spans the table width.
- About page: CMVResistanceFinder pipeline section (how sequencing data are
  matched against the phenotype database), with GitHub and Zenodo links.
- Citation metadata for Zenodo/GitHub: `CITATION.cff` + `.zenodo.json`
  (dataset, CC BY 4.0, authors with ORCIDs).
- About page: "Download the data" section — phenotype summary + individual
  measurements CSVs and references.bib, served from `site/data/downloads/`,
  with a column guide.
- Preview bundler: emit `<meta charset="utf-8">` — without it the preview host
  rendered —, ±, ·, ² and EC₅₀ as mojibake. (Live site was unaffected.)
