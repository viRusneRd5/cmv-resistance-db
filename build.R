#!/usr/bin/env Rscript
# build.R — CMV Antiviral Resistance Database
#
# Reads the three source CSV exports + the BibTeX file from data/source/,
# validates and cleans them, and writes:
#   data/tidy/*.csv     tidy canonical tables (committed; reviewable diffs)
#   data/tidy/needs_review.csv   quarantined rows that failed validation
#   data/tidy/references.bib     cited studies only, url fields removed
#   site/data/*.json    payload for the static site (git-ignored)
#   BUILD_REPORT.md      human-readable summary of this build
#
# The source `level_of_resistance` column is authoritative and is NEVER
# recomputed here — only validated against the project thresholds.

suppressPackageStartupMessages({
  library(readr); library(dplyr); library(tidyr)
  library(stringr); library(purrr); library(jsonlite); library(tibble)
})

source("R/helpers.R")

SRC  <- "data/source"
TIDY <- "data/tidy"
SITE <- "site/data"
unlink(SITE, recursive = TRUE)                 # start from a clean payload dir
dir.create(TIDY, showWarnings = FALSE, recursive = TRUE)
dir.create(SITE, showWarnings = FALSE, recursive = TRUE)

warnings_log <- character(0)
warn <- function(...) {
  msg <- paste0(...)
  warnings_log <<- c(warnings_log, msg)
  message("  ! ", msg)
}

DRUGS <- c("Ganciclovir", "Cidofovir", "Foscarnet", "Letermovir", "Maribavir")

# ---------------------------------------------------------------------------
# 0. locate source files + derive data version
# ---------------------------------------------------------------------------
find_one <- function(pattern) {
  f <- list.files(SRC, pattern = pattern, full.names = TRUE)
  if (length(f) != 1) stop(sprintf("expected exactly one %s in %s, found %d",
                                   pattern, SRC, length(f)))
  f
}
f_patients <- find_one("^CMV_Patients_db_.*\\.csv$")
f_prep     <- find_one("^preparing_df_for_ec50_meta_.*\\.csv$")
f_meta     <- find_one("^final_pheno_meta_analysis_.*\\.csv$")
f_bib      <- find_one("\\.bib$")

src_dates <- str_match(c(f_patients, f_prep, f_meta), "(\\d{8})\\.csv$")[, 2]
data_version <- as.character(max(as.Date(src_dates, "%Y%m%d")))
message("Data version: ", data_version)

# ---------------------------------------------------------------------------
# 1. studies (from BibTeX + study columns across the CSVs)
# ---------------------------------------------------------------------------
message("Studies...")
bib <- parse_bib(f_bib)
if (any(duplicated(bib$bibtexkey))) warn("duplicate keys in .bib: ",
  paste(unique(bib$bibtexkey[duplicated(bib$bibtexkey)]), collapse = ", "))

studies <- bib %>%
  mutate(
    short_cite = map2_chr(author, year, short_authors),
    citation   = pmap_chr(list(author = author, title = title, journal = journal,
                               year = year, volume = volume, pages = pages),
                          function(...) citation_html(tibble(...))),
    pubmed_url = if_else(!is.na(pmid), paste0("https://pubmed.ncbi.nlm.nih.gov/", pmid, "/"), NA_character_),
    doi_url    = if_else(!is.na(doi), paste0("https://doi.org/", doi), NA_character_)
  ) %>%
  select(bibtexkey, short_cite, citation, doi, doi_url, pubmed_url, year, bibtex_raw)

# ---------------------------------------------------------------------------
# 2. phenotype_overall (mutation x drug)
# ---------------------------------------------------------------------------
message("Phenotype (overall)...")
meta_raw <- read_csv(f_meta, show_col_types = FALSE, na = c("", "NA", "NaN"))

split_keys <- function(x) {
  x <- blank_to_na(x)
  map(x, function(v) if (is.na(v)) character(0)
      else trimws(str_split(v, ",\\s*")[[1]]) %>% (\(z) z[nzchar(z)])())
}

