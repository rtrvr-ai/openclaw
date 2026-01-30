/**
 * rtrvr.ai Browser Provider
 *
 * Maps OpenClaw browser operations to rtrvr.ai API calls.
 * Supports both extension-based (rtrvr) and cloud-only (rtrvr-cloud) modes.
 *
 * Extension Mode (rtrvr):
 *   - Controls user's local Chrome via rtrvr.ai extension
 *   - Uses MCP API at https://mcp.rtrvr.ai
 *   - get_page_data returns enriched accessibility tree
 *   - Supports free tools (tabs, page data, actions) and credit tools (AI actions)
 *
 * Cloud Mode (rtrvr-cloud):
 *   - Uses rtrvr.ai's cloud browser infrastructure
 *   - Uses Agent API at https://api.rtrvr.ai/agent
 *   - /scrape returns accessibility tree
 *   - No extension required, all operations use credits
 *
 * Note: rtrvr.ai provides accessibility trees, NOT screenshots.
 */

import type { BrowserProfileConfig } from "../config/config.js";
import type { BrowserStatus, BrowserTab, ProfileStatus, SnapshotResult } from "./client.js";
import {
  createRtrvrClient,
  type RtrvrClient,
  type RtrvrClientConfig,
  type RtrvrPageAction,
  type RtrvrTab,
  type RtrvrSchema,
  type SystemToolName,
} from "./rtrvr-client.js";

export type RtrvrProviderConfig = {
  profileName: string;
  profile: BrowserProfileConfig;
};

/** OpenClaw action kinds mapped to rtrvr.ai system tools */
type OpenClawActKind =
  | "click"
  | "type"
  | "press"
  | "hover"
  | "scroll"
  | "navigate"
  | "wait"
  | "close"
  | "back"
  | "forward"
  | "refresh"
  | "clear"
  | "focus"
  | "select"
  | "drag"
  | "upload";

/**
 * rtrvr.ai Browser Provider
 *
 * Provides a bridge between OpenClaw's browser tool and the rtrvr.ai API.
 */
export class RtrvrProvider {
  private client: RtrvrClient;
  private profileName: string;
  private profile: BrowserProfileConfig;
  private isCloudMode: boolean;

  /**
   * Cache of tabs for cloud mode (since cloud browsers are ephemeral)
   * Maps targetId -> { url, title, tree }
   */
  private cloudTabCache: Map<string, { url: string; title?: string; tree?: string }> = new Map();

  /**
   * Cache of extension tabs for consistent targetId mapping
   * Maps targetId -> tabId
   */
  private extensionTabCache: Map<string, number> = new Map();

  constructor(config: RtrvrProviderConfig) {
    const { profileName, profile } = config;

    if (!profile.rtrvrApiKey) {
      throw new Error(`rtrvr.ai API key is required for profile "${profileName}"`);
    }

    this.profileName = profileName;
    this.profile = profile;
    this.isCloudMode = profile.driver === "rtrvr-cloud";

    const clientConfig: RtrvrClientConfig = {
      apiKey: profile.rtrvrApiKey,
      deviceId: profile.rtrvrDeviceId,
    };

    this.client = createRtrvrClient(clientConfig);
  }

  // ==========================================================================
  // Status & Lifecycle
  // ==========================================================================

