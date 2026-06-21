# Klipper VS Code Extension Project Notes

## Original Request

Set up a Visual Studio Code extension project for helping write Klipper configurations.

Requested features:

- Syntax highlighting.
- A Moonraker connection to a live 3D printer.
- Using the Moonraker connection, show IntelliSense suggestions for variables in G-Code macros, such as suggesting available objects after typing `printer.`.
- Using the Moonraker connection, show syntax errors for objects that do not exist in G-Code macros.
- Using the Moonraker connection, evaluate a Jinja2 expression, either the selected text or an entire G-Code macro, and open the rendered result in a new document.
- Using the Moonraker connection, evaluate a Jinja2 expression, either the selected text or an entire G-Code macro, and run the rendered result directly on the printer.

Additional requested feature:

- When hovering over a variable in a G-Code macro, such as `printer.extruder.target`, show the realtime value.
- Add a peek-style inline render command, similar to Peek Definition, for rendered macro output.
- Add a command palette flow named `Klipper: Set Moonraker Connection` that asks for the printer IP address and saves the Moonraker connection.
- Resolve indirect Jinja references created with `{% set ... = printer[...] %}`, such as resolving `settings.heatsoak` after `{% set settings = printer['gcode_macro _COSMOS_SETTINGS']|default({}) %}`.
- Resolve bare variables assigned from printer references, such as hovering `all_calibrated` after `{% set all_calibrated = printer["gcode_macro _CHECK_CALIBRATION_VARS"].all_calibrated %}`.
- Improve syntax highlighting so semicolon comments such as `; Move to the tray` are greyed out, and Klipper-style uppercase commands such as `BED_MESH_CLEAR` plus their arguments are highlighted.
- Add inline shadow-text-like annotations next to Jinja `{% if ... %}` / `{% elif ... %}` conditions showing `-> True` or `-> False` when they can be evaluated. If evaluation fails, show nothing.
- Refresh visible inline condition hints every second, and show no condition hints while Moonraker is disconnected.
- After rendering G-Code, remove all empty or whitespace-only lines before showing previews or sending to the printer.
- Render cleanup should also remove comments from `;` or `#` onward before whitespace cleanup, and trim leading/trailing whitespace from retained lines.
- Fix rendering of Klipper single-brace macro expressions such as `{global.extruder_temp.purging}` so they are evaluated instead of emitted literally.
- Condition hints should not show `-> False` when a variable cannot be resolved. If a context-specific parameter is missing but has a Jinja `default(...)`, use the default for subsequent `{% set ... %}` variables, such as `{% set state = params.STATE|default('normal') %}`.
- Evaluate non-literal `default(...)` fallback expressions for condition-hint `{% set %}` variables, such as `{% set bed_temp = params.BED_TEMP|default(printer.heater_bed.target if printer.heater_bed.target > 0 else 60)|float %}`.

The user said Klipper source may be referenced if useful, and to ask if cloning Klipper into a temp directory is needed.

## User Instructions

- If unsure or lacking necessary information, ask the user.
- Keep this file updated with new requests, current implementation progress, and relevant context so the work can be resumed at any time.
- Follow-up agents must also update this file with their current status, progress, blockers, and relevant implementation context before they stop.
- After every new feature, change, session, or similar work item, make a new git commit that clearly outlines the changes.

## Current Progress

- Repository started empty except for `.git`.
- Local dependencies detected:
  - Node.js `v22.13.0`
  - npm `10.9.2`
  - git `2.47.1.windows.1`