phenotype_overall <- meta_raw %>%
  transmute(
    gene_mutation = trimws(Gene_Mutation),
    drug          = trimws(Drug),
    k             = num(k),
    n_studies     = num(n_studies),
    n_vals        = num(n_vals),
    estimate      = num(estimate),
    ci_lb         = num(ci_lb),
    ci_ub         = num(ci_ub),
    se            = num(se),
    tau2          = num(tau2),
    i2            = num(I2),
    pval          = num(pval),
    geometric_mean    = num(geometric_mean),
    reported_ratio    = num(reported_EC50_ratio),
    ec50_ratio        = num(Overall_EC50_Ratio),
    level             = blank_to_na(level_of_resistance),
    bibtex_meta   = split_keys(bibtex_list_meta),
    bibtex_geo    = split_keys(bibtex_list_geo)
  ) %>%
  mutate(
    tier = evidence_tier(k, n_vals),
    level = coalesce(level, "Unknown"),
    expected_level = ratio_to_level(ec50_ratio)
  )

# validation: drug vocabulary
bad_drug <- setdiff(unique(phenotype_overall$drug), DRUGS)
if (length(bad_drug)) warn("unexpected drug(s) in meta-analysis: ", paste(bad_drug, collapse = ", "))

# validation: level vs threshold (report only; source wins)
lvl_mismatch <- phenotype_overall %>%
  filter(level != "Unknown", !is.na(ec50_ratio), level != expected_level)
if (nrow(lvl_mismatch)) warn(nrow(lvl_mismatch),
  " phenotype rows where level_of_resistance disagrees with the EC50-ratio threshold ",
  "(kept as-is from source; see needs_review.csv)")

# validation: every phenotyped row must carry a level
missing_lvl <- phenotype_overall %>% filter(level == "Unknown")
if (nrow(missing_lvl)) warn(nrow(missing_lvl), " phenotype rows with no level_of_resistance")

# ---------------------------------------------------------------------------
# 3. phenotype_studies (mutation x drug x study x assay)
# ---------------------------------------------------------------------------
message("Phenotype (individual studies)...")
prep_raw <- read_csv(f_prep, show_col_types = FALSE, na = c("", "NA", "NaN"))

phenotype_studies <- prep_raw %>%
  transmute(
    gene_mutation   = trimws(Gene_Mutation),
    drug            = trimws(Drug),
    bibtexkey       = trimws(BIBTEXKEY),
    sample_type     = blank_to_na(Sample_Type),
    reference_strain= blank_to_na(Reference_Strain),
    assay           = blank_to_na(Assay),
    cell_type       = blank_to_na(Cell_type),
    wt_ec50         = num(WT.EC50.mean),
    wt_sd           = num(WT.standard.deviation),
    wt_n            = num(WT.number.of.replicates),
    mut_ec50        = num(numeric_Mutation.EC50),
    mut_sd          = num(Mutation.standard.deviation),
    mut_n           = num(Mutation.number.of.replicates),
    ec50_ratio_calc = num(calculated_EC50_ratio),
    ec50_ratio      = num(EC50_Ratio),
    n_replicates    = num(n_replicates),
    in_meta         = str_detect(coalesce(meta_analysis, ""), regex("included", ignore_case = TRUE)) &
                        !str_detect(coalesce(meta_analysis, ""), regex("not included", ignore_case = TRUE)),
    comments        = {
      a <- blank_to_na(Comments); b <- blank_to_na(Comments2)
      trimws(paste(coalesce(a, ""), coalesce(b, "")))
    }
  ) %>%
  mutate(comments = if_else(nzchar(comments), comments, NA_character_))

orphan_studies <- setdiff(phenotype_studies$bibtexkey, studies$bibtexkey)
if (length(orphan_studies)) warn(length(orphan_studies),
  " bibtexkeys in phenotype studies missing from .bib: ",
  paste(head(orphan_studies, 5), collapse = ", "))

