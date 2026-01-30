/**
 * rtrvr Browser Provider
 *
 * Maps OpenClaw browser operations to rtrvr API calls.
 * Supports both extension-based (rtrvr) and cloud-only (rtrvr-cloud) modes.
 */

import type { BrowserProfileConfig } from "../config/config.js";
import type { BrowserStatus, BrowserTab, ProfileStatus, SnapshotResult } from "./client.js";
import {
  createRtrvrClient,
  type RtrvrClient,
  type RtrvrClientConfig,
  type RtrvrPageAction,
  type RtrvrPageTree,
  type RtrvrTab,
} from "./rtrvr-client.js";

export type RtrvrProviderConfig = {
  profileName: string;
  profile: BrowserProfileConfig;
};

type RtrvrActKind = "click" | "type" | "press" | "hover" | "scroll" | "navigate" | "wait" | "close";

/**
 * rtrvr Browser Provider
 *
 * Provides a bridge between OpenClaw's browser tool and the rtrvr API.
 */
export class RtrvrProvider {
  private client: RtrvrClient;
  private profileName: string;
  private profile: BrowserProfileConfig;
  private isCloudMode: boolean;
  private cachedTabs: Map<string, { tabId: number; url: string }> = new Map();

  constructor(config: RtrvrProviderConfig) {
    const { profileName, profile } = config;

    if (!profile.rtrvrApiKey) {
      throw new Error(`rtrvr API key is required for profile "${profileName}"`);
    }

    this.profileName = profileName;
    this.profile = profile;
    this.isCloudMode = profile.driver === "rtrvr-cloud";

    const clientConfig: RtrvrClientConfig = {
      apiKey: profile.rtrvrApiKey,
      apiUrl: profile.rtrvrApiUrl,
      deviceId: profile.rtrvrDeviceId,
    };

    this.client = createRtrvrClient(clientConfig);
  }

