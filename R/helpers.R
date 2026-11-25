# helpers.R — shared functions for build.R
# No side effects; sourced by build.R.

suppressPackageStartupMessages({
  library(stringr)
})

`%||%` <- function(a, b) if (is.null(a) || length(a) == 0 || (length(a) == 1 && is.na(a))) b else a

# --- NA handling -------------------------------------------------------------
# The source CSVs use the literal string "NA" (and "", "NaN") for missing.
blank_to_na <- function(x) {
  x <- trimws(as.character(x))
  x[x %in% c("", "NA", "NaN", "N/A", "null", "NULL")] <- NA_character_
  x
}

num <- function(x) suppressWarnings(as.numeric(blank_to_na(x)))

# --- mutation nomenclature --------------------------------------------------
# A "token" is one gene-scoped change, e.g. "UL97_A594V".
# A "cell" may join several with "/", e.g. "UL54_A594V/UL97_C603W".

GENE_RE <- "^(UL\\d+)_(.+)$"

# Classify the body of a token (everything after "UL\\d+_").
# Returns one of: substitution, nonsense, deletion, deletion-range,
# insertion, frameshift, or NA (malformed -> quarantined).
classify_body <- function(body) {
  b <- body
  dplyr::case_when(
    str_detect(b, "^[A-Z]\\d+[A-Z]$")        ~ "substitution",
    str_detect(b, "^[A-Z]\\d+\\*$")          ~ "nonsense",
    str_detect(b, "^DEL\\d+$")               ~ "deletion",
    str_detect(b, "^DEL\\d+-\\d+$")          ~ "deletion-range",
    str_detect(b, "^INS\\d+(_[A-Z]+)?$")     ~ "insertion",
    str_detect(b, "(?i)^[A-Z]?\\d+fs$")      ~ "frameshift",
    TRUE                                     ~ NA_character_
  )
}

# Parse one token -> tibble(row) with gene, body, change (display), variant_type, valid
parse_token <- function(token) {
  token <- trimws(token)
  m <- str_match(token, GENE_RE)
  gene <- m[, 2]
  body <- m[, 3]
  vt <- ifelse(is.na(body), NA_character_, classify_body(body))
  tibble::tibble(
    token        = token,
    gene         = gene,
    body         = body,
    variant_type = vt,
    valid        = !is.na(gene) & !is.na(body) & !is.na(vt) &
                   # reject non-ASCII (mojibake from the Latin-1 export)
                   !str_detect(token, "[^\\x20-\\x7E]")
  )
}

# Corrections for a small number of malformed mutation tokens in the patient
# export that the data owner has authorised fixing here (rather than upstream):
#   L54_A693T     -> missing leading "U"          (boutolleau_d_resistance_2009)
#   UL97_nI464Y   -> stray lowercase "n" prefix   (javad_hosseini_sm_evaluation_2015)
#   UL97_H411L<x> -> trailing Latin-1 mojibake    (kleiboeker_dual_2025)
# Every other quarantined token stays excluded and listed in needs_review.csv.
TOKEN_FIXES <- c(
  "L54_A693T"   = "UL54_A693T",
  "UL97_nI464Y" = "UL97_I464Y"
)
fix_token <- function(tok) {
  tok <- trimws(tok)
  # drop trailing characters that can never legitimately end a token body
  # (whitespace, mojibake bytes from the Latin-1 export) -> e.g. "UL97_H411L "
  tok <- str_replace(tok, "[^A-Za-z0-9*]+$", "")
  hit <- tok %in% names(TOKEN_FIXES)
  tok[hit] <- unname(TOKEN_FIXES[tok[hit]])
  tok
}

# specific_type values that only echo the population column and carry no extra
# information about the kind of transplant.
TRANSPLANT_ECHO <- c("SCT", "SOT", "HIV", "Congenital CMV", "Other")

# Split a "/"-joined cell into trimmed, non-empty tokens.
split_cell <- function(cell) {
  cell <- blank_to_na(cell)
  if (is.na(cell)) return(character(0))
  parts <- str_split(cell, "/")[[1]]
  parts <- trimws(parts)
  parts[nzchar(parts)]
}

# --- categorical normalisation (patient data) ------------------------------
map_population <- function(x) {
  x <- blank_to_na(x)
  dplyr::case_when(
    is.na(x)                       ~ "Unknown",
    x == "SOT"                     ~ "SOT",
    x == "SCT"                     ~ "HSCT",
    x == "Congenital CMV"          ~ "Congenital",
    x == "HIV"                     ~ "HIV",
    x == "Other"                   ~ "Other",
    x == "SCT,SOT"                 ~ "SOT; HSCT",
    TRUE                           ~ NA_character_  # -> validation warning
  )
}