# ---------------------------------------------------------------------------
# 4. patient_observations (study x patient x component mutation)
#    One record = one reported genotype for one patient. Exact repeat rows
#    (same study, patient_number, genotype and clinical context) are collapsed
#    so a mutation re-detected in follow-up samples is not double-counted.
#    NOTE: patient_number is not a reliable per-patient key in every study --
#    some compilation/prevalence studies set it to a constant. See BUILD_REPORT.
# ---------------------------------------------------------------------------
message("Patient observations...")
pat_raw <- read_csv(f_patients, show_col_types = FALSE, na = c("", "NA", "NaN"),
                    locale = locale(encoding = "latin1"))

pat_base <- pat_raw %>%
  transmute(
    bibtexkey     = trimws(BIBTEXKEY),
    study_label   = trimws(Study.ID),
    surname       = blank_to_na(Surname),
    year          = num(Year),
    country       = blank_to_na(Country.in.which.the.study.conducted),
    population    = map_population(SOT_SCT_Other),
    age_group     = map_age_group(Adult_Paediatric),
    outcome       = map_outcome(Final_outcome),
    specific_type = clean_multi(Specific_type),
    reason        = blank_to_na(Reason_for_transplant),
    cmv_disease   = clean_multi(CMV_disease),
    clinical_comments = blank_to_na(Clinical.comments.Patients),
    participant_desc  = blank_to_na(Participant.population.clinical.description),
    patient_number    = trimws(as.character(patient_number)),
    cell              = trimws(Gene_Mutation)
  ) %>%
  # collapse exact duplicate rows (same patient, same genotype, same context)
  distinct(bibtexkey, patient_number, cell, population, age_group, outcome,
           specific_type, cmv_disease, .keep_all = TRUE) %>%
  mutate(obs_id = row_number())

# validation: unmapped categoricals
for (col in c("population", "age_group", "outcome")) {
  bad <- pat_base %>% filter(is.na(.data[[col]]))
  if (nrow(bad)) warn(nrow(bad), " patient rows with unmappable ", col)
}

# explode the "/"-joined mutation cell into component tokens (with fix-ups)
exploded <- pat_base %>%
  mutate(token = map(cell, ~ fix_token(split_cell(.x)))) %>%
  unnest_longer(token)

tok_meta <- parse_token(exploded$token)
exploded <- bind_cols(exploded, tok_meta %>% select(gene, variant_type, valid))

pat_bad <- exploded %>% filter(!valid)
patient_observations <- exploded %>%
  filter(valid) %>%
  transmute(
    obs_id, bibtexkey, study_label, surname, year, country,
    gene, gene_mutation = token, variant_type,
    all_mutations_in_patient = cell,
    population, age_group, outcome, specific_type, reason, cmv_disease,
    clinical_comments, participant_desc, patient_number
  )

if (nrow(pat_bad)) warn(nrow(pat_bad), " patient mutation tokens failed to parse (",
  paste(sort(unique(pat_bad$token)), collapse = ", "), ")")

# diagnostic: studies where patient_number is not a usable per-patient key
# (many distinct genotypes recorded under one or two patient_number values --
#  compilation / prevalence studies). For these the "patients" tally is really
#  a count of distinct genotype records.
pn_degenerate <- pat_base %>%
  group_by(bibtexkey) %>%
  summarise(n_pn = n_distinct(patient_number), n_geno = n_distinct(cell), .groups = "drop") %>%
  filter(n_geno >= 8, n_pn <= 2) %>%
  arrange(desc(n_geno))
if (nrow(pn_degenerate))
  warn(nrow(pn_degenerate), " study/studies record many genotypes under <=2 patient_number ",
       "values, so their patient counts are genotype-record counts, not patients: ",
       paste(head(pn_degenerate$bibtexkey, 10), collapse = ", "),
       if (nrow(pn_degenerate) > 10) ", ..." else "")