  /**
   * Get browser status
   */
  async getStatus(): Promise<BrowserStatus> {
    try {
      if (this.isCloudMode) {
        // Cloud mode is always "running" (serverless)
        const credits = await this.client.getCredits();
        return {
          enabled: true,
          profile: this.profileName,
          running: true,
          cdpReady: false,
          pid: null,
          cdpPort: 0,
          chosenBrowser: "rtrvr-cloud",
          userDataDir: null,
          color: this.profile.color,
          headless: true,
          attachOnly: true,
          detectedBrowser: `rtrvr-cloud (credits: ${credits.creditsRemaining ?? "unknown"})`,
        };
      }

      // Extension mode - check if device is online
      const { online, devices } = await this.client.listDevices();
      const deviceId = this.profile.rtrvrDeviceId;
      const targetDevice = deviceId
        ? devices.find((d) => d.deviceId === deviceId)
        : devices.find((d) => d.hasFcmToken);

      return {
        enabled: true,
        profile: this.profileName,
        running: online && Boolean(targetDevice?.hasFcmToken),
        cdpReady: online && Boolean(targetDevice?.hasFcmToken),
        pid: null,
        cdpPort: 0,
        chosenBrowser: "rtrvr-extension",
        userDataDir: null,
        color: this.profile.color,
        headless: false,
        attachOnly: true,
        detectedBrowser: targetDevice
          ? `rtrvr (${targetDevice.deviceName})`
          : online
            ? "rtrvr (no device selected)"
            : "rtrvr (offline)",
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
    }

    return {
      name: this.profileName,
      cdpPort: 0,
      cdpUrl: this.profile.rtrvrApiUrl ?? "https://us-central1-rtrvraibot.cloudfunctions.net",
      color: this.profile.color,
      running: status.running,
      tabCount,
      isDefault: false,
      isRemote: true,
    };
  }

  /**
   * Start browser (no-op for rtrvr, always running)
   */
  async start(): Promise<void> {
    // rtrvr is always running (cloud or extension-based)
    // Just verify connectivity
    if (this.isCloudMode) {
      await this.client.getCredits();
    } else {
      const { online } = await this.client.listDevices();
      if (!online) {
        throw new Error(
          "No rtrvr extension device is online. Open Chrome with the rtrvr extension installed.",
        );
      }
    }
  }

  /**
   * Stop browser (no-op for rtrvr)
   */
  async stop(): Promise<void> {
    // No-op for rtrvr - cloud browsers are ephemeral, extension is user-controlled
  }

  /**
   * Get browser tabs
   */
  async getTabs(): Promise<BrowserTab[]> {
    if (this.isCloudMode) {
      // Cloud mode doesn't have persistent tabs
      return [];
    }

    const { tabs } = await this.client.getBrowserTabs();
    return tabs.map((tab) => this.convertTab(tab));
  }

  /**
   * Open a new tab with URL
   */
  async openTab(url: string): Promise<BrowserTab> {
    if (this.isCloudMode) {
      // For cloud mode, we'll use cloudScrape to fetch the page
      // and return a synthetic tab
      const result = await this.client.cloudScrape({ urls: [url] });
      const tab = result.tabs?.[0];
      const syntheticTab: BrowserTab = {
        targetId: `cloud-${Date.now()}`,
        title: tab?.title ?? url,
        url: tab?.url ?? url,
        type: "page",
      };
      this.cachedTabs.set(syntheticTab.targetId, { tabId: 0, url });
      return syntheticTab;
    }

    // Extension mode: use navigate action to open tab
    await this.client.takePageAction({
      actions: [{ tool_name: "navigate", args: { url } }],
    });

    // Get updated tabs to find the new one
    const { tabs } = await this.client.getBrowserTabs();
    const newTab = tabs.find((t) => t.url === url) ?? tabs[tabs.length - 1];

    if (newTab) {
      const targetId = `rtrvr-${newTab.tabId}`;
      this.cachedTabs.set(targetId, { tabId: newTab.tabId, url: newTab.url });
      return this.convertTab(newTab);
    }

    return {
      targetId: `rtrvr-${Date.now()}`,
      title: url,
      url,
      type: "page",
    };
  }

  /**
   * Close a tab
   */
  async closeTab(targetId: string): Promise<void> {
    if (this.isCloudMode) {
      this.cachedTabs.delete(targetId);
      return;
    }

    const tabId = this.resolveTabId(targetId);
    if (tabId !== undefined) {
      await this.client.takePageAction({
        actions: [{ tab_id: tabId, tool_name: "close_tab", args: {} }],
      });
      this.cachedTabs.delete(targetId);
    }
  }

  /**
   * Focus a tab
   */
  async focusTab(targetId: string): Promise<void> {
    if (this.isCloudMode) {
      // No-op for cloud mode
      return;
    }

    const tabId = this.resolveTabId(targetId);
    if (tabId !== undefined) {
      // rtrvr doesn't have a direct focus action, but click on tab will focus it
      await this.client.takePageAction({
        actions: [{ tab_id: tabId, tool_name: "click", args: { element_id: 0 } }],
      });
    }
  }

  /**
   * Navigate current tab to URL
   */
  async navigate(url: string, targetId?: string): Promise<{ ok: true; url: string }> {
    if (this.isCloudMode) {
      // For cloud, just update the cached URL
      if (targetId) {
        this.cachedTabs.set(targetId, { tabId: 0, url });
      }
      return { ok: true, url };
    }

    const tabId = targetId ? this.resolveTabId(targetId) : undefined;
    await this.client.takePageAction({
      actions: [{ tab_id: tabId, tool_name: "navigate", args: { url } }],
    });

    return { ok: true, url };
  }

  /**
   * Take a snapshot of the page
   */
  async snapshot(opts: { format: "aria" | "ai"; targetId?: string }): Promise<SnapshotResult> {
    if (this.isCloudMode) {
      // Use cloud scrape for cloud mode
      const cached = opts.targetId ? this.cachedTabs.get(opts.targetId) : undefined;
      const url = cached?.url;

      if (!url) {
        throw new Error("No URL available for cloud snapshot. Open a tab first.");
      }

      const result = await this.client.cloudScrape({ urls: [url] });
      const tab = result.tabs?.[0];

      if (opts.format === "aria") {
        return {
          ok: true,
          format: "aria",
          targetId: opts.targetId ?? `cloud-${Date.now()}`,
          url: tab?.url ?? url,
          nodes: this.parseAriaNodes(tab?.tree ?? ""),
        };
      }

      return {
        ok: true,
        format: "ai",
        targetId: opts.targetId ?? `cloud-${Date.now()}`,
        url: tab?.url ?? url,
        snapshot: tab?.tree ?? tab?.content ?? "",
        stats: {
          lines: (tab?.tree ?? "").split("\n").length,
          chars: (tab?.tree ?? "").length,
          refs: 0,
          interactive: 0,
        },
      };
    }

    // Extension mode: get page data
    const tabId = opts.targetId ? this.resolveTabId(opts.targetId) : undefined;

    if (tabId === undefined) {
      // Get active tab
      const { tabs, activeTab } = await this.client.getBrowserTabs({ filter: "active" });
      const tab = activeTab ?? tabs[0];
      if (!tab) {
        throw new Error("No active tab found");
      }
      return this.snapshotTab(tab, opts.format);
    }

    const { trees } = await this.client.getPageData({ tabIds: [tabId] });
    const tree = trees[0];

    if (!tree) {
      throw new Error("Failed to get page data");
    }

    return this.convertTreeToSnapshot(tree, opts.format, opts.targetId ?? `rtrvr-${tabId}`);
  }

  /**
   * Take a screenshot (not directly supported, returns error)
   */
  async screenshot(_opts: {
    targetId?: string;
    fullPage?: boolean;
    type?: "png" | "jpeg";
  }): Promise<{ ok: false; error: string }> {
    // rtrvr API doesn't support direct screenshots
    // Users should use the cloud_agent or act_on_tab for visual tasks
    return {
      ok: false,
      error:
        "Direct screenshots are not supported with rtrvr. Use the snapshot action for accessibility tree, or cloud_agent for visual AI tasks.",
    };
  }

  /**
   * Execute a browser action
   */
  async act(request: {
    kind: RtrvrActKind;
    ref?: string;
    text?: string;
    key?: string;
    direction?: string;
    x?: number;
    y?: number;
    url?: string;
    ms?: number;
    targetId?: string;
  }): Promise<{ ok: true; download?: { path: string } }> {
    const tabId = request.targetId ? this.resolveTabId(request.targetId) : undefined;

    if (this.isCloudMode) {
      // For cloud mode, use cloud_agent for complex actions
      const userInput = this.buildActionDescription(request);
      const cached = request.targetId ? this.cachedTabs.get(request.targetId) : undefined;

      await this.client.cloudAgent({
        userInput,
        urls: cached?.url ? [cached.url] : undefined,
      });

      return { ok: true };
    }

    // Map OpenClaw action to rtrvr action
    const action = this.mapToRtrvrAction(request, tabId);

    await this.client.takePageAction({ actions: [action] });

    return { ok: true };
  }

  /**
   * Get console messages (not supported)
   */
  async getConsoleMessages(): Promise<{ messages: unknown[] }> {
    // rtrvr doesn't expose console messages directly
    return { messages: [] };
  }

  /**
   * AI-powered action using act_on_tab
   */
  async aiAct(opts: {
    userInput: string;
    tabUrls?: string[];
    tabId?: number;
    schema?: {
      fields: Array<{ name: string; description?: string; type?: string; required?: boolean }>;
    };
  }): Promise<unknown> {
    if (this.isCloudMode) {
      return await this.client.cloudAgent({
        userInput: opts.userInput,
        urls: opts.tabUrls,
        schema: opts.schema,
      });
    }

    return await this.client.actOnTab(opts);
  }

  /**
   * Extract data from pages
   */
  async extract(opts: {
    userInput: string;
    tabUrls?: string[];
    schema?: {
      fields: Array<{ name: string; description?: string; type?: string; required?: boolean }>;
    };
  }): Promise<unknown> {
    if (this.isCloudMode) {
      return await this.client.cloudAgent({
        userInput: `Extract the following data: ${opts.userInput}`,
        urls: opts.tabUrls,
        schema: opts.schema,
      });
    }

    return await this.client.extractFromTab(opts);
  }

  // ============ Private helpers ============

  private convertTab(tab: RtrvrTab): BrowserTab {
    const targetId = `rtrvr-${tab.tabId}`;
    this.cachedTabs.set(targetId, { tabId: tab.tabId, url: tab.url });
    return {
      targetId,
      title: tab.title,
      url: tab.url,
      type: "page",
    };
  }

  private resolveTabId(targetId: string): number | undefined {
    if (targetId.startsWith("rtrvr-")) {
      const id = parseInt(targetId.slice(6), 10);
      if (!isNaN(id)) return id;
    }

    const cached = this.cachedTabs.get(targetId);
    return cached?.tabId;
  }

  private async snapshotTab(tab: RtrvrTab, format: "aria" | "ai"): Promise<SnapshotResult> {
    const { trees } = await this.client.getPageData({ tabIds: [tab.tabId] });
    const tree = trees[0];

    if (!tree) {
      throw new Error("Failed to get page data");
    }

    return this.convertTreeToSnapshot(tree, format, `rtrvr-${tab.tabId}`);
  }

  private convertTreeToSnapshot(
    tree: RtrvrPageTree,
    format: "aria" | "ai",
    targetId: string,
  ): SnapshotResult {
    if (format === "aria") {
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
        refs: 0,
        interactive: 0,
      },
    };
  }