map_age_group <- function(x) {
  x <- blank_to_na(x)
  dplyr::case_when(
    is.na(x)          ~ "Unknown",
    x == "Adult"      ~ "Adult",
    x == "Paediatric" ~ "Paediatric",
    TRUE              ~ NA_character_
  )
}

map_outcome <- function(x) {
  x <- blank_to_na(x)
  dplyr::case_when(
    is.na(x)         ~ "Unknown",
    x == "Alive"     ~ "Alive",
    x == "Deceased"  ~ "Deceased",
    TRUE             ~ NA_character_
  )
}

# Comma-separated multi-value field -> "; "-joined, trimmed, de-duplicated.
clean_multi <- function(x) {
  x <- blank_to_na(x)
  ifelse(is.na(x), NA_character_,
         vapply(x, function(v) {
           parts <- trimws(str_split(v, ",")[[1]])
           parts <- parts[nzchar(parts)]
           paste(unique(parts), collapse = "; ")
         }, character(1)))
}

# --- resistance level ordering -------------------------------------------
LEVELS <- c("Unknown", "Susceptible", "Low", "Medium", "High")
level_rank <- function(x) match(x %||% "Unknown", LEVELS)
worst_level <- function(x) {
  x <- x[!is.na(x)]
  if (length(x) == 0) return("Unknown")
  LEVELS[max(match(x, LEVELS), na.rm = TRUE)]
}

# EC50-ratio -> level, using the project thresholds. Used only to VALIDATE
# the source `level_of_resistance` column, never to overwrite it.
ratio_to_level <- function(r) {
  dplyr::case_when(
    is.na(r)     ~ "Unknown",
    r < 2        ~ "Susceptible",
    r < 5        ~ "Low",
    r < 15       ~ "Medium",
    TRUE         ~ "High"
  )
}

# --- evidence tier --------------------------------------------------------
# k       = number of values in the random-effects model (>=2 => pooled + CI)
# n_vals  = number of EC50 values behind the geometric mean
evidence_tier <- function(k, n_vals) {
  dplyr::case_when(
    !is.na(k) & k >= 2        ~ "meta-analysed",
    is.na(k) & n_vals >= 2    ~ "geometric-mean",
    TRUE                      ~ "single-value"
  )
}
tier_rank <- function(x) match(x, c("single-value", "geometric-mean", "meta-analysed"))

# --- minimal BibTeX parser ---------------------------------------------------
# Good enough for display: splits on top-level @entries and pulls common fields.
parse_bib <- function(path) {
  raw <- readLines(path, warn = FALSE, encoding = "UTF-8")
  txt <- paste(raw, collapse = "\n")
  # split into entries beginning with @TYPE{
  starts <- str_locate_all(txt, "@\\w+\\s*\\{")[[1]][, 1]
  if (length(starts) == 0) return(tibble::tibble())
  ends <- c(starts[-1] - 1, nchar(txt))
  entries <- substring(txt, starts, ends)

  # Vectorised field extractor. Handles  field = {..} | "..".  and bare
  # tokens (field = 2020,). Returns a character vector, NA where absent.
  pull_field <- function(entries, field) {
    m <- str_match(entries, stringr::regex(
      sprintf("(?is)\\b%s\\s*=\\s*(?:[{\"](.*?)[}\"]|([^,\\n{}]+?))\\s*[,\\n]", field)))
    v <- ifelse(is.na(m[, 2]), m[, 3], m[, 2])
    v <- str_replace_all(v, "[{}]", "")
    v <- str_replace_all(v, "\\s+", " ")
    v <- trimws(v)
    v[!nzchar(v)] <- NA_character_
    v
  }
  first_non_na <- function(...) {
    cols <- list(...); out <- cols[[1]]
    for (c in cols[-1]) out <- ifelse(is.na(out), c, out)
    out
  }

  key    <- str_match(entries, "@\\w+\\s*\\{\\s*([^,\\s]+)\\s*,")[, 2]
  year   <- first_non_na(pull_field(entries, "year"), pull_field(entries, "date"))
  year   <- str_match(year, "(\\d{4})")[, 2]
  tibble::tibble(
    bibtexkey = key,
    author    = pull_field(entries, "author"),
    title     = pull_field(entries, "title"),
    journal   = first_non_na(pull_field(entries, "journal"),
                             pull_field(entries, "journaltitle"),
                             pull_field(entries, "shortjournal")),
    year      = year,
    volume    = pull_field(entries, "volume"),
    pages     = pull_field(entries, "pages"),
    doi       = pull_field(entries, "doi"),
    pmid      = first_non_na(pull_field(entries, "pmid"), pull_field(entries, "pmcid")),
    bibtex_raw = trimws(entries)
  )
}