# ---------------------------------------------------------------------------
# 4b. restrict everything to the curated gene set (data/reference/genes.csv)
# ---------------------------------------------------------------------------
genes_ref <- read_csv("data/reference/genes.csv", show_col_types = FALSE)
allow_genes <- genes_ref$gene
gene_ok <- function(gm) {
  g <- str_match(split_cell(gm), "^(UL\\d+)_")[, 2]
  length(g) > 0 && all(!is.na(g)) && all(g %in% allow_genes)
}
drop_pheno <- unique(phenotype_overall$gene_mutation[
  !vapply(phenotype_overall$gene_mutation, gene_ok, logical(1))])
drop_pat <- unique(patient_observations$gene_mutation[
  !vapply(patient_observations$gene_mutation, gene_ok, logical(1))])
if (length(drop_pheno) || length(drop_pat)) {
  ex <- sort(unique(str_match(c(drop_pheno, drop_pat), "^(UL\\d+)_")[, 2]))
  n_pat_rows <- sum(patient_observations$gene_mutation %in% drop_pat)
  warn("excluded non-curated gene(s) ", paste(ex, collapse = ", "), " — ",
       length(drop_pheno), " phenotype entit", ifelse(length(drop_pheno) == 1, "y", "ies"),
       ", ", n_pat_rows, " patient observation row(s)")
  phenotype_overall <- filter(phenotype_overall, !gene_mutation %in% drop_pheno)
  phenotype_studies <- filter(phenotype_studies, !gene_mutation %in% drop_pheno)
  patient_observations <- filter(patient_observations, !gene_mutation %in% drop_pat)
}

# ---------------------------------------------------------------------------
# 4c. publishable bibliography: only cited studies, no `url` fields
# ---------------------------------------------------------------------------
# The source .bib is a full reference-manager export: it holds studies screened
# but not cited by any record shown on the site, and `url` fields that are often
# publisher PDF links carrying personal access tokens. Everything published
# (site JSON, data/tidy/studies.csv, data/tidy/references.bib) uses this
# cleaned subset; data/source/ stays verbatim.
cited_keys <- unique(c(
  unlist(phenotype_overall$bibtex_meta), unlist(phenotype_overall$bibtex_geo),
  phenotype_studies$bibtexkey, patient_observations$bibtexkey
))
cited_keys <- cited_keys[!is.na(cited_keys) & nzchar(cited_keys)]
n_bib_all <- nrow(studies)
studies <- studies %>%
  filter(bibtexkey %in% cited_keys) %>%
  mutate(bibtex_raw = map_chr(bibtex_raw, strip_bib_fields, fields = "url"))
message("  bibliography: ", nrow(studies), " cited of ", n_bib_all,
        " in source .bib (", n_bib_all - nrow(studies), " uncited dropped); url fields stripped")
missing_cited <- setdiff(cited_keys, studies$bibtexkey)
if (length(missing_cited)) warn(length(missing_cited),
  " cited bibtexkey(s) missing from .bib: ", paste(head(sort(missing_cited), 10), collapse = ", "))
if (any(str_detect(studies$bibtex_raw, regex("(^|\\n)\\s*url\\s*=", ignore_case = TRUE))))
  stop("url field survived stripping in the published bibliography")

# ---------------------------------------------------------------------------
# 5. mutations (one row per distinct entity: singles + phenotype combos)
# ---------------------------------------------------------------------------
message("Mutations...")

# -- phenotype entities (may be combinations, tested as a unit)
pheno_entities <- phenotype_overall %>% distinct(gene_mutation)

pheno_tok <- pheno_entities %>%
  mutate(components = map(gene_mutation, split_cell),
         n_comp     = lengths(components),
         is_combination = n_comp > 1)

pheno_bad <- pheno_tok %>%
  mutate(ok = map_lgl(components, ~ all(parse_token(.x)$valid))) %>%
  filter(!ok)