  /**
   * Get browser status
   */
  async getStatus(): Promise<BrowserStatus> {
    try {
      if (this.isCloudMode) {
        // Cloud mode: check API connectivity and credits
        const credits = await this.client.getCredits();
        const creditsInfo = credits.creditsRemaining ?? credits.creditsLeft ?? "unknown";

        return {
          enabled: true,
          profile: this.profileName,
          running: true, // Cloud is always "running"
          cdpReady: false, // No CDP in cloud mode
          pid: null,
          cdpPort: 0,
          chosenBrowser: "rtrvr-cloud",
          userDataDir: null,
          color: this.profile.color,
          headless: true,
          attachOnly: true,
          detectedBrowser: `rtrvr.ai Cloud (credits: ${creditsInfo})`,
        };
      }

      // Extension mode: check if device is online
      const { online, devices } = await this.client.listDevices();
      const deviceId = this.profile.rtrvrDeviceId;

      // Find target device or first online device
      const targetDevice = deviceId
        ? devices.find((d) => d.deviceId === deviceId)
        : devices.find((d) => d.online);

      const isOnline = targetDevice?.online ?? false;

      return {
        enabled: true,
        profile: this.profileName,
        running: online && isOnline,
        cdpReady: online && isOnline,
        pid: null,
        cdpPort: 0,
        chosenBrowser: "rtrvr-extension",
        userDataDir: null,
        color: this.profile.color,
        headless: false,
        attachOnly: true,
        detectedBrowser: targetDevice
          ? `rtrvr.ai Extension (${targetDevice.deviceName ?? targetDevice.deviceId})`
          : online
            ? "rtrvr.ai Extension (no device selected)"
            : "rtrvr.ai Extension (offline)",
        detectedExecutablePath: targetDevice?.deviceId ?? null,
      };
    } catch (err) {
      return {
        enabled: true,
        profile: this.profileName,
        running: false,
        cdpReady: false,
        pid: null,
        cdpPort: 0,
        chosenBrowser: this.isCloudMode ? "rtrvr-cloud" : "rtrvr-extension",
        userDataDir: null,
        color: this.profile.color,
        headless: this.isCloudMode,
        attachOnly: true,
        detectError: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Get profile status
   */
  async getProfileStatus(): Promise<ProfileStatus> {
    const status = await this.getStatus();
    let tabCount = 0;

    if (status.running && !this.isCloudMode) {
      try {
        const { tabs } = await this.client.getBrowserTabs();
        tabCount = tabs.length;
      } catch {
        // Ignore tab count errors
      }
    } else if (this.isCloudMode) {
      tabCount = this.cloudTabCache.size;
    }

    return {
      name: this.profileName,
      cdpPort: 0,
      cdpUrl: this.isCloudMode ? "https://api.rtrvr.ai" : "https://mcp.rtrvr.ai",
      color: this.profile.color,
      running: status.running,
      tabCount,
      isDefault: false,
      isRemote: true,
    };
  }

  /**
   * Start browser (verifies connectivity)
   */
  async start(): Promise<void> {
    if (this.isCloudMode) {
      // Cloud mode: verify API connectivity
      await this.client.getCredits();
      return;
    }

    // Extension mode: verify device is online
    const { online, devices } = await this.client.listDevices();

    if (!online || devices.length === 0) {
      throw new Error(
        `No rtrvr.ai extension device is online for profile "${this.profileName}". ` +
          "Install the rtrvr.ai Chrome extension and sign in: " +
          "https://chromewebstore.google.com/detail/rtrvrai/jldogdgepmcedfdhgnmclgemehfhpomg",
      );
    }

    const deviceId = this.profile.rtrvrDeviceId;
    if (deviceId) {
      const targetDevice = devices.find((d) => d.deviceId === deviceId);
      if (!targetDevice?.online) {
        throw new Error(
          `rtrvr.ai device "${deviceId}" is not online for profile "${this.profileName}". ` +
            "Open Chrome with the rtrvr.ai extension installed.",
        );
      }
    }
  }

  /**
   * Stop browser (no-op for rtrvr.ai)
   */
  async stop(): Promise<void> {
    // rtrvr.ai browsers are managed externally
    // Cloud browsers are ephemeral, extension is user-controlled
  }

  // ==========================================================================
  // Tab Management
  // ==========================================================================

  /**
   * Get browser tabs
   */
  async getTabs(): Promise<BrowserTab[]> {
    if (this.isCloudMode) {
      // Cloud mode: return cached tabs (cloud browsers are ephemeral)
      return Array.from(this.cloudTabCache.entries()).map(([targetId, data]) => ({
        targetId,
        title: data.title ?? data.url,
        url: data.url,
        type: "page" as const,
      }));
    }

    // Extension mode: get tabs from extension
    const { tabs } = await this.client.getBrowserTabs();
    return tabs.map((tab) => this.convertExtensionTab(tab));
  }

  /**
   * Open a new tab with URL
   */
  async openTab(url: string): Promise<BrowserTab> {
    if (this.isCloudMode) {
      // Cloud mode: use /scrape to fetch the page and get accessibility tree
      const result = await this.client.cloudScrape({ url });

      const targetId = `rtrvr-cloud-${Date.now()}`;
      this.cloudTabCache.set(targetId, {
        url: result?.url ?? url,
        title: result?.title,
        tree: result?.tree ?? result?.text,
      });

      return {
        targetId,
        title: result?.title ?? url,
        url: result?.url ?? url,
        type: "page",
      };
    }

    // Extension mode: open new tab using system tool
    await this.client.takePageAction({
      actions: [{ tool_name: "open_new_tab", args: { url } }],
    });

    // Wait briefly for tab to open, then get the new tab
    await new Promise((r) => setTimeout(r, 500));
    const { tabs } = await this.client.getBrowserTabs();
    const newTab =
      tabs.find((t) => t.url === url || t.url.startsWith(url)) ?? tabs[tabs.length - 1];

    if (newTab) {
      return this.convertExtensionTab(newTab);
    }

    // Fallback if tab not found
    const targetId = `rtrvr-ext-${Date.now()}`;
    return { targetId, title: url, url, type: "page" };
  }

  /**
   * Close a tab
   */
  async closeTab(targetId: string): Promise<void> {
    if (this.isCloudMode) {
      this.cloudTabCache.delete(targetId);
      return;
    }

    const tabId = this.extensionTabCache.get(targetId);
    if (tabId !== undefined) {
      await this.client.takePageAction({
        actions: [{ tab_id: tabId, tool_name: "close_tab", args: {} }],
      });
      this.extensionTabCache.delete(targetId);
    }
  }

  /**
   * Focus a tab
   */
  async focusTab(targetId: string): Promise<void> {
    if (this.isCloudMode) {
      // No-op for cloud mode (no persistent tabs)
      return;
    }

    const tabId = this.extensionTabCache.get(targetId);
    if (tabId !== undefined) {
      // Switch to the tab
      await this.client.takePageAction({
        actions: [{ tool_name: "switch_tab", args: { tab_id: tabId } }],
      });
    }
  }

  /**
   * Navigate to URL
   */
  async navigate(url: string, targetId?: string): Promise<{ ok: true; url: string }> {
    if (this.isCloudMode) {
      // Cloud mode: fetch new page and update cache
      const result = await this.client.cloudScrape({ url });

      if (targetId && this.cloudTabCache.has(targetId)) {
        this.cloudTabCache.set(targetId, {
          url: result?.url ?? url,
          title: result?.title,
          tree: result?.tree ?? result?.text,
        });
      }

      return { ok: true, url: result?.url ?? url };
    }

    // Extension mode: navigate in specified tab or current tab
    const tabId = targetId ? this.extensionTabCache.get(targetId) : undefined;
    await this.client.takePageAction({
      actions: [{ tab_id: tabId, tool_name: "goto_url", args: { url } }],
    });

    return { ok: true, url };
  }

  // ==========================================================================
  // Snapshot (Accessibility Tree - NOT Screenshot)
  // ==========================================================================

  /**
   * Take a snapshot of the page (accessibility tree).
   * Note: rtrvr.ai returns accessibility trees, NOT screenshots.
   */
  async snapshot(opts: { format: "aria" | "ai"; targetId?: string }): Promise<SnapshotResult> {
    if (this.isCloudMode) {
      return this.cloudSnapshot(opts);
    }
    return this.extensionSnapshot(opts);
  }

  private async cloudSnapshot(opts: {
    format: "aria" | "ai";
    targetId?: string;
  }): Promise<SnapshotResult> {
    // Get cached data or throw
    const cached = opts.targetId ? this.cloudTabCache.get(opts.targetId) : undefined;

    if (!cached?.url) {
      throw new Error(
        `No URL available for cloud snapshot. Use action=open with a URL first (profile "${this.profileName}").`,
      );
    }

    // If we don't have tree data, fetch it via /scrape
    let tree = cached.tree;
    if (!tree) {
      const result = await this.client.cloudScrape({ url: cached.url });
      tree = result?.tree ?? result?.text ?? "";
      cached.tree = tree;
    }

    const targetId = opts.targetId ?? `rtrvr-cloud-${Date.now()}`;

    if (opts.format === "aria") {
      return {
        ok: true,
        format: "aria",
        targetId,
        url: cached.url,
        nodes: this.parseAriaNodes(tree),
      };
    }

    return {
      ok: true,
      format: "ai",
      targetId,
      url: cached.url,
      snapshot: tree,
      stats: {
        lines: tree.split("\n").length,
        chars: tree.length,
        refs: this.countRefs(tree),
        interactive: this.countInteractive(tree),
      },
    };
  }

  private async extensionSnapshot(opts: {
    format: "aria" | "ai";
    targetId?: string;
  }): Promise<SnapshotResult> {
    let tabId = opts.targetId ? this.extensionTabCache.get(opts.targetId) : undefined;

    // If no targetId or not found, get active tab
    if (tabId === undefined) {
      const { activeTab, tabs } = await this.client.getBrowserTabs({ filter: "active" });
      const tab = activeTab ?? tabs[0];

      if (!tab) {
        throw new Error(`No active tab found for profile "${this.profileName}"`);
      }

      tabId = tab.id;
    }

    // Get page data (enriched accessibility tree)
    const { trees } = await this.client.getPageData({ tabIds: [tabId] });
    const tree = trees[0];

    if (!tree) {
      throw new Error("Failed to get page data from rtrvr.ai extension");
    }

    const targetId = opts.targetId ?? `rtrvr-ext-${tabId}`;

    if (opts.format === "aria") {
      return {
        ok: true,
        format: "aria",
        targetId,
        url: tree.url,
        nodes: this.parseAriaNodes(tree.tree),
      };
    }

    return {
      ok: true,
      format: "ai",
      targetId,
      url: tree.url,
      snapshot: tree.tree,
      stats: {
        lines: tree.tree.split("\n").length,
        chars: tree.tree.length,
        refs: this.countRefs(tree.tree),
        interactive: this.countInteractive(tree.tree),
      },
    };
  }

  // ==========================================================================
  // Screenshot (NOT SUPPORTED)
  // ==========================================================================

  /**
   * Take a screenshot.
   * Note: rtrvr.ai does not provide screenshot capability.
   * Use snapshot to get the accessibility tree instead.
   */
  async screenshot(_opts: {
    targetId?: string;
    fullPage?: boolean;
    type?: "png" | "jpeg";
  }): Promise<{ ok: false; error: string }> {
    return {
      ok: false,
      error:
        "Screenshots are not supported with rtrvr.ai. " +
        "rtrvr.ai provides enriched accessibility trees via snapshot instead. " +
        "Use action=snapshot for page structure, or AI actions (planner/act) for visual tasks.",
    };
  }

  // ==========================================================================
  // Browser Actions (System Tools)
  // ==========================================================================

  /**
   * Execute a browser action using rtrvr.ai system tools
   */
  async act(request: {
    kind: OpenClawActKind;
    ref?: string;
    text?: string;
    key?: string;
    direction?: string;
    x?: number;
    y?: number;
    url?: string;
    ms?: number;
    targetId?: string;
    value?: string;
    filePath?: string;
  }): Promise<{ ok: true; download?: { path: string } }> {
    if (this.isCloudMode) {
      return this.cloudAct(request);
    }
    return this.extensionAct(request);
  }

  private async cloudAct(request: {
    kind: OpenClawActKind;
    ref?: string;
    text?: string;
    key?: string;
    direction?: string;
    url?: string;
    ms?: number;
    targetId?: string;
  }): Promise<{ ok: true }> {
    // Cloud mode: use AI agent for actions
    const userInput = this.buildActionDescription(request);
    const cached = request.targetId ? this.cloudTabCache.get(request.targetId) : undefined;

    await this.client.cloudAgent({
      userInput,
      urls: cached?.url ? [cached.url] : undefined,
    });

    return { ok: true };
  }

  private async extensionAct(request: {
    kind: OpenClawActKind;
    ref?: string;
    text?: string;
    key?: string;
    direction?: string;
    url?: string;
    ms?: number;
    targetId?: string;
    value?: string;
    filePath?: string;
  }): Promise<{ ok: true }> {
    const tabId = request.targetId ? this.extensionTabCache.get(request.targetId) : undefined;
    const action = this.mapToRtrvrAction(request, tabId);

    await this.client.takePageAction({ actions: [action] });

    return { ok: true };
  }

  // ==========================================================================
  // AI-Powered Actions
  // ==========================================================================

  /**
   * AI-powered action
   */
  async aiAct(opts: {
    userInput: string;
    tabUrls?: string[];
    tabId?: number;
    schema?: RtrvrSchema;
  }): Promise<unknown> {
    if (this.isCloudMode) {
      return this.client.cloudAgent({
        userInput: opts.userInput,
        urls: opts.tabUrls,
        schema: opts.schema,
      });
    }

    return this.client.act(opts);
  }

  /**
   * Extract data from pages
   */
  async extract(opts: {
    userInput: string;
    tabUrls?: string[];
    schema?: RtrvrSchema;
  }): Promise<unknown> {
    if (this.isCloudMode) {
      return this.client.cloudAgent({
        userInput: `Extract the following data: ${opts.userInput}`,
        urls: opts.tabUrls,
        schema: opts.schema,
      });
    }

    return this.client.extract(opts);
  }

  /**
   * Get console messages (not supported)
   */
  async getConsoleMessages(): Promise<{ messages: unknown[] }> {
    return { messages: [] };
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private convertExtensionTab(tab: RtrvrTab): BrowserTab {
    const targetId = `rtrvr-ext-${tab.id}`;
    this.extensionTabCache.set(targetId, tab.id);

    return {
      targetId,
      title: tab.title,
      url: tab.url,
      type: "page",
    };
  }

  private parseAriaNodes(treeString: string): Array<{
    ref: string;
    role: string;
    name: string;
    depth: number;
  }> {
    const lines = treeString.split("\n").filter((l) => l.trim());
    const nodes: Array<{ ref: string; role: string; name: string; depth: number }> = [];

    for (const line of lines) {
      const indentMatch = line.match(/^(\s*)/);
      const depth = indentMatch ? Math.floor(indentMatch[1].length / 2) : 0;

      // Extract ID from [id=N] pattern
      const idMatch = line.match(/\[id=(\d+)\]/);
      const ref = idMatch ? `e${idMatch[1]}` : `e${nodes.length}`;

      // Extract role and name
      const content = line
        .trim()
        .replace(/\[id=\d+\]/, "")
        .trim();
      const parts = content.split(/\s+/);
      const role = parts[0] ?? "generic";
      const name = parts.slice(1).join(" ");

      nodes.push({ ref, role, name, depth });
    }

    return nodes;
  }

  private countRefs(tree: string): number {
    const matches = tree.match(/\[id=\d+\]/g);
    return matches?.length ?? 0;
  }

  private countInteractive(tree: string): number {
    const interactiveRoles = [
      "button",
      "link",
      "textbox",
      "checkbox",
      "radio",
      "combobox",
      "menuitem",
    ];
    let count = 0;
    for (const role of interactiveRoles) {
      const regex = new RegExp(`\\b${role}\\b`, "gi");
      const matches = tree.match(regex);
      count += matches?.length ?? 0;
    }
    return count;
  }

  /**
   * Map OpenClaw action kinds to rtrvr.ai system tools
   */
  private mapToRtrvrAction(
    request: {
      kind: OpenClawActKind;
      ref?: string;
      text?: string;
      key?: string;
      direction?: string;
      url?: string;
      ms?: number;
      value?: string;
      filePath?: string;
    },
    tabId?: number,
  ): RtrvrPageAction {
    const elementId = request.ref ? this.parseRefToElementId(request.ref) : undefined;

    switch (request.kind) {
      case "click":
        return {
          tab_id: tabId,
          tool_name: "click_element",
          args: { element_id: elementId },
        };

      case "type":
        return {
          tab_id: tabId,
          tool_name: "type_into_element",
          args: { element_id: elementId, text: request.text ?? "" },
        };

      case "press":
        return {
          tab_id: tabId,
          tool_name: "press_key",
          args: { key: request.key ?? "Enter" },
        };

      case "hover":
        return {
          tab_id: tabId,
          tool_name: "hover_element",
          args: { element_id: elementId, duration: request.ms },
        };

      case "scroll":
        return {
          tab_id: tabId,
          tool_name: "scroll_page",
          args: {
            direction: (request.direction?.toLowerCase() ?? "down") as
              | "up"
              | "down"
              | "left"
              | "right",
          },
        };

      case "navigate":
        return {
          tab_id: tabId,
          tool_name: "goto_url",
          args: { url: request.url ?? "" },
        };

      case "wait":
        return {
          tab_id: tabId,
          tool_name: "wait_action",
          args: { duration: request.ms ?? 1000 },
        };

      case "close":
        return {
          tab_id: tabId,
          tool_name: "close_tab",
          args: {},
        };

      case "back":
        return {
          tab_id: tabId,
          tool_name: "go_back",
          args: {},
        };

      case "forward":
        return {
          tab_id: tabId,
          tool_name: "go_forward",
          args: {},
        };

      case "refresh":
        return {
          tab_id: tabId,
          tool_name: "refresh_page",
          args: {},
        };

      case "clear":
        return {
          tab_id: tabId,
          tool_name: "clear_element",
          args: { element_id: elementId },
        };

      case "focus":
        return {
          tab_id: tabId,
          tool_name: "focus_element",
          args: { element_id: elementId },
        };

      case "select":
        return {
          tab_id: tabId,
          tool_name: "select_dropdown_value",
          args: { element_id: elementId, value: request.value ?? request.text ?? "" },
        };

      case "drag":
        return {
          tab_id: tabId,
          tool_name: "drag_element",
          args: { element_id: elementId },
        };

      case "upload":
        return {
          tab_id: tabId,
          tool_name: "upload_file",
          args: { element_id: elementId, file_path: request.filePath ?? "" },
        };
    }
  }

  private parseRefToElementId(ref: string): number | undefined {
    const match = ref.match(/^e?(\d+)$/);
    return match ? parseInt(match[1], 10) : undefined;
  }

  private buildActionDescription(request: {
    kind: OpenClawActKind;
    ref?: string;
    text?: string;
    key?: string;
    direction?: string;
    url?: string;
    ms?: number;
  }): string {
    switch (request.kind) {
      case "click":
        return request.ref ? `Click on element ${request.ref}` : "Click";
      case "type":
        return `Type "${request.text ?? ""}"${request.ref ? ` into element ${request.ref}` : ""}`;
      case "press":
        return `Press ${request.key ?? "Enter"} key`;
      case "hover":
        return request.ref ? `Hover over element ${request.ref}` : "Hover";
      case "scroll":
        return `Scroll ${request.direction ?? "down"}`;
      case "navigate":
        return `Navigate to ${request.url ?? ""}`;
      case "wait":
        return `Wait for ${request.ms ?? 1000}ms`;
      case "close":
        return "Close the tab";
      case "back":
        return "Go back";
      case "forward":
        return "Go forward";
      case "refresh":
        return "Refresh the page";
      case "clear":
        return request.ref ? `Clear element ${request.ref}` : "Clear field";
      case "focus":
        return request.ref ? `Focus on element ${request.ref}` : "Focus";
      case "select":
        return `Select "${request.text ?? ""}" from dropdown`;
      case "drag":
        return request.ref ? `Drag element ${request.ref}` : "Drag";
      case "upload":
        return "Upload file";
    }
  }
}

// ==========================================================================
// Factory Functions
// ==========================================================================

/**
 * Create a new rtrvr.ai provider instance
 */
export function createRtrvrProvider(config: RtrvrProviderConfig): RtrvrProvider {
  return new RtrvrProvider(config);
}

/**
 * Check if a profile is configured to use rtrvr.ai
 */
export function isRtrvrProfile(profile: BrowserProfileConfig): boolean {
  return profile.driver === "rtrvr" || profile.driver === "rtrvr-cloud";
}
