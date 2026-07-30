"""Generate the shared-library index from the source itself."""
import ast, pathlib, textwrap

ROOT = pathlib.Path("/Users/cartergasia/servicebilling/servicebilling")
LIB = ROOT / "f/billing/_lib"

def first_line(node):
    d = ast.get_docstring(node) or ""
    d = " ".join(d.strip().split())
    return d.split(". ")[0].rstrip(".") if d else ""

out = []
for path in sorted(LIB.glob("*.py")):
    tree = ast.parse(path.read_text())
    mod_doc = " ".join((ast.get_docstring(tree) or "").strip().split())
    mod_doc = mod_doc.split(". ")[0].rstrip(".")
    fns = []
    for n in tree.body:
        # a module can expose a class instead of functions (clients.QboClient) —
        # index its public methods, or it vanishes from the catalogue entirely
        if isinstance(n, ast.ClassDef) and not n.name.startswith("_"):
            for m in n.body:
                if isinstance(m, ast.FunctionDef) and not m.name.startswith("_"):
                    args = [a.arg for a in m.args.args if a.arg != "self"]
                    fns.append((f"{n.name}.{m.name}({', '.join(args)})", first_line(m)))
        # `main` is the Windmill/self-check entry point in every module, not a
        # verb a workflow composes — it would add 14 empty rows
        if (isinstance(n, ast.FunctionDef) and not n.name.startswith("_")
                and n.name != "main"):
            args = [a.arg for a in n.args.args]
            if n.args.vararg: args.append("*" + n.args.vararg.arg)
            if n.args.kwarg: args.append("**" + n.args.kwarg.arg)
            fns.append((f"{n.name}({', '.join(args)})", first_line(n)))
    if fns:
        out.append((path.stem, mod_doc, fns))

lines = ["# Shared library index — what workflows compose from",
         "",
         "> Status: [active]",
         "> Generated from `f/billing/_lib/*.py`. Every public function, its signature,",
         "> and what it is for. The method that produced this shape is",
         "> [LIBRARY_COMPOSITION.md](LIBRARY_COMPOSITION.md); the contracts are",
         "> [ADR 009](../adrs/009-shared-qbo-primitives-lib.md). This file is the",
         "> inventory those two assume — build a workflow by picking verbs from here",
         "> rather than writing new ones.",
         "",
         "Regenerate after adding or renaming a public function:",
         "",
         "```bash",
         "python3 scripts/gen_library_index.py",
         "```",
         ""]
for mod, doc, fns in out:
    lines.append(f"## `{mod}`")
    lines.append("")
    if doc:
        lines.append(textwrap.fill(doc, 78))
        lines.append("")
    lines.append("| Function | Purpose |")
    lines.append("|---|---|")
    for sig, purpose in fns:
        lines.append(f"| `{sig}` | {purpose or '—'} |")
    lines.append("")

(ROOT / "docs/conventions/LIBRARY_INDEX.md").write_text("\n".join(lines))
print(f"{len(out)} modules, {sum(len(f) for _, _, f in out)} public functions")