quarantined_gm <- pheno_bad$gene_mutation
if (length(quarantined_gm)) {
  warn(length(quarantined_gm), " phenotype entities excluded (unparseable component); ",
       "fix the token upstream to restore them: ", paste(quarantined_gm, collapse = "; "))
  phenotype_overall <- filter(phenotype_overall, !gene_mutation %in% quarantined_gm)
  phenotype_studies <- filter(phenotype_studies, !gene_mutation %in% quarantined_gm)
  pheno_tok         <- filter(pheno_tok, !gene_mutation %in% quarantined_gm)
  pheno_entities    <- filter(pheno_entities, !gene_mutation %in% quarantined_gm)
}

# -- single-mutation entities from every source (phenotype singles + combo
#    components + patient components)
single_tokens <- unique(c(
  pheno_tok %>% filter(!is_combination) %>% pull(gene_mutation),
  pheno_tok %>% pull(components) %>% unlist(),
  patient_observations$gene_mutation
))
single_tokens <- single_tokens[!is.na(single_tokens)]
single_meta <- parse_token(single_tokens) %>% filter(valid)

# per (mutation, drug) phenotype summary
pheno_by_drug <- phenotype_overall %>%
  select(gene_mutation, drug, level, tier, ec50_ratio, k, i2, ci_lb, ci_ub, n_studies)

# patient tallies + facet summary per mutation (drives patient-mode search
# without loading the full observation rows)
uniq_sorted <- function(x) sort(unique(x[!is.na(x) & x != "Unknown"]))
pat_tally <- patient_observations %>%
  group_by(gene_mutation) %>%
  summarise(
    n_patient_studies = n_distinct(bibtexkey),
    n_patients   = n_distinct(paste(bibtexkey, patient_number)),
    n_patient_records = n_distinct(paste(bibtexkey, patient_number, all_mutations_in_patient)),
    populations  = list(uniq_sorted(unlist(str_split(population, ";\\s*")))),
    transplant_types = list(uniq_sorted(setdiff(
      trimws(unlist(str_split(specific_type, ";\\s*"))), TRANSPLANT_ECHO))),
    age_groups   = list(uniq_sorted(age_group)),
    outcomes     = list(uniq_sorted(outcome)),
    countries    = list(uniq_sorted(unlist(str_split(country, ",\\s*|\\s+and\\s+")))),
    cmv_diseases = list(uniq_sorted(unlist(str_split(cmv_disease[!is.na(cmv_disease)], ";\\s*")))),
    year_min     = suppressWarnings(min(year, na.rm = TRUE)),
    year_max     = suppressWarnings(max(year, na.rm = TRUE)),
    .groups = "drop"
  ) %>%
  mutate(year_min = ifelse(is.finite(year_min), year_min, NA_real_),
         year_max = ifelse(is.finite(year_max), year_max, NA_real_))

# combos containing a given single (for "also characterised in combination")
combo_membership <- pheno_tok %>%
  filter(is_combination) %>%
  select(combo = gene_mutation, components) %>%
  unnest_longer(components) %>%
  rename(gene_mutation = components) %>%
  group_by(gene_mutation) %>%
  summarise(in_combinations = list(sort(unique(combo))), .groups = "drop")

build_drug_summary <- function(gm) {
  rows <- pheno_by_drug %>% filter(gene_mutation == gm)
  map(DRUGS, function(d) {
    r <- rows %>% filter(drug == d)
    if (nrow(r) == 0) list(drug = d, level = "Unknown", tier = NA, ec50_ratio = NA)
    else list(drug = d, level = r$level[1], tier = r$tier[1],
              ec50_ratio = r$ec50_ratio[1], k = r$k[1], i2 = r$i2[1],
              ci_lb = r$ci_lb[1], ci_ub = r$ci_ub[1], n_studies = r$n_studies[1])
  })
}

