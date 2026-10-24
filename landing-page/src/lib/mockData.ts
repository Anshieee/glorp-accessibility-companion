/**
 * UNUSED FIXTURE FILE — NOT RUNTIME, NOT DEPLOYED, NEVER A CLAIM.
 *
 * This file is a static, offline TypeScript fixture kept only so future
 * contributors can see the ScanRun/VerificationResult SHAPE while working
 * without a backend. It is intentionally NOT imported by any runtime module
 * (verified: no import of './mockData' or 'mockData' exists in src/ outside
 * this file). The live UI always calls the real backend
 * (POST /api/v1/audits, POST /api/v1/verifications, GET /api/v1/config) and
 * surfaces real backend errors — there is no simulation fallback.
 *
 * Do NOT render these objects as scan results, do NOT cite them as evidence,
 * and do NOT ship them as demo output.
 */
import { ScanRun, VerificationResult } from './types';

export const mockSampleScanRun: ScanRun = {
  schema_version: '1.0',
  run_id: 'run_9f4b12a0e28c',
  execution: 'completed',
  started_at: '2026-10-24T07:42:10.120Z',
  completed_at: '2026-10-24T07:42:12.450Z',
  duration_ms: 2330,
  requested_url: 'https://acme-studio.internal:3000',
  final_url: 'https://acme-studio.internal:3000/',
  page_title: 'Acme Studio — Next Gen Creative AI Tools',
  conditions: {
    viewport: { width: 1280, height: 800 },
    color_scheme: 'light',
    browser_locale: 'en-US',
    readiness_selector: null,
    scope: 'full_page',
  },
  engine: {
    axe_version: '4.10.2',
    playwright_version: '1.49.0',
    rule_ids: [
      'color-contrast',
      'image-alt',
      'label',
      'select-name',
      'link-name',
      'button-name',
      'html-has-lang',
      'html-lang-valid',
    ],
    ruleset_fingerprint: 'sha256-d7a8e930f14c2b9a',
  },
  coverage: {
    categories: [
      'Text contrast',
      'Image alternatives',
      'Form labels',
      'Link names',
      'Button names',
      'Document language',
    ],
    evaluated_rule_ids: [
      'color-contrast',
      'image-alt',
      'label',
      'link-name',
      'button-name',
      'html-has-lang',
    ],
    inapplicable_rule_ids: ['select-name', 'html-lang-valid'],
    incomplete_rule_ids: ['color-contrast'],
    current_rendered_state_only: true,
    frame_coverage: 'main_document_only',
  },
  counts: {
    violation_rule_count: 5,
    violation_node_count: 7,
    incomplete_node_count: 1,
    returned_finding_count: 7,
    omitted_finding_count: 0,
  },
  findings: [
    {
      id: 'fnd_001_img_hero',
      rule_id: 'image-alt',
      impact: 'serious',
      description: 'Images must have alternate text',
      help: 'Elements must have an alt attribute or role="none" / role="presentation"',
      help_url: 'https://dequeuniversity.com/rules/axe/4.10/image-alt',
      wcag_tags: ['wcag2a', 'wcag111', 'section508'],
      targets: ['header.hero-banner > div.media-wrap > img.hero-graphic'],
      html: '<img src="/assets/hero-visual-3d.webp" class="hero-graphic w-full" />',
      failure_summary:
        'Fix any of the following:\n  Element does not have an alt attribute\n  aria-label attribute does not exist or is empty\n  aria-labelledby attribute does not exist or points to elements that do not exist',
      guidance:
        'Determine whether the image conveys information, performs an action or is decorative. Use meaningful context-dependent alternatives; an empty alt="" is appropriate only for confirmed decorative images. Never replace missing alternatives with a generic filename.',
      guidance_source: 'rule_registry',
      requires_context: true,
      ai_insight:
        'The image is prominently placed in the landing hero section depicting dynamic 3D generative computation. It appears to serve an illustrative branding role. If informative, recommend alt="Glorp 3D neural computation lattice visualizing web accessibility structures". If purely cosmetic, provide alt="" and aria-hidden="true".',
      suggested_code_diff: {
        before: '<img src="/assets/hero-visual-3d.webp" class="hero-graphic w-full" />',
        after: '<img src="/assets/hero-visual-3d.webp" alt="Glorp neural computation lattice" class="hero-graphic w-full" />',
      },
    },
    {
      id: 'fnd_002_btn_icon',
      rule_id: 'button-name',
      impact: 'critical',
      description: 'Buttons must have discernible text',
      help: 'Ensure buttons have discernible text or accessible names',
      help_url: 'https://dequeuniversity.com/rules/axe/4.10/button-name',
      wcag_tags: ['wcag2a', 'wcag412'],
      targets: ['nav.top-bar > div.actions > button.search-toggle-btn'],
      html: '<button class="p-2 rounded-full hover:bg-white/10"><svg class="lucide lucide-search" ...></svg></button>',
      failure_summary:
        'Fix any of the following:\n  Element does not have inner text that is visible to screen readers\n  aria-label attribute does not exist or is empty',
      guidance:
        'Provide a meaningful name describing the action. Prefer visible text; icon-only controls must have an appropriate aria-label or visually-hidden screen reader span (sr-only). Preserve action and form behavior.',
      guidance_source: 'rule_registry',
      requires_context: false,
      ai_insight:
        'This button only renders an SVG magnifier icon without an accessible label. Assistive screen reader technologies announce this element simply as "button", leaving users uninformed of its purpose.',
      suggested_code_diff: {
        before: '<button class="p-2 rounded-full hover:bg-white/10">',
        after: '<button aria-label="Open search dialog" class="p-2 rounded-full hover:bg-white/10">',
      },
    },
    {
      id: 'fnd_003_contrast_subtext',
      rule_id: 'color-contrast',
      impact: 'serious',
      description: 'Elements must meet minimum color contrast ratio thresholds',
      help: 'Ensure the contrast between foreground text and background meets WCAG 2 AA requirements (4.5:1 for regular text)',
      help_url: 'https://dequeuniversity.com/rules/axe/4.10/color-contrast',
      wcag_tags: ['wcag2aa', 'wcag143'],
      targets: ['section.pricing > div.tier-card > p.tier-disclaimer'],
      html: '<p class="text-xs text-zinc-500">Billed annually. Cancel anytime with zero fees.</p>',
      failure_summary:
        'Element has insufficient color contrast of 2.82:1 (foreground color: #71717a, background color: #0b0713, font size: 9.0pt (12px), font weight: normal). Expected contrast ratio of 4.5:1',
      guidance:
        'Use rendered foreground/background evidence and engine threshold information. Adjust foreground color token to at least #a1a1aa or lighter to satisfy the 4.5:1 requirement while maintaining hierarchy.',
      guidance_source: 'rule_registry',
      requires_context: false,
      ai_insight:
        'The #71717a grey text on the dark #0b0713 background results in a 2.82:1 ratio, which is difficult for users with low vision or high ambient glare. Bumping the text tone to text-zinc-400 (#a1a1aa) yields a safe 5.1:1 ratio.',
      suggested_code_diff: {
        before: '<p class="text-xs text-zinc-500">Billed annually...</p>',
        after: '<p class="text-xs text-zinc-400">Billed annually...</p>',
      },
    },
    {
      id: 'fnd_004_input_label',
      rule_id: 'label',
      impact: 'critical',
      description: 'Form elements must have associated labels',
      help: 'Ensure every form element has a programmatic label',
      help_url: 'https://dequeuniversity.com/rules/axe/4.10/label',
      wcag_tags: ['wcag2a', 'wcag412', 'wcag131'],
      targets: ['form#newsletter > input[type="email"]'],
      html: '<input type="email" placeholder="Enter your work email address" class="email-input" />',
      failure_summary:
        'Fix any of the following:\n  aria-label attribute does not exist or is empty\n  aria-labelledby attribute does not exist\n  <label> wrapper does not exist\n  id and for attributes do not match',
      guidance:
        'Prefer a visible label correctly associated with the control using <label for="...">; use an aria-label attribute when design constraints require an icon-only or standalone control. Placeholders alone are insufficient for accessibility.',
      guidance_source: 'rule_registry',
      requires_context: true,
      ai_insight:
        'Placeholders disappear when typing and are not reliably conveyed by all screen readers. Add a visually-hidden label or an explicit aria-label="Work email address".',
      suggested_code_diff: {
        before: '<input type="email" placeholder="Enter your work email address" class="email-input" />',
        after: '<input type="email" aria-label="Work email address" placeholder="Enter your work email address" class="email-input" />',
      },
    },
    {
      id: 'fnd_005_empty_link',
      rule_id: 'link-name',
      impact: 'serious',
      description: 'Links must have discernible text',
      help: 'Ensure links have discernible text or accessible names',
      help_url: 'https://dequeuniversity.com/rules/axe/4.10/link-name',
      wcag_tags: ['wcag2a', 'wcag412', 'wcag244'],
      targets: ['footer.site-footer > div.social-links > a.social-twitter'],
      html: '<a href="https://x.com/glorp_a11y" target="_blank" class="social-icon"><svg>...</svg></a>',
      failure_summary:
        'Fix any of the following:\n  Element is in tab order and does not have accessible text',
      guidance:
        'Provide an accessible name describing the destination or purpose using available context. Preserve the destination URL. Do not hide necessary interactive content.',
      guidance_source: 'rule_registry',
      requires_context: false,
      ai_insight:
        'An empty anchor tag wrapping an SVG cannot be announced with its destination by screen reader tools. Add aria-label="Follow Glorp on X (opens in a new tab)" and rel="noopener noreferrer".',
      suggested_code_diff: {
        before: '<a href="https://x.com/glorp_a11y" target="_blank" class="social-icon">',
        after: '<a href="https://x.com/glorp_a11y" target="_blank" rel="noopener noreferrer" aria-label="Follow Glorp on X (opens in new tab)" class="social-icon">',
      },
    },
    {
      id: 'fnd_006_html_lang',
      rule_id: 'html-has-lang',
      impact: 'serious',
      description: '<html> element must have a lang attribute',
      help: 'Ensure every HTML document specifies a valid lang attribute',
      help_url: 'https://dequeuniversity.com/rules/axe/4.10/html-has-lang',
      wcag_tags: ['wcag2a', 'wcag311'],
      targets: ['html'],
      html: '<html class="dark">',
      failure_summary: 'The <html> element does not have a lang attribute',
      guidance:
        'Declare a valid primary language based on actual page content and project locale (e.g. lang="en"). Do not leave the root tag unassigned.',
      guidance_source: 'rule_registry',
      requires_context: true,
      ai_insight:
        'Screen readers use the html lang attribute to load the correct pronunciation dictionaries and vocal synthesis models. Missing lang can result in synthesized speech reading content with erroneous foreign phonetics.',
      suggested_code_diff: {
        before: '<html class="dark">',
        after: '<html lang="en" class="dark">',
      },
    },
    {
      id: 'fnd_007_contrast_footer',
      rule_id: 'color-contrast',
      impact: 'moderate',
      description: 'Elements must meet minimum color contrast ratio thresholds',
      help: 'Ensure contrast between copyright caption and dark footer background meets WCAG AA',
      help_url: 'https://dequeuniversity.com/rules/axe/4.10/color-contrast',
      wcag_tags: ['wcag2aa', 'wcag143'],
      targets: ['footer.site-footer > p.copyright'],
      html: '<p class="copyright text-neutral-600 text-[11px]">© 2026 Acme Corp. All rights reserved.</p>',
      failure_summary:
        'Element has insufficient color contrast of 3.1:1 (foreground: #525252, background: #08050e). Expected at least 4.5:1.',
      guidance:
        'Adjust footer metadata color token to at least #8e8e93 for adequate visual clarity.',
      guidance_source: 'rule_registry',
      requires_context: false,
      ai_insight:
        'Subtle footer metadata often gets set too dark in dark-mode themes. Raising foreground brightness slightly ensures readability without breaking secondary visual hierarchy.',
      suggested_code_diff: {
        before: '<p class="copyright text-neutral-600 text-[11px]">',
        after: '<p class="copyright text-neutral-400 text-[11px]">',
      },
    },
  ],
  review_items: [
    {
      rule_id: 'color-contrast',
      targets: ['div.hero-gradient-overlay > span.headline-accent'],
      reason:
        'Element is layered over a dynamic multi-stop gradient or transparent canvas background; automated contrast calculation is inconclusive and requires human visual review.',
      html: '<span class="headline-accent bg-clip-text text-transparent bg-gradient-to-r ...">Accessible Intelligence</span>',
    },
  ],
  gate: 'fail',
  details_truncated: false,
  report_path: '/tmp/glorp_runs/run_9f4b12a0e28c.json',
  warnings: [],
  limitations: [
    'Main document only; cross-origin frames not traversed in P0',
    'Current rendered DOM state at scan timestamp only; does not guarantee dynamic dialog or dropdown states',
  ],
};

