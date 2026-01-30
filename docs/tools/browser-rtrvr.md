---
title: rtrvr Browser Integration
description: Use rtrvr as a browser automation relay for OpenClaw
---

# rtrvr Browser Integration

OpenClaw supports [rtrvr](https://www.rtrvr.ai/) as an alternative browser automation provider. rtrvr offers both extension-based browser control (similar to OpenClaw's Chrome extension relay) and cloud-based browser automation.

## Overview

rtrvr provides two modes of operation:

1. **rtrvr Extension Mode** (`driver: "rtrvr"`) - Uses the rtrvr Chrome extension to control your browser. Requires the rtrvr extension installed and signed in.

2. **rtrvr Cloud Mode** (`driver: "rtrvr-cloud"`) - Uses rtrvr's cloud browsers for automation. No extension required, but each action consumes credits.

## Setup

### 1. Get an rtrvr API Key

1. Sign up at [rtrvr.ai](https://www.rtrvr.ai/)
2. Navigate to Settings > API Keys
3. Create a new API key
4. Copy the key (format: `rtrvr_xxx...`)

### 2. Configure OpenClaw

Add an rtrvr profile to your OpenClaw configuration:

```json
{
  "browser": {
    "profiles": {
      "rtrvr": {
        "driver": "rtrvr",
        "rtrvrApiKey": "rtrvr_your_api_key_here",
        "color": "#6366F1"
      },
      "rtrvr-cloud": {
        "driver": "rtrvr-cloud",
        "rtrvrApiKey": "rtrvr_your_api_key_here",
        "color": "#8B5CF6"
      }
    }
  }
}
```

### 3. Install rtrvr Extension (for extension mode)

If using `driver: "rtrvr"`:

1. Install the rtrvr Chrome extension from the Chrome Web Store
2. Sign in to the extension with your rtrvr account
3. The extension will appear as an available device

## Configuration Options

| Option | Required | Description |
|--------|----------|-------------|
| `driver` | Yes | `"rtrvr"` for extension mode, `"rtrvr-cloud"` for cloud mode |
| `rtrvrApiKey` | Yes | Your rtrvr API key |
| `rtrvrDeviceId` | No | Specific device ID to use (for extension mode with multiple devices) |
| `rtrvrApiUrl` | No | Custom API endpoint (defaults to rtrvr's production API) |
| `color` | Yes | Profile accent color (hex) |

## Usage

### Using rtrvr Profile

Specify the rtrvr profile when using browser actions:

```bash
# Check status
openclaw browser status --profile rtrvr

# List tabs (extension mode only)
openclaw browser tabs --profile rtrvr

# Open a URL
openclaw browser open https://example.com --profile rtrvr

# Take a snapshot
openclaw browser snapshot --profile rtrvr
```

### Via Browser Tool

In agent mode, specify the profile parameter:

```json
{
  "action": "snapshot",
  "profile": "rtrvr-cloud"
}
```

## Available Actions

### Extension Mode (`rtrvr`)

| Action | Description |
|--------|-------------|
| `status` | Check if extension is connected |
| `tabs` | List open browser tabs |
| `open` | Open URL in new tab |
| `close` | Close a tab |
| `focus` | Focus a tab |
| `navigate` | Navigate to URL |
| `snapshot` | Get page accessibility tree |
| `act` | Execute browser actions (click, type, etc.) |

### Cloud Mode (`rtrvr-cloud`)

| Action | Description |
|--------|-------------|
| `status` | Check API connectivity and credits |
| `open` | Scrape a URL (creates synthetic tab) |
| `snapshot` | Get page content via cloud scrape |
| `act` | Execute actions via cloud agent |

## Advanced Features

### AI-Powered Actions

rtrvr supports AI-powered browser automation through the `actOnTab` and `cloudAgent` APIs. These allow natural language instructions:

```json
{
  "action": "act",
  "profile": "rtrvr",
  "request": {
    "kind": "ai",
    "userInput": "Fill out the contact form with test data and submit"
  }
}
```

### Data Extraction

Extract structured data from web pages:

```json
{
  "action": "extract",
  "profile": "rtrvr",
  "request": {
    "userInput": "Extract all product names and prices",
    "schema": {
      "fields": [
        { "name": "productName", "type": "string" },
        { "name": "price", "type": "number" }
      ]
    }
  }
}
```

## Credits and Usage

- **Free tools**: `get_browser_tabs`, `get_page_data`, `take_page_action`, `execute_javascript`
- **Credit tools**: `planner`, `act_on_tab`, `extract_from_tab`, `crawl_and_extract_from_tab`, `cloud_scrape`, `cloud_agent`

Check your credit balance:

```bash
openclaw browser status --profile rtrvr
```

## Troubleshooting

### Extension Not Connected

If you see "No rtrvr extension device is online":

1. Ensure the rtrvr Chrome extension is installed
2. Open Chrome and click the rtrvr extension icon
3. Sign in with your rtrvr account
4. The extension should show as "Online"

### API Key Invalid

If you see authentication errors:

1. Verify your API key is correct
2. Check if the key has expired
3. Generate a new key if needed

### Credits Exhausted

If you see "Insufficient credits":

1. Check your credit balance at rtrvr.ai
2. Purchase more credits or upgrade your plan
3. Consider using free tools when possible

## Comparison with Native Browser Control

| Feature | Native OpenClaw | rtrvr Extension | rtrvr Cloud |
|---------|-----------------|-----------------|-------------|
| Local browser control | Yes | Yes | No |
| Screenshot | Yes | No | No |
| Accessibility tree | Yes | Yes | Yes |
| AI actions | No | Yes | Yes |
| Data extraction | Limited | Yes | Yes |
| No extension needed | Via managed profile | No | Yes |
| Credits required | No | Some features | Yes |

## See Also

- [Browser Tool](/tools/browser) - Native browser automation
- [Chrome Extension](/tools/chrome-extension) - OpenClaw's Chrome extension
- [rtrvr Documentation](https://www.rtrvr.ai/docs/mcp) - rtrvr API documentation