single_mutations <- single_meta %>%
  transmute(gene_mutation = token, gene, variant_type, is_combination = FALSE) %>%
  left_join(pat_tally, by = "gene_mutation") %>%
  left_join(combo_membership, by = "gene_mutation") %>%
  mutate(
    n_patient_studies = coalesce(n_patient_studies, 0L),
    n_patients        = coalesce(n_patients, 0L),
    n_patient_records = coalesce(n_patient_records, 0L),
    phenotype_characterised = gene_mutation %in% pheno_by_drug$gene_mutation,
    seen_in_patients        = n_patient_studies > 0,
    drug_summary = map(gene_mutation, build_drug_summary)
  )

combo_mutations <- pheno_tok %>%
  filter(is_combination) %>%
  transmute(
    gene_mutation, is_combination = TRUE,
    gene = map_chr(components, ~ paste(sort(unique(parse_token(.x)$gene)), collapse = "; ")),
    variant_type = "combination",
    components,
    phenotype_characterised = TRUE
  ) %>%
  left_join(pat_tally, by = "gene_mutation") %>%
  mutate(
    n_patient_studies = coalesce(n_patient_studies, 0L),
    n_patients        = coalesce(n_patients, 0L),
    n_patient_records = coalesce(n_patient_records, 0L),
    seen_in_patients  = n_patient_studies > 0,
    in_combinations   = vector("list", n()),
    drug_summary      = map(gene_mutation, build_drug_summary)
  )

mutations <- bind_rows(single_mutations, combo_mutations) %>%
  mutate(
    worst_level = map_chr(drug_summary, ~ worst_level(map_chr(.x, "level"))),
    drugs_with_resistance = map_chr(drug_summary, function(ds) {
      hit <- keep(ds, ~ .x$level %in% c("Low", "Medium", "High"))
      if (length(hit) == 0) NA_character_ else paste(map_chr(hit, "drug"), collapse = "; ")
    }),
    display_change = if_else(
      is_combination,
      map_chr(strsplit(gene_mutation, "/"), ~ paste(str_remove(.x, "^UL\\d+_"), collapse = " + ")),
      str_remove(gene_mutation, "^UL\\d+_")
    )
  ) %>%
  arrange(gene, gene_mutation)

# ---------------------------------------------------------------------------
# 6. genes + gene summary
# ---------------------------------------------------------------------------
message("Genes...")
# genes_ref already loaded in section 4b

data_genes <- sort(unique(c(mutations$gene[!mutations$is_combination],
                            phenotype_overall %>% pull(gene_mutation) %>%
                              str_match("^(UL\\d+)_") %>% (\(m) m[, 2])())))
data_genes <- data_genes[!is.na(data_genes)]
missing_ref <- setdiff(data_genes, genes_ref$gene)
if (length(missing_ref)) warn("genes in data with no row in genes.csv: ",
  paste(missing_ref, collapse = ", "))

gene_summary <- genes_ref %>%
  left_join(
    mutations %>%
      filter(!is_combination) %>%
      group_by(gene) %>%
      summarise(
        n_resistance = sum(worst_level %in% c("Low", "Medium", "High")),
        n_phenotyped = sum(phenotype_characterised),
        n_in_patients = sum(seen_in_patients),
        .groups = "drop"
      ),
    by = "gene"
  ) %>%
  left_join(
    mutations %>% filter(is_combination) %>% count(gene_first = str_match(gene, "^(UL\\d+)")[, 2], name = "n_combo"),
    by = c("gene" = "gene_first")
  ) %>%
  mutate(across(c(n_resistance, n_phenotyped, n_in_patients, n_combo), ~ coalesce(., 0L))) %>%
  arrange(sort_order)