- Created a TypeScript VS Code extension scaffold in `D:\Dev\klipper-vsc`.
- Added TextMate grammar and language configuration for Klipper `.cfg` files.
- Added Moonraker JSON-RPC client over WebSocket.
- Added live printer object cache populated from Moonraker `printer.objects.list` and `printer.objects.query`.
- Added completion provider for `printer.<object>` and nested printer object paths.
- Added diagnostics for unresolved `printer.<object>` references inside Jinja blocks.
- Added local Jinja-like rendering using `nunjucks`, with live printer object status injected as `printer`.
- Added render-to-new-document and render-and-run commands.
- Added `Klipper: Peek Rendered Selection or Macro`, backed by a `klipper-rendered:` virtual document and VS Code's `editor.action.peekLocations` command, with a side-document fallback if peek cannot be opened.
- Added realtime hover support for `printer...` references. The hover provider queries Moonraker for the root object at hover time and falls back to the cached status if the live query fails.
- Added `Klipper: Set Moonraker Connection`, which prompts for an IP address, hostname, or full URL, normalizes it to a Moonraker WebSocket URL, saves `klipper.moonrakerUrl`, and offers to connect immediately.
- Fixed Moonraker connection normalization so an explicitly entered port is preserved, including `:80`. Plain hosts without a port still default to `:7125`.
- Added Jinja alias resolution for hover and completion. Simple `{% set alias = printer... %}` assignments before the cursor are mapped back to the printer object path, including assignments with filters such as `|default({})`.
- Added bare Jinja variable hover resolution for aliases assigned from printer paths, including hovering the variable name inside the current `{% set ... %}` block.
- Fixed local render failures from Nunjucks string filters on non-string values, such as `TypeError: str.toLowerCase is not a function`, by overriding common string filters (`string`, `lower`, `upper`, `capitalize`, `title`, `trim`) with Jinja-style string coercion.
- Improved TextMate grammar syntax highlighting for semicolon comments, Klipper-style uppercase commands, compact G-Code arguments, and uppercase `ARG=value` style arguments.
- Added inline condition result hints for evaluable `{% if ... %}` and `{% elif ... %}` expressions. The setting `klipper.conditionHints.enabled` controls the feature. Failed condition evaluation is intentionally silent.
- Replaced the original editor decoration implementation with a VS Code `InlayHintsProvider` because decoration-based hints did not render reliably. Hints refresh every second and are hidden while Moonraker is disconnected.
- Added a final render cleanup pass that removes comments, trims retained lines, and removes empty/whitespace-only lines from rendered G-Code output. This applies to render preview, peek render, and render-and-run because they share `renderTemplate`.
- Configured the local Nunjucks environment to use Klipper-style single-brace variable tags (`{...}`) while retaining Jinja block tags (`{% ... %}`). This fixes rendered output that previously preserved expressions such as `{global.extruder_temp.purging}`.
- Updated condition hint evaluation to collect earlier `{% set ... %}` blocks, apply simple `default(...)` values for unresolved params/paths, and skip hints when any referenced variable remains unresolved instead of showing misleading `-> False`.
- Follow-up fix: condition hints no longer require a non-empty Moonraker object-name cache; they only require Moonraker to be connected, then each condition independently skips if referenced values cannot resolve. Hover alias tracking now supports literal defaults such as `{% set state = params.STATE|default('normal') %}`, so hovering `state` can show `"normal"` instead of only supporting aliases to printer paths.
- Follow-up fix: user reported editor hints still were not showing after simplification. The current implementation uses `ConditionHintsController` in `src/conditionInlayHints.ts` with editor decorations instead of VS Code's inlay hint provider, so condition hints no longer depend on global editor inlay hint settings. Hints still refresh every second, refresh immediately when visible ranges change, and remain hidden while Moonraker is disconnected.
- Restored condition-hint reference validation before rendering conditions. Unresolved variables now skip the hint instead of rendering misleading `-> False`, while defaults from earlier `{% set ... = ...|default(...) %}` blocks are still respected.
- Added temporary condition-hint logging to the `Klipper VSC` output channel. It reports activation, condition hint controller initialization, visible editor language IDs, connection/enabled state, cached object count, visible line count, detected condition count, rendered hint count, skipped count, and one-time evaluation failure details. Decorations now attach immediately after the Jinja condition block instead of the end of the physical line.
- Fixed condition evaluation failures caused by rendering all prior `{% set ... %}` blocks with the Klipper single-brace Nunjucks environment. Condition hints now evaluate in a standard Jinja/Nunjucks environment and use a resolved context built from supported prior set blocks, avoiding parse failures on defaults like `default({})`. Also fixed bracket-path set alias resolution by preserving quote delimiters while masking string contents.
- Fixed condition-hint set-variable resolution for non-literal `default(...)` fallbacks. Supported `{% set %}` expressions are now evaluated through the condition Nunjucks environment once their real references resolve, so defaults such as `printer.heater_bed.target if printer.heater_bed.target > 0 else 60` populate variables like `bed_temp`. Jinja inline `if` / `else` keywords are ignored by reference validation instead of being treated as unresolved variables.
- Fixed peek/render failures for macros that combine Klipper single-brace expressions with Jinja object literals such as `default({})`. The renderer now normalizes Klipper `{expression}` output tags to standard Nunjucks `{{ expression }}` tags before parsing, while preserving `{% ... %}` blocks and `{# ... #}` comments unchanged.
- Render preview, peek render, and render-and-run now force a fresh Moonraker printer object query before evaluating the macro when connected, so rendered expressions are based on current printer state rather than the previous cache snapshot.
- Visible condition hints now force a quiet Moonraker object refresh every 5 seconds before repainting `-> True` / `-> False`, while still clearing hints when disconnected and refreshing immediately on editor changes.
- Added a GitHub Actions workflow at `.github/workflows/package-extension.yml` that runs on push, pull request, and manual dispatch. It installs dependencies with `npm ci`, compiles the extension, packages a commit-specific VSIX with `@vscode/vsce`, and uploads it as a workflow artifact.
- Installed npm dependencies with `npm install`.
- Verified the project compiles with `npm run compile`.

