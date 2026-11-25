#!/usr/bin/env python3
"""Bundle site/ into one self-contained HTML for a private preview (e.g. a
Claude Artifact) — all CSS, JS and data inlined, no network required.

    python3 scripts/bundle-preview.py [out.html]     # default: preview.html

Run `Rscript build.R` first so site/data/ is current. The CSV-export button is
hidden in this build because sandboxed previews can't trigger downloads.
"""
import pathlib, re, json, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "preview.html")

css = (SITE / "assets/tabulator.min.css").read_text(encoding="utf-8") + "\n" \
    + (SITE / "assets/style.css").read_text(encoding="utf-8") \
    + "\n#dl-csv{display:none!important}\n.preview-only{display:block!important}\n"
tabulator_js = (SITE / "assets/tabulator.min.js").read_text(encoding="utf-8")
app_js = (SITE / "assets/app.js").read_text(encoding="utf-8")

html = (SITE / "index.html").read_text(encoding="utf-8")
body = re.search(r"<body>(.*)</body>", html, re.S).group(1)
body = re.sub(r'<script src="[^"]*"></script>', "", body).strip()

data = {}
for p in sorted(SITE.glob("data/*.json")):
    data[p.stem] = p.read_text(encoding="utf-8")
for p in sorted(SITE.glob("data/patients/*.json")):
    data[f"patients/{p.stem}"] = p.read_text(encoding="utf-8")

blob_tags, registry = [], []
for i, (key, txt) in enumerate(data.items()):
    blob_tags.append(f'<script type="application/json" id="__d{i}">{txt.replace("<", "\\u003c")}</script>')
    registry.append(f'  {json.dumps(key)}: JSON.parse(document.getElementById("__d{i}").textContent),')

shim = r"""
(function () {
  var D = window.__CMV_DATA;
  window.fetch = function (u) {
    var k = String(u).replace(/^\.?\/?data\//, "").replace(/\.json$/, "");
    if (Object.prototype.hasOwnProperty.call(D, k))
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(D[k]); } });
    return Promise.resolve({ ok: false, status: 404, json: function () { return Promise.reject(new Error("404 " + u)); } });
  };
})();
"""

# The <meta charset> is essential: the preview host may serve the file without
# a charset header, and browsers then fall back to windows-1252 — turning every
# —, ±, ·, ² and EC₅₀ into mojibake (â€”, Â±, â‚…â‚€ …).
OUT.write_text(
    f"<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
    f"<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
    f"<title>CMV Antiviral Resistance Database</title>\n<style>\n{css}\n</style>\n</head>\n<body>\n"
    f"{body}\n\n{''.join(blob_tags)}\n"
    f"<script>\nwindow.__CMV_DATA = {{\n{chr(10).join(registry)}\n}};\n</script>\n"
    f"<script>\n{tabulator_js}\n</script>\n"
    f"<script>\n{shim}\n{app_js}\n</script>\n</body>\n</html>\n",
    encoding="utf-8",
)
print(f"wrote {OUT}  ({OUT.stat().st_size / 1e6:.1f} MB, {len(data)} data blobs)")
