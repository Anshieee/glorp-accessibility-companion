# Accessibility Companion — self-contained MCP demo

Static, dependency-free showcase of the audit → repair → verify loop.
No backend changes, no secrets, no build step. Nothing here touches
`test/fixtures/`, `src/`, `web/`, `landing-page/` or `deploy/`.

## Files

| File | Purpose |
| --- | --- |
| `demo/before.html` | Flawed registration page seeding all six issue categories (eight axe rules): `color-contrast`, `image-alt`, `label`, `select-name`, `link-name`, `button-name`, `html-has-lang` (+ `html-lang-valid` via the missing declaration). |
| `demo/after.html` | Same page with justified fixes. Identical element IDs (`reg-fullname`, `reg-email`, `reg-role`, `btn-submit`, `link-help`, `registration-form`, `registration-status`, `hero-illustration`), layout, destinations, validation and submit handler. |
| `demo/README.md` | This showcase flow. |

## Showcase flow (exact steps)

> Rule: verifying a corrected page at a *different* URL proves nothing.
> The repair must be served at the **same URL** that was audited.

**1. Start a local static server** (port 8097; port 8080 is reserved on this
machine — do not use it):

```bash
cd demo
python3 -m http.server 8097
# serves http://localhost:8097/before.html
```

Keep this server running for the whole demo.

**2. Audit the BEFORE state.** With the MCP tools connected, call:

```
audit_page(url="http://localhost:8097/before.html")
```

Save the returned `run_id` — it is the baseline for step 5.
(Local targets require a dev server with local scanning enabled,
e.g. `ACCESSIBILITY_ALLOW_LOCAL=true` for developer tests only — never set
this on a deployed Cloud Run service.)

**3. Show the findings.** The audit should report one finding per seeded
category — low-contrast `.intro` text, hero image without `alt`, unlabelled
`#reg-fullname` input, unnamed `#reg-role` select, unnamed `#link-help`
icon link, unnamed `#btn-submit` icon button, and the missing `lang`
declaration. Open each finding's selector/snippet in `demo/before.html` and
confirm it against the source before repairing.

**4. Repair to the AFTER state at the SAME URL.** Do not audit `after.html`
at its own URL — that is not repair evidence. Instead, serve the fixed
content where `before.html` was:

```bash
# from the demo/ directory, while the server from step 1 keeps running:
cp before.html /tmp/opencode/demo-before-backup.html   # keep the original
cp after.html before.html                                # repair in place
```

Confirm behaviour is preserved: fields are usable, empty-name submit still
shows the validation message, a valid submit still shows the confirmation,
`#link-help` still jumps to `#registration-help`, and all IDs are unchanged:

```bash
diff <(grep -o 'id="[^"]*"' /tmp/opencode/demo-before-backup.html | sort) \
     <(grep -o 'id="[^"]*"' before.html | sort) && echo "IDs identical"
```

Restore the flawed file when the demo is over:

```bash
cp /tmp/opencode/demo-before-backup.html before.html
```

**5. Verify the fix on the SAME URL with the SAME baseline:**

```
verify_fixes(url="http://localhost:8097/before.html", baseline_id="<run_id from step 2>")
```

Report the result honestly: remaining / newly detected / no-longer-detected
findings, the latest scan run ID, the tested URL, the selected coverage
(the eight rules above), and any outstanding review items.

## What counts as a justified fix (and what is forbidden)

- Associated visible `<label for>` for the input and the select (placeholders
  alone are insufficient); meaningful `alt` / `aria-label` text describing the
  image, link destination and button action (never filenames or generic words
  like "button", "link", "image"); contrast raised to `#444444` on white;
  `lang="en"` declared from the actual English page content.
- Forbidden: deleting controls or text to clear findings, hiding content,
  `aria-hidden` on necessary UI, suppressing findings, disabling rules,
  changing destinations/handlers/validation/layout to manufacture a pass.

## Pass wording (verbatim on `gate = "pass"`)

> "No violations detected by the selected automated checks on the tested page state. Other accessibility requirements and semantic correctness may still need manual review."

A pass covers only the selected automated checks on the tested rendered
state — never a claim of keyboard access, screen-reader usability, or WCAG
conformance. The tool gate (`pass` / `fail` / `review_required` /
`not_evaluated`) is authoritative.