  private parseAriaNodes(treeString: string): Array<{
    ref: string;
    role: string;
    name: string;
    depth: number;
  }> {
    // Parse the accessibility tree string into nodes
    // Format is typically: "role name [id=N]" with indentation for depth
    const lines = treeString.split("\n").filter((l) => l.trim());
    const nodes: Array<{ ref: string; role: string; name: string; depth: number }> = [];

    for (const line of lines) {
      const indentMatch = line.match(/^(\s*)/);
      const depth = indentMatch ? Math.floor(indentMatch[1].length / 2) : 0;

      const idMatch = line.match(/\[id=(\d+)\]/);
      const ref = idMatch ? `e${idMatch[1]}` : `e${nodes.length}`;

      // Extract role and name
      const content = line
        .trim()
        .replace(/\[id=\d+\]/, "")
        .trim();
      const parts = content.split(" ");
      const role = parts[0] ?? "generic";
      const name = parts.slice(1).join(" ");

      nodes.push({ ref, role, name, depth });
    }

    return nodes;
  }

  private mapToRtrvrAction(
    request: {
      kind: RtrvrActKind;
      ref?: string;
      text?: string;
      key?: string;
      direction?: string;
      x?: number;
      y?: number;
      url?: string;
      ms?: number;
    },
    tabId?: number,
  ): RtrvrPageAction {
    const elementId = request.ref ? this.parseRefToElementId(request.ref) : undefined;

    switch (request.kind) {
      case "click":
        return {
          tab_id: tabId,
          tool_name: "click",
          args: { element_id: elementId },
        };

      case "type":
        return {
          tab_id: tabId,
          tool_name: "type",
          args: { element_id: elementId, text: request.text ?? "" },
        };

      case "press":
        return {
          tab_id: tabId,
          tool_name: "press",
          args: { key: request.key ?? "Enter" },
        };

      case "hover":
        return {
          tab_id: tabId,
          tool_name: "hover",
          args: { element_id: elementId, duration: request.ms },
        };

      case "scroll":
        return {
          tab_id: tabId,
          tool_name: "scroll",
          args: {
            direction: (request.direction?.toUpperCase() ?? "DOWN") as
              | "UP"
              | "DOWN"
              | "LEFT"
              | "RIGHT",
          },
        };

      case "navigate":
        return {
          tab_id: tabId,
          tool_name: "navigate",
          args: { url: request.url ?? "" },
        };

      case "wait":
        return {
          tab_id: tabId,
          tool_name: "wait",
          args: { duration: request.ms ?? 1000 },
        };

      case "close":
        return {
          tab_id: tabId,
          tool_name: "close_tab",
          args: {},
        };
    }
  }

  private parseRefToElementId(ref: string): number | undefined {
    // Parse refs like "e12" or "12" to element IDs
    const match = ref.match(/^e?(\d+)$/);
    return match ? parseInt(match[1], 10) : undefined;
  }

  private buildActionDescription(request: {
    kind: RtrvrActKind;
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
    }
  }
}

/**
 * Create a new rtrvr provider instance
 */
export function createRtrvrProvider(config: RtrvrProviderConfig): RtrvrProvider {
  return new RtrvrProvider(config);
}

/**
 * Check if a profile is configured to use rtrvr
 */
export function isRtrvrProfile(profile: BrowserProfileConfig): boolean {
  return profile.driver === "rtrvr" || profile.driver === "rtrvr-cloud";
}