## Important Implementation Notes

- Rendering uses JavaScript `nunjucks`, which is compatible with much of Jinja2 but is not Klipper's Python Jinja2 engine. Treat this as a practical local preview/execution renderer, not a byte-for-byte Klipper renderer.
- Running rendered text sends the rendered G-Code to Moonraker via `printer.gcode.script`.
- If exact Klipper macro semantics become necessary, inspect or clone the Klipper source and mirror more of Klipper's macro context and helper functions.
- `printer` object completions insert dot access for simple object names and bracket access for object names containing spaces, such as `printer["gcode_macro START_PRINT"]`.
- Diagnostics currently validate dot-access object roots like `printer.toolhead` inside Jinja blocks. Bracket-access validation and deeper semantic checks are good follow-up work.
- Hover values are resolved for dot paths such as `printer.extruder.target` and bracket paths such as `printer["gcode_macro START_PRINT"].variable_state`.
- Fixed hover/completion path resolution for Moonraker arrays. Array values now support numeric indexes and Klipper-style axis aliases: `x`, `y`, `z`, and `e`. This fixes paths such as `printer.gcode_move.position.z`, where Moonraker reports `position` as `[x, y, z, e]`.
- Local rendering/evaluation now clones printer arrays with Klipper-style `x`, `y`, `z`, and `e` aliases so expressions such as `printer.gcode_move.position.z` can evaluate.
- Fixed Jinja `{% set %}` variables whose value falls back through `default(...)` to another resolved reference. Hover/completion alias tracking and condition-hint evaluation now preserve reference paths through fallback expressions such as `params.EXTRUDER_TEMP|default(settings.extruder_temp.loading)|int`, so the assigned variable resolves through the referenced printer object instead of remaining unknown.
- Follow-up fix: complex `default(...)` fallback expressions that are not simple paths, such as `printer.heater_bed.target if printer.heater_bed.target > 0 else 60`, are now evaluated with the current printer context for bare variable hover. Direct reference fallbacks still preserve printer paths.

## TODO

- If condition hints still do not appear in a real VS Code Extension Host session, inspect the `Klipper VSC` output channel and the Extension Host log while connected to Moonraker.