export const mockSampleVerificationResult: VerificationResult = {
  schema_version: '1.0',
  baseline_id: 'run_9f4b12a0e28c',
  current_run: {
    ...mockSampleScanRun,
    run_id: 'run_c317ab982e01',
    started_at: '2026-10-24T07:44:18.010Z',
    completed_at: '2026-10-24T07:44:19.890Z',
    duration_ms: 1880,
    counts: {
      violation_rule_count: 1,
      violation_node_count: 1,
      incomplete_node_count: 1,
      returned_finding_count: 1,
      omitted_finding_count: 0,
    },
    // Only 1 remaining finding in the rescan
    findings: [mockSampleScanRun.findings[2]],
    gate: 'fail',
  },
  comparison: {
    comparable: true,
    remaining_ids: ['fnd_003_contrast_subtext'],
    newly_detected_ids: [],
    no_longer_detected_ids: [
      'fnd_001_img_hero',
      'fnd_002_btn_icon',
      'fnd_004_input_label',
      'fnd_005_empty_link',
      'fnd_006_html_lang',
    ],
    uncertain_baseline_ids: ['fnd_007_contrast_footer'],
    notes: [
      '5 violations are no longer detected after applying proposed HTML/ARIA fixes.',
      'Target for fnd_007_contrast_footer could not be unambiguously matched due to footer component structure change. Classified conservatively as UNCERTAIN.',
      '1 violation (fnd_003_contrast_subtext) remains detected with contrast ratio 2.82:1.',
    ],
  },
  gate: 'fail',
  completion_claim:
    'Fresh verification scan completed under identical conditions. 5 issues resolved, 1 uncertain, 1 remaining.',
};
