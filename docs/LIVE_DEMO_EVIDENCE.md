# Live Demo Evidence

## UNRUN — pending real hosted scan

> This file is a TEMPLATE. No evidence has been collected yet. The live demo has
> NOT been scanned or repaired. All fields below are placeholders; do not treat
> any of them as results.

This document records evidence for the **separate live-demo URL** which stays the
**same URL through real source edits**:

- **targetURL:** ` <placeholder — the served live-demo.html URL> `
- **baselineID:** ` <placeholder — baseline scan/audit result ID> `
- **afterID:** ` <placeholder — post-repair scan/audit result ID> `
- **gates:** ` <placeholder — pass/fail gate results, e.g. a11y audit > 0 fixes> `
- **actualdifference:** ` <placeholder — concrete diff: what changed from baseline to after> `

### Commands

```
<placeholder — the exact commands used to produce the scan/audit evidence>
```

### Behavior proof

```
<placeholder — reproducible behavior/outcome showing the repaired page behaves as expected>
```

---

Note: the **known-corrected reference** (`test/fixtures/corrected.html` /
`registration-corrected.html`) is NOT used as the switched/demo target. This demo
uses `live-demo.html` (an exact copy of the flawed `registration.html`) as the
deliberate flawed source for the same-URL source repair/deploy demo, preserving
its defects for the first audit.