# ---------------------------------------------------------------------------
# 7. needs_review.csv
# ---------------------------------------------------------------------------
needs_review <- bind_rows(
  pat_bad %>% transmute(source = "patient_observations", issue = "unparseable mutation token",
                        value = token, context = cell, study = bibtexkey) %>% distinct(),
  pheno_bad %>% transmute(source = "phenotype_overall",
                          issue = "entity excluded: unparseable component token",
                          value = gene_mutation, context = NA_character_, study = NA_character_),
  lvl_mismatch %>% transmute(source = "phenotype_overall",
                             issue = "level_of_resistance disagrees with EC50-ratio threshold",
                             value = paste0(gene_mutation, " / ", drug, ": level=", level,
                                            ", ratio=", round(ec50_ratio, 2), ", expected=", expected_level),
                             context = tier, study = map_chr(bibtex_meta, ~ paste(.x, collapse = "; "))),
  missing_lvl %>% transmute(source = "phenotype_overall", issue = "no level_of_resistance",
                            value = paste0(gene_mutation, " / ", drug), context = tier, study = NA_character_)
)

# ---------------------------------------------------------------------------
# 8. write tidy CSVs
# ---------------------------------------------------------------------------
message("Writing tidy tables...")
write_csv(gene_summary, file.path(TIDY, "genes.csv"))
write_csv(
  mutations %>%
    transmute(gene_mutation, gene, variant_type, is_combination, display_change,
              phenotype_characterised, seen_in_patients, worst_level,
              drugs_with_resistance, n_patient_studies, n_patients, n_patient_records,
              in_combinations = map_chr(in_combinations, ~ paste(.x, collapse = "; "))),
  file.path(TIDY, "mutations.csv")
)
write_csv(
  phenotype_overall %>%
    transmute(gene_mutation, drug, tier, level, ec50_ratio, k, n_studies, n_vals,
              estimate, ci_lb, ci_ub, se, i2, tau2, pval,
              bibtex_meta = map_chr(bibtex_meta, ~ paste(.x, collapse = "; ")),
              bibtex_geo  = map_chr(bibtex_geo, ~ paste(.x, collapse = "; "))),
  file.path(TIDY, "phenotype_overall.csv")
)
write_csv(phenotype_studies, file.path(TIDY, "phenotype_studies.csv"))
write_csv(patient_observations, file.path(TIDY, "patient_observations.csv"))
write_csv(studies %>% select(-bibtex_raw), file.path(TIDY, "studies.csv"))
writeLines(c(paste0("% CMV Antiviral Resistance Database — bibliography of cited studies (data version ",
                    data_version, ")"),
             "% Generated by build.R from data/source/*.bib: uncited entries and url fields removed.",
             "",
             paste0(studies$bibtex_raw[order(studies$bibtexkey)], "\n")),
           file.path(TIDY, "references.bib"), useBytes = TRUE)
write_csv(needs_review, file.path(TIDY, "needs_review.csv"))

# ---------------------------------------------------------------------------
# 9. write site JSON
# ---------------------------------------------------------------------------
message("Writing site JSON...")
wj <- function(x, name) write_json(x, file.path(SITE, name), auto_unbox = TRUE,
                                   null = "null", na = "null", pretty = FALSE)

wj(list(
  data_version = data_version,
  build_date   = as.character(Sys.Date()),
  drugs        = DRUGS,
  levels       = LEVELS,
  thresholds   = list(Susceptible = "< 2", Low = "2 to < 5", Medium = "5 to < 15", High = ">= 15"),
  counts = list(
    genes = nrow(gene_summary),
    single_mutations = sum(!mutations$is_combination),
    combination_mutations = sum(mutations$is_combination),
    phenotype_rows = nrow(phenotype_overall),
    patient_observations = nrow(patient_observations),
    studies = nrow(studies),
    needs_review = nrow(needs_review)
  )
), "meta.json")

wj(gene_summary, "genes.json")

as_arr <- function(col) map(col, ~ if (is.null(.x) || length(.x) == 0) list() else as.list(.x))