# Remove whole `field = {...}` / `field = "..."` / `field = bare` assignments
# from one raw BibTeX entry (brace-aware, so nested braces are safe). Used to
# drop `url` fields before publishing: reference-manager exports often store
# publisher PDF links carrying personal, session-signed access tokens.
strip_bib_fields <- function(entry, fields = "url") {
  if (is.na(entry)) return(entry)
  pat <- stringr::regex(sprintf("(^|\\n)[ \\t]*(?:%s)[ \\t]*=[ \\t]*",
                                paste(fields, collapse = "|")), ignore_case = TRUE)
  repeat {
    loc <- stringr::str_locate(entry, pat)
    if (is.na(loc[1, 1])) break
    chars <- strsplit(substring(entry, loc[1, 2] + 1), "")[[1]]
    i <- 1L
    if (length(chars) && chars[1] == "{") {
      depth <- 0L
      for (i in seq_along(chars)) {
        if (chars[i] == "{") depth <- depth + 1L
        if (chars[i] == "}") { depth <- depth - 1L; if (depth == 0L) break }
      }
    } else if (length(chars) && chars[1] == "\"") {
      i <- 2L
      while (i <= length(chars) && !(chars[i] == "\"" && chars[i - 1] != "\\")) i <- i + 1L
    } else {
      while (i <= length(chars) && !chars[i] %in% c(",", "\n", "}")) i <- i + 1L
      i <- i - 1L
    }
    # also consume a trailing comma and the rest of that line
    j <- i + 1L
    while (j <= length(chars) && chars[j] %in% c(" ", "\t")) j <- j + 1L
    if (j <= length(chars) && chars[j] == ",") j <- j + 1L
    while (j <= length(chars) && chars[j] %in% c(" ", "\t", "\r")) j <- j + 1L
    rest <- if (j <= length(chars)) paste(chars[j:length(chars)], collapse = "") else ""
    entry <- paste0(substr(entry, 1, loc[1, 1] - 1), rest)
  }
  entry
}

# Handles "Smith, J." , "Smith J" (surname-first, braces stripped) and
# "Jane Smith". -> "Smith et al." / "Smith & Doe" / "Smith"
short_authors <- function(author, year) {
  if (is.na(author)) return(NA_character_)
  parts <- trimws(str_split(author, "\\s+and\\s+")[[1]])
  parts <- str_replace_all(parts, "[{}]", "")
  surname <- function(p) {
    p <- trimws(p)
    if (str_detect(p, ",")) return(trimws(str_split(p, ",")[[1]][1]))
    w <- str_split(p, "\\s+")[[1]]
    if (length(w) < 2) return(w[1])
    # "Surname II" (trailing initials, all upper, <=3 chars) -> first word
    if (str_detect(w[length(w)], "^[A-Z]{1,3}$")) w[1] else w[length(w)]
  }
  s <- vapply(parts, surname, character(1))
  lead <- dplyr::case_when(
    length(s) == 1 ~ s[1],
    length(s) == 2 ~ paste(s[1], "&", s[2]),
    TRUE           ~ paste0(s[1], " et al.")
  )
  if (!is.na(year)) paste0(lead, " ", year) else lead
}

format_authors <- function(author) {
  if (is.na(author)) return(NA_character_)
  a <- str_replace_all(author, "[{}]", "")
  parts <- trimws(str_split(a, "\\s+and\\s+")[[1]])
  if (length(parts) <= 1) return(parts)
  paste0(paste(head(parts, -1), collapse = ", "), " & ", tail(parts, 1))
}

citation_html <- function(row) {
  strip <- function(s) str_replace(s, "[.,;\\s]+$", "")
  bits <- c(
    format_authors(row$author),
    row$title,
    row$journal,
    if (!is.na(row$year)) paste0("(", row$year, ")") else NULL,
    if (!is.na(row$volume)) row$volume else NULL,
    if (!is.na(row$pages)) str_replace_all(row$pages, "--", "-") else NULL
  )
  bits <- bits[!is.na(bits) & nzchar(bits)]
  bits <- vapply(bits, strip, character(1))
  paste0(paste(bits, collapse = ". "), ".")
}
