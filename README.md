# Grid CLI Tool

A command-line tool for managing Intech Studio Grid controller configurations.

## Features

- **Pull**: Download configurations from a connected Grid device as editable Lua files
- **Push**: Upload Lua configurations back to the device
- **Round-trip fidelity**: Edit configurations in your favorite editor, version control with git
- **Human-readable format**: Configurations are saved as properly formatted Lua with comments

## LLM Integration

**For AI assistants**: See [LLM_CONTEXT.md](LLM_CONTEXT.md) for comprehensive documentation on editing Grid configurations, including module types, Lua API reference, and common patterns.

## Installation

```bash
npm install
npm run build
```

## Usage

```bash
# List connected devices
node dist/cli.js devices

# Download configuration to a directory
node dist/cli.js pull ./my-config

# Pull specific pages only
node dist/cli.js pull ./my-config --pages 0,1

# Upload configuration from a directory  
node dist/cli.js push ./my-config

# Push specific pages only
node dist/cli.js push ./my-config --pages 0

# Push the same config to every connected module with matching type
node dist/cli.js push ./my-config --all

# Push without saving to flash (temporary)
node dist/cli.js push ./my-config --no-store
```

## File Format

Configurations are saved as human-readable Lua files:

```
my-config/
├── manifest.json
├── 01-po16/
│   ├── module.json
│   └── page-0.lua
├── 02-pbf4/
│   ├── module.json
│   ├── page-0.lua
│   └── page-1.lua
└── ...
```

Each page file contains event handlers:

```lua
-- grid: page=0

-- grid:event element=0 event=potmeter
--[[@gpl]]
local num = self:element_index()
local val = self:potmeter_value()
led_color(num, 1, val * 2, 0, 0)
midi_send(0, 176, num, val)

-- ============================================================

-- grid:event element=1 event=button
--[[@gpl]]
if self:button_value() > 0 then
  led_color(self:element_index(), 1, 255, 0, 0)
end
```

## Supported Modules

| Type | Description |
|------|-------------|
| PO16 | 16 potentiometers |
| BU16 | 16 buttons |
| PBF4 | 4 faders + 4 buttons |
| EN16 | 16 encoders |
| EF44 | 4 encoders + 4 faders |
| TEK2 | 2 endless touch strips |
| VSN1L | Vision module (display) |

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev -- devices

# Build
npm run build

# Test
npm test

# Lint
npm run lint
```

## License

MIT
