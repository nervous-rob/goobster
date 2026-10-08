---
title: Accessibility review - the setup wizard and the Host operator pages (installer P5.3)
kind: reference
summary: Per page, what is checked by a test today, what the keyboard-only Playwright journey (e2e/operatorKeyboard.spec.js) adds - Tab order, Enter and Space, a visible focus indicator, an accessible name on every control, no keyboard trap, focus moving to a step heading, Escape on the confirm dialog - what remains a human check (screen reader, colour contrast, zoom), the gaps the review found in the confirm dialog, and which guided tours exist for these pages.
when: Asking whether the installer's pages can be used without a mouse; deciding what to test by hand before a pilot; finding what the automated checks do and do not cover; changing the wizard, a Host page or the shared confirm dialog and needing the checks to keep passing.
tags: [accessibility, keyboard, a11y, wizard, host, operator, playwright, review, installer, tutorials]
---

# Accessibility review: the setup wizard and the Host operator pages

This is the record for installer P5.3 (#343). It says, for each page an operator uses to install and maintain Goobster, what a test checks, what a person still has to check, and what the review found. It does not claim the pages are accessible: it claims the specific things listed as checked, and lists the rest as open.

The pages are two surfaces over the same React components (`apps/web/src/setup`, `apps/web/src/rooms/host`):

- **The setup and maintenance wizard**, served by the manager at `/manager/` ([setup_wizard.md](setup_wizard.md)): the sign-in page, the eleven setup steps, and the maintenance journeys.
- **The Host room**, served by the portal at `/app/host` and its sub-pages ([host_operations.md](host_operations.md)): Overview, Features, Connections, Instance Defaults, Installation, Database and Maintenance.

## What was checked automatically before this review

Nothing in the tree runs an automated accessibility engine (no axe, Lighthouse or pa11y in `package.json`, `package-lock.json`, `e2e/`, `tests/`, `scripts/` or `.github/`). What existed were individual assertions inside journeys that were written for other reasons:

| Where | What it asserts |
| --- | --- |
| `e2e/setupWizard.spec.js` | Drives every step by focusing the Continue button and pressing Enter, and submits the sign-in form with Enter. At 360 px wide every step is one column, nothing scrolls sideways, and every button has a name (visible text or `aria-label`). |
| `e2e/hostOperator.spec.js` | The Host page list is a navigation named "Host pages" with `aria-current` on the current page; a feature checkbox has an accessible name and switches with Space; the restart panel is a polite live region. |
| `e2e/featureAvailability.spec.js` | A feature that is unavailable is marked `aria-disabled`. |
| `e2e/databaseWizard.spec.js`, `e2e/dockerPostgres.spec.js` | Submit the sign-in form with Enter. |

In the source, the shared pieces that make this possible are: `StepFrame` (`setup/ui.tsx`) moves focus to the step heading when the step changes; `ErrorSummary` is a `role="alert"` box that takes focus and links each problem to its field; `LiveRegion` announces progress; the stepper is a labelled navigation with `aria-current="step"`; `setup.css` draws a `:focus-visible` outline on the wizard and its journeys; `Modal` closes on Escape.

## What the keyboard-only journey checks

`e2e/operatorKeyboard.spec.js` is provider-free and uses no mouse: every action is Tab, Shift+Tab, Enter, Space, an arrow key or Escape. The wizard half runs against a throwaway installation under the OS temp folder with the manager started in process (`e2e/setupHarness.js`); the Host half runs the e2e portal with a real manager process behind it (`e2e/hostHarness.js`), so the Features, Connections, Instance Defaults, Installation, Database and Maintenance pages show their real content rather than the "manager unavailable" notice. Nothing is installed or changed on the machine.

For each page below, the same checks run on every control a person can act on:

1. Tab reaches it (a radio group counts once; the arrow keys move inside it).
2. It has an accessible name: `aria-label`, `aria-labelledby`, an associated `<label>`, or visible text.
3. The browser draws a focus indicator (an outline or a shadow, under `:focus-visible`).
4. Tab can leave the page area: focus is not trapped.

| Page | Checked by keyboard |
| --- | --- |
| Setup sign-in (`/manager/`) | First Tab lands on the setup credential, then the installation name; every control reached, named and showing focus; typing the credential and pressing Enter signs in, and focus lands on the next step's heading. |
| Setup steps Where, Features, Connections, Database, Defaults, Access | Each step's heading takes focus on arrival; every control reachable, named, showing focus; no trap; the credentials fields take typed input; the Database step's radio group moves with ArrowDown and ArrowUp; Enter on Continue moves to the next step. |
| Setup Review | The same checks, including that the Install button is reachable. The Install action itself is not pressed. |
| Step list (stepper) | A labelled navigation; exactly one `aria-current="step"`; earlier steps are links and Enter returns to that step, whose heading takes focus. |
| A step with a problem | Two passwords that differ produce a `role="alert"` summary that takes focus; Tab reaches a link that names the problem; Enter on it focuses the field. |
| Host page list | Tab reaches the seven pages in order, in a navigation named "Host pages"; Enter opens each; the current page is marked `aria-current="page"`. |
| Host Overview, Features, Connections, Instance Defaults, Installation, Database, Maintenance | The four checks, on the page as it first renders with the manager reachable. |
| Host Features | Space switches a feature on and off; the preview button follows whether anything changed. |
| Confirm dialog (Accounts list on Host Overview) | Enter on a button opens it; it has Cancel and Confirm buttons; Escape closes it with nothing changed; Enter on Cancel closes it with nothing changed. See the gaps below. |

### What the journey does not cover

- The setup steps after Review: Install progress, the first-run check and the Done page.
- The maintenance journeys' later steps: Reconfigure, Repair, Uninstall, Backup, Restore, Reset, Migration and the database journey beyond the page each opens on. Their pages use the same components, and the same helper can be pointed at them, but no test does it yet.
- The Host pages in states other than the first render (a failed preview, the applied notice, a pending restart countdown).
- Any browser other than Chromium, and any operating system other than the one the test runs on.

## What remains a human check

A test cannot decide these. Each needs a person with the tool, once per release that changes the page:

- **Screen reader pass.** Whether a step change is announced sensibly (heading focus), whether `role="alert"` summaries and `aria-live` regions are read once and not repeatedly, whether the stepper and the Host page list are understandable, and whether the progress and restart countdowns are usable. Suggested pairs: NVDA with Firefox or Chrome on Windows, VoiceOver with Safari on macOS, Orca with Firefox on Linux.
- **Colour contrast.** Text and focus-outline contrast in the light and the dark theme, the hint text, the danger text, disabled controls, and the badge colours. No check measures a ratio.
- **Zoom and reflow.** 200 percent and 400 percent zoom. The only width check is the 360 px test in `e2e/setupWizard.spec.js`, and it covers the setup steps, not the Host pages.
- **Windows high-contrast mode and forced colours**, reduced motion, and touch target size.
- **Plain-language review** of error messages and the "what this cannot do" statements, by someone who did not write them.

## Gaps found by the review

The review ran the confirm dialog (`apps/web/src/components/Modal.tsx`, used through `useConfirm` by every Host confirmation, such as disabling an account, issuing a reset link, a restart and an update) from the keyboard. Escape and the two buttons work. Four things do not, and the spec records them as `known-gap` annotations on the test instead of failing it, so a fix shows up as the annotation disappearing:

1. When the dialog opens, focus stays on the control behind it instead of moving into the dialog.
2. Tab leaves the dialog for the page behind it: there is no focus trap.
3. The dialog has `role="dialog"` and `aria-modal="true"` but no accessible name (`aria-label` or `aria-labelledby`).
4. When the dialog closes, focus is not returned to the control that opened it; it falls to the page.

These are changes to a shared component, so they were recorded here and not made as part of this review. [development_standards_and_project_goals.md](development_standards_and_project_goals.md) used to say the dialog had a focus trap and focus restore; it now says what the component does.

## Guided tours for these pages

Guided tours ([guided_tutorials_spec.md](guided_tutorials_spec.md), #272) run inside the portal, so none covers the setup wizard, which is served by the manager outside it. The tour catalog (`packages/core/config/tutorialCatalog.js`, counted in the Tours column of [features.md](features.md)) registers 29 tours: 13 core, 9 music, 1 exchange, 4 projects, 1 knowledge and 1 expeditions. Fifteen have authored steps today and fourteen are registered with no steps yet.

- Authored: `home.orientation`, `home.first-task`, `chat.basics`, `activity.inbox`, `activity.scheduled`, `settings.basics`, `memory.basics`, `usage.basics`, `admin.instance`, `projects.basics`, `projects.plans`, `projects.runs`, `projects.apps`, `knowledge.basics`, `knowledge.research`.
- Registered without steps: `discussions.basics`, `tools.overview`, `decks.basics`, `connections.basics`, the nine `music.*` tours and `trading.basics`.

The one tour for an operator page is `admin.instance`: six steps on the Host room (invitation preview, revoking access, disabling an account, aggregate capacity, a token cap preview and a failed integration). It is operator-only. No tour covers the Features, Connections, Installation, Database or Maintenance pages. Authoring the remaining tours belongs to #272 and is not claimed here; whether a tour is itself keyboard and screen-reader friendly is not part of this review.

## Running the check

```sh
npm run build:web
npm run test:e2e:install     # first time on a machine: Chromium
npm run test:e2e -- e2e/operatorKeyboard.spec.js
```

The spec needs no provider key, no Discord token and no network. The Host half uses two extra local ports, `GOOBSTER_E2E_PORT` plus 130 for the portal and plus 131 for the manager (4303 and 4304 by default); set `GOOBSTER_E2E_KEYBOARD_PORTAL_PORT` and `GOOBSTER_E2E_KEYBOARD_MANAGER_PORT` to move them. The wizard half picks free ports itself.
