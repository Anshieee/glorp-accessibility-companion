// Component-only regression check with synthetic props, not scan evidence.
// Run from the project root: node --import tsx scripts/check-ui-gates.mjs
import assert from "node:assert/strict";
import React from "../web/node_modules/react/index.js";
import { renderToStaticMarkup } from "../web/node_modules/react-dom/server.node.js";

// This harness has no browser; the root tsx loader uses classic JSX.
globalThis.window = { location: { origin: "http://ui-regression.invalid" } };
globalThis.React = React;
const { DeltaPanel } = await import("../web/src/components/DeltaPanel.tsx");
const { CLEARANCE_TEXT } = await import("../web/src/lib/presets.ts");

for (const gate of ["pass", "fail", "review_required", "not_evaluated"]) {
  const result = {
    gate,
    comparison: {
      remaining_ids: [], newly_detected_ids: [], no_longer_detected_ids: [],
      uncertain_baseline_ids: [], notes: [],
    },
    completion_claim: "Synthetic component test only",
  };
  const html = renderToStaticMarkup(React.createElement(DeltaPanel, { result }));
  assert.equal(html.includes(CLEARANCE_TEXT), gate === "pass");
  console.log(`Verification clearance rendering: ${gate} OK`);
}
