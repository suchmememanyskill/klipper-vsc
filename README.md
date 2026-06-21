> [!WARNING]
> This repository is AI generated. Use at your own risk!

# Klipper VSC

VS Code extension project for writing Klipper configuration files with Moonraker-assisted macro tooling.

## Features

- Klipper `.cfg` syntax highlighting.
- Command palette setup for the printer IP/hostname through `Klipper: Set Moonraker Connection`.
- Moonraker WebSocket connection command.
- IntelliSense for live `printer` objects inside Jinja expressions.
- Diagnostics for unresolved `printer.<object>` references.
- Render selected Jinja/Klipper macro text into a new document.
- Peek rendered selected Jinja/Klipper macro text inline using VS Code's peek UI, with a side-document fallback.
- Render selected Jinja/Klipper macro text and send the resulting G-Code to Moonraker.

## Development

Install dependencies:

```powershell
npm install
```

Compile:

```powershell
npm run compile
```

Run the extension:

1. Open this folder in VS Code.
2. Press `F5` and choose `Run Extension`.
3. Open a `.cfg` file.
4. Run `Klipper: Connect to Moonraker` from the command palette.

## Moonraker URL

The default URL is:

```text
ws://localhost:7125/websocket
```

Change it in VS Code settings with `klipper.moonrakerUrl`.

You can also run `Klipper: Set Moonraker Connection` from the command palette and enter a printer IP address or hostname. For example, `192.168.1.25` is saved as:

```text
ws://192.168.1.25:7125/websocket
```

## Rendering Limitations

Local rendering uses `nunjucks` with live Moonraker printer status injected into the template context. This supports common Jinja syntax, but Klipper uses Python Jinja2 internally and provides additional helper behavior. Exact parity with Klipper may require a follow-up implementation that mirrors Klipper's macro context more closely.