wj(
  mutations %>%
    transmute(gene_mutation, gene, variant_type, is_combination, display_change,
              phenotype_characterised, seen_in_patients, worst_level,
              n_patient_studies, n_patients, n_patient_records, drug_summary,
              in_combinations = as_arr(in_combinations),
              populations = as_arr(populations),
              transplant_types = as_arr(transplant_types),
              age_groups = as_arr(age_groups),
              cmv_diseases = as_arr(cmv_diseases),
              year_min, year_max),
  "mutations.json"
)

nest_by_gm <- function(df) {
  split(df, df$gene_mutation) %>% map(~ select(.x, -gene_mutation))
}
wj(nest_by_gm(phenotype_overall %>%
  mutate(bibtex_meta = as_arr(bibtex_meta), bibtex_geo = as_arr(bibtex_geo)) %>%
  select(gene_mutation, drug, tier, level, ec50_ratio, k, n_studies, n_vals,
         estimate, ci_lb, ci_ub, se, i2, bibtex_meta, bibtex_geo)),
  "phenotype_overall.json")

wj(nest_by_gm(phenotype_studies), "phenotype_studies.json")

# patient observations sharded by gene (first gene for combinations)
dir.create(file.path(SITE, "patients"), showWarnings = FALSE)
pat_json <- patient_observations %>%
  select(-obs_id) %>%
  mutate(shard = str_match(gene_mutation, "^(UL\\d+)_")[, 2])
walk(split(pat_json, pat_json$shard), function(d) {
  wj(nest_by_gm(select(d, -shard)), file.path("patients", paste0(d$shard[1], ".json")))
})

# studies: light index (always loaded) + separate bibtex map (loaded on demand)
studies_light <- studies %>% select(-bibtex_raw)
wj(split(studies_light, studies_light$bibtexkey) %>% map(as.list), "studies.json")
wj(setNames(as.list(studies$bibtex_raw), studies$bibtexkey), "bibtex.json")

# downloadable copies of the published tables (linked from the About page)
dir.create(file.path(SITE, "downloads"), showWarnings = FALSE)
downloads <- c("phenotype_overall.csv"  = "phenotype_summary.csv",
               "phenotype_studies.csv"  = "phenotype_measurements.csv",
               "references.bib"         = "references.bib")
ok <- file.copy(file.path(TIDY, names(downloads)), file.path(SITE, "downloads", downloads),
                overwrite = TRUE)
if (!all(ok)) stop("failed to copy download file(s): ", paste(names(downloads)[!ok], collapse = ", "))

# ---------------------------------------------------------------------------
# 10. build report
# ---------------------------------------------------------------------------
report <- c(
  "# Build report",
  "",
  paste0("- Data version: **", data_version, "**"),
  paste0("- Built: ", Sys.time()),
  "",
  "## Counts",
  paste0("- Genes: ", nrow(gene_summary)),
  paste0("- Single mutations: ", sum(!mutations$is_combination)),
  paste0("- Combination mutations (phenotype): ", sum(mutations$is_combination)),
  paste0("- Phenotype rows (mutation x drug): ", nrow(phenotype_overall),
         "  [meta-analysed: ", sum(phenotype_overall$tier == "meta-analysed"),
         ", geometric-mean: ", sum(phenotype_overall$tier == "geometric-mean"),
         ", single-value: ", sum(phenotype_overall$tier == "single-value"), "]"),
  paste0("- Individual phenotype study rows: ", nrow(phenotype_studies)),
  paste0("- Patient observations (exploded): ", nrow(patient_observations)),
  paste0("- Studies cited (published bibliography): ", nrow(studies),
         " of ", n_bib_all, " in source .bib"),
  paste0("- **needs_review.csv rows: ", nrow(needs_review), "**"),
  "",
  "## Validation warnings",
  if (length(warnings_log) == 0) "- none" else paste0("- ", warnings_log)
)
writeLines(report, "BUILD_REPORT.md")
message("\n", paste(report, collapse = "\n"))

if (nrow(needs_review) > 0)
  message("\nNOTE: ", nrow(needs_review), " rows quarantined to data/tidy/needs_review.csv")
message("\nDone.")
