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
  type RtrvrOutputDestination,
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
  | "scrollIntoView"
  | "wait"
  | "select"
  | "fill"
  | "drag"
  | "resize"
  | "evaluate"
  | "close";

type RtrvrAiTool = "planner" | "act" | "extract" | "crawl";

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
      ...(this.isCloudMode
        ? { cloudApiUrl: profile.rtrvrApiUrl }
        : { mcpApiUrl: profile.rtrvrApiUrl }),
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
        // Cloud mode: API is remote; avoid spending credits during status checks
        return {
          enabled: true,
          profile: this.profileName,
          running: true, // Cloud is always "running"
          cdpReady: false, // No CDP in cloud mode
          pid: null,
          cdpPort: 0,
          cdpUrl: this.profile.rtrvrApiUrl ?? "https://api.rtrvr.ai",
          chosenBrowser: "rtrvr-cloud",
          userDataDir: null,
          color: this.profile.color,
          headless: true,
          attachOnly: true,
          detectedBrowser: "rtrvr.ai Cloud",
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
        cdpUrl: this.profile.rtrvrApiUrl ?? "https://mcp.rtrvr.ai",
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
        cdpUrl:
          this.profile.rtrvrApiUrl ??
          (this.isCloudMode ? "https://api.rtrvr.ai" : "https://mcp.rtrvr.ai"),
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
      cdpUrl:
        this.profile.rtrvrApiUrl ??
        (this.isCloudMode ? "https://api.rtrvr.ai" : "https://mcp.rtrvr.ai"),
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
      // Cloud mode: avoid credit usage; /agent or /scrape will validate on demand
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
      // Cloud mode: use /scrape for HTTP(S); otherwise create a placeholder tab
      const targetId = `rtrvr-cloud-${Date.now()}`;
      if (!this.isHttpUrl(url)) {
        this.cloudTabCache.set(targetId, { url });
        return { targetId, title: url, url, type: "page" };
      }

      const result = await this.client.cloudScrape({ url });
      const normalized = this.normalizeScrapeResult(result, url);
      this.cloudTabCache.set(targetId, {
        url: normalized.url,
        title: normalized.title,
        tree: normalized.tree,
      });

      return {
        targetId,
        title: normalized.title ?? normalized.url,
        url: normalized.url,
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

    const tabId = this.resolveExtensionTabId(targetId);
    if (tabId !== undefined) {
      await this.client.takePageAction({
        actions: [{ tab_id: tabId, tool_name: "close_tab", args: {} }],
      });
      for (const [key, value] of this.extensionTabCache.entries()) {
        if (value === tabId || key === targetId) {
          this.extensionTabCache.delete(key);
        }
      }
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

    const tabId = this.resolveExtensionTabId(targetId);
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
      if (!this.isHttpUrl(url)) {
        if (targetId && this.cloudTabCache.has(targetId)) {
          this.cloudTabCache.set(targetId, { url });
        }
        return { ok: true, url };
      }

      const result = await this.client.cloudScrape({ url });
      const normalized = this.normalizeScrapeResult(result, url);

      if (targetId && this.cloudTabCache.has(targetId)) {
        this.cloudTabCache.set(targetId, {
          url: normalized.url,
          title: normalized.title,
          tree: normalized.tree,
        });
      }

      return { ok: true, url: normalized.url };
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
  async snapshot(opts: {
    format: "aria" | "ai";
    targetId?: string;
    maxChars?: number;
    limit?: number;
  }): Promise<SnapshotResult> {
    if (this.isCloudMode) {
      return this.cloudSnapshot(opts);
    }
    return this.extensionSnapshot(opts);
  }

  private async cloudSnapshot(opts: {
    format: "aria" | "ai";
    targetId?: string;
    maxChars?: number;
    limit?: number;
  }): Promise<SnapshotResult> {
    // Get cached data or throw
    const resolved = this.resolveCloudTarget(opts.targetId);
    const cached = resolved?.data;

    if (!cached?.url) {
      throw new Error(
        `No URL available for cloud snapshot. Use action=open with a URL first (profile "${this.profileName}").`,
      );
    }

    // If we don't have tree data, fetch it via /scrape
    let tree = cached.tree;
    if (!tree && this.isHttpUrl(cached.url)) {
      const result = await this.client.cloudScrape({ url: cached.url });
      const normalized = this.normalizeScrapeResult(result, cached.url);
      tree = normalized.tree ?? "";
      cached.tree = tree;
    }

    const targetId = resolved?.targetId ?? opts.targetId ?? `rtrvr-cloud-${Date.now()}`;
    const rawTree = tree ?? "";

    if (opts.format === "aria") {
      const nodes = this.parseAriaNodes(rawTree);
      const limit = opts.limit;
      return {
        ok: true,
        format: "aria",
        targetId,
        url: cached.url,
        nodes:
          typeof limit === "number" && Number.isFinite(limit) && limit > 0
            ? nodes.slice(0, Math.floor(limit))
            : nodes,
      };
    }

    const normalizedTree = this.normalizeSnapshotTree(rawTree);
    const truncated = this.truncateSnapshot(normalizedTree, opts.maxChars);

    return {
      ok: true,
      format: "ai",
      targetId,
      url: cached.url,
      snapshot: truncated.snapshot,
      ...(truncated.truncated ? { truncated: true } : {}),
      stats: this.buildSnapshotStats(truncated.snapshot),
    };
  }

  private async extensionSnapshot(opts: {
    format: "aria" | "ai";
    targetId?: string;
    maxChars?: number;
    limit?: number;
  }): Promise<SnapshotResult> {
    const resolved = await this.resolveExtensionTab(opts.targetId);

    if (!resolved) {
      throw new Error(`No active tab found for profile "${this.profileName}"`);
    }

    const { tabId, targetId } = resolved;

    // Get page data (enriched accessibility tree)
    const { trees } = await this.client.getPageData({ tabIds: [tabId] });
    const tree = trees[0];

    if (!tree) {
      throw new Error("Failed to get page data from rtrvr.ai extension");
    }

    if (opts.format === "aria") {
      const nodes = this.parseAriaNodes(tree.tree);
      const limit = opts.limit;
      return {
        ok: true,
        format: "aria",
        targetId,
        url: tree.url,
        nodes:
          typeof limit === "number" && Number.isFinite(limit) && limit > 0
            ? nodes.slice(0, Math.floor(limit))
            : nodes,
      };
    }

    const normalizedTree = this.normalizeSnapshotTree(tree.tree);
    const truncated = this.truncateSnapshot(normalizedTree, opts.maxChars);

    return {
      ok: true,
      format: "ai",
      targetId,
      url: tree.url,
      snapshot: truncated.snapshot,
      ...(truncated.truncated ? { truncated: true } : {}),
      stats: this.buildSnapshotStats(truncated.snapshot),
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
    url?: string;
    targetId?: string;
    submit?: boolean;
    doubleClick?: boolean;
    button?: string;
    modifiers?: string[];
    startRef?: string;
    endRef?: string;
    values?: string[];
    fields?: Array<{ ref: string; type: string; value?: string | number | boolean }>;
    width?: number;
    height?: number;
    timeMs?: number;
    fn?: string;
  }): Promise<{ ok: true; result?: unknown }> {
    if (this.isCloudMode) {
      throw new Error("rtrvr.ai cloud only supports AI actions. Use kind=ai.");
    }
    return this.extensionAct(request);
  }

  private async extensionAct(request: {
    kind: OpenClawActKind;
    ref?: string;
    text?: string;
    key?: string;
    url?: string;
    targetId?: string;
    submit?: boolean;
    doubleClick?: boolean;
    button?: string;
    modifiers?: string[];
    startRef?: string;
    endRef?: string;
    values?: string[];
    fields?: Array<{ ref: string; type: string; value?: string | number | boolean }>;
    width?: number;
    height?: number;
    timeMs?: number;
    fn?: string;
  }): Promise<{ ok: true; result?: unknown }> {
    const tabId = this.resolveExtensionTabId(request.targetId);

    if (request.kind === "evaluate") {
      if (!request.fn) {
        throw new Error("fn is required for evaluate");
      }
      if (request.ref) {
        throw new Error("evaluate with ref is not supported for rtrvr.ai");
      }
      const raw = request.fn.trim();
      const code = raw.includes("=>") || raw.includes("function") ? `(${raw})()` : raw;
      const result = await this.client.executeJavaScript({
        code,
      });
      return { ok: true, result: result.result ?? result };
    }

    if (request.kind === "resize") {
      throw new Error("resize is not supported for rtrvr.ai profiles");
    }

    if (request.kind === "fill") {
      const fields = Array.isArray(request.fields) ? request.fields : [];
      if (!fields.length) throw new Error("fields are required for fill");
      await this.runFillActions(fields, tabId);
      return { ok: true };
    }

    const action = this.mapToRtrvrAction(request, tabId);
    await this.client.takePageAction({ actions: [action] });
    return { ok: true };
  }

  // ==========================================================================
  // AI-Powered Actions
  // ==========================================================================

  /**
   * AI-powered task (planner/act/extract/crawl)
   */
  async aiTask(opts: {
    userInput: string;
    urls?: string[];
    schema?: RtrvrSchema;
    targetId?: string;
    tool?: RtrvrAiTool | string;
    maxSteps?: number;
    context?: string;
    maxPages?: number;
    followLinks?: boolean;
    linkPattern?: string;
    outputDestination?: RtrvrOutputDestination;
  }): Promise<unknown> {
    const userInput = opts.userInput.trim();
    if (!userInput) throw new Error("userInput is required for ai");

    const { tabId, url: tabUrl } = await this.resolveTabContext(opts.targetId);
    const urls = (opts.urls ?? []).filter(Boolean);
    const tabUrls = urls.length > 0 ? urls : tabUrl ? [tabUrl] : undefined;

    if (this.isCloudMode) {
      return this.client.cloudAgent({
        userInput,
        urls: tabUrls,
        schema: opts.schema,
      });
    }

    if (!tabUrls && tabId === undefined) {
      throw new Error(
        `No rtrvr.ai tabs available for profile "${this.profileName}". Open a tab or pass urls.`,
      );
    }

    const tool = this.resolveAiTool(opts.tool, userInput, tabUrls);

    switch (tool) {
      case "planner":
        return this.client.planner({
          userInput,
          tabUrls,
          context: opts.context,
          maxSteps: opts.maxSteps,
        });
      case "extract":
        return this.client.extract({
          userInput,
          tabUrls,
          tabId,
          schema: opts.schema,
          outputDestination: opts.outputDestination,
        });
      case "crawl":
        return this.client.crawl({
          userInput,
          tabUrls,
          tabId,
          schema: opts.schema,
          maxPages: opts.maxPages,
          followLinks: opts.followLinks,
          linkPattern: opts.linkPattern,
          outputDestination: opts.outputDestination,
        });
      case "act":
      default:
        return this.client.act({
          userInput,
          tabUrls,
          tabId,
          schema: opts.schema,
        });
    }
  }

  /**
   * Extract data from pages (legacy helper)
   */
  async extract(opts: {
    userInput: string;
    urls?: string[];
    schema?: RtrvrSchema;
  }): Promise<unknown> {
    if (this.isCloudMode) {
      return this.client.cloudAgent({
        userInput: `Extract the following data: ${opts.userInput}`,
        urls: opts.urls,
        schema: opts.schema,
      });
    }

    return this.client.extract({
      userInput: opts.userInput,
      tabUrls: opts.urls,
      schema: opts.schema,
    });
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

  private resolveExtensionTabId(targetId?: string): number | undefined {
    if (!targetId) return undefined;
    const direct = this.extensionTabCache.get(targetId);
    if (direct !== undefined) return direct;
    for (const [key, value] of this.extensionTabCache.entries()) {
      if (key.startsWith(targetId)) return value;
    }
    const match = targetId.match(/rtrvr-ext-(\d+)/);
    return match ? Number.parseInt(match[1], 10) : undefined;
  }

  private async resolveExtensionTab(
    targetId?: string,
  ): Promise<{ tabId: number; targetId: string } | null> {
    const resolvedId = this.resolveExtensionTabId(targetId);
    if (resolvedId !== undefined) {
      return { tabId: resolvedId, targetId: `rtrvr-ext-${resolvedId}` };
    }

    const { activeTab, tabs } = await this.client.getBrowserTabs({ filter: "active" });
    const tab = activeTab ?? tabs[0];
    if (!tab) return null;
    const resolvedTargetId = `rtrvr-ext-${tab.id}`;
    this.extensionTabCache.set(resolvedTargetId, tab.id);
    return { tabId: tab.id, targetId: resolvedTargetId };
  }

  private resolveCloudTarget(targetId?: string): {
    targetId: string;
    data: { url: string; title?: string; tree?: string };
  } | null {
    if (!targetId) return null;
    const cached = this.cloudTabCache.get(targetId);
    if (cached) return { targetId, data: cached };
    for (const [key, value] of this.cloudTabCache.entries()) {
      if (key.startsWith(targetId)) return { targetId: key, data: value };
    }
    return null;
  }

  private async resolveTabContext(targetId?: string): Promise<{ tabId?: number; url?: string }> {
    if (this.isCloudMode) {
      const resolved = this.resolveCloudTarget(targetId);
      return { url: resolved?.data.url };
    }

    const resolvedId = this.resolveExtensionTabId(targetId);
    if (resolvedId !== undefined) {
      const { tabs } = await this.client.getBrowserTabs();
      const match = tabs.find((tab) => tab.id === resolvedId);
      return { tabId: resolvedId, url: match?.url };
    }

    if (targetId) {
      const { tabs } = await this.client.getBrowserTabs();
      const match = tabs.find((tab) => `rtrvr-ext-${tab.id}`.startsWith(targetId));
      if (match) {
        const resolvedTargetId = `rtrvr-ext-${match.id}`;
        this.extensionTabCache.set(resolvedTargetId, match.id);
        return { tabId: match.id, url: match.url };
      }
    }

    const { activeTab, tabs } = await this.client.getBrowserTabs({ filter: "active" });
    const tab = activeTab ?? tabs[0];
    if (!tab) return {};
    const resolvedTargetId = `rtrvr-ext-${tab.id}`;
    this.extensionTabCache.set(resolvedTargetId, tab.id);
    return { tabId: tab.id, url: tab.url };
  }

  private resolveAiTool(
    rawTool: RtrvrAiTool | string | undefined,
    _userInput: string,
    urls?: string[],
  ): RtrvrAiTool {
    const tool = (rawTool ?? "").toString().trim().toLowerCase();
    if (tool === "planner" || tool === "act" || tool === "extract" || tool === "crawl") {
      return tool as RtrvrAiTool;
    }
    if (urls && urls.length > 0) return "planner";
    return "act";
  }

  private async runFillActions(
    fields: Array<{ ref: string; type: string; value?: string | number | boolean }>,
    tabId?: number,
  ): Promise<void> {
    let didRun = false;
    for (const field of fields) {
      const elementId = this.parseRefToElementId(field.ref);
      if (!elementId) continue;
      const type = field.type.toLowerCase();
      if (type === "checkbox" || type === "radio") {
        if (field.value === true) {
          await this.client.takePageAction({
            actions: [
              { tab_id: tabId, tool_name: "click_element", args: { element_id: elementId } },
            ],
          });
          didRun = true;
        }
        continue;
      }
      if (field.value === undefined || field.value === null) continue;
      await this.client.takePageAction({
        actions: [
          {
            tab_id: tabId,
            tool_name: "type_into_element",
            args: { element_id: elementId, text: String(field.value) },
          },
        ],
      });
      didRun = true;
    }
    if (!didRun) {
      throw new Error("No fillable fields found for rtrvr.ai action");
    }
  }

  private normalizeSnapshotTree(tree: string): string {
    return tree.replace(/\[id=(\d+)\]/g, "[ref=e$1]");
  }

  private truncateSnapshot(
    snapshot: string,
    maxChars?: number,
  ): { snapshot: string; truncated?: boolean } {
    const limit =
      typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0
        ? Math.floor(maxChars)
        : undefined;
    if (limit && snapshot.length > limit) {
      return {
        snapshot: `${snapshot.slice(0, limit)}\n\n[...TRUNCATED - page too large]`,
        truncated: true,
      };
    }
    return { snapshot };
  }

  private buildSnapshotStats(snapshot: string): {
    lines: number;
    chars: number;
    refs: number;
    interactive: number;
  } {
    return {
      lines: snapshot.split("\n").length,
      chars: snapshot.length,
      refs: this.countRefs(snapshot),
      interactive: this.countInteractive(snapshot),
    };
  }

  private isHttpUrl(url: string): boolean {
    return /^https?:\/\//i.test(url.trim());
  }

  private normalizeScrapeResult(
    result: {
      success?: boolean;
      status?: string;
      error?: string;
      tabs?: Array<{
        url: string;
        title: string;
        status?: "success" | "error";
        error?: string;
        tree?: string;
        content?: string;
        text?: string;
      }>;
      url?: string;
      title?: string;
      tree?: string;
      text?: string;
      content?: string;
    },
    fallbackUrl: string,
  ): { url: string; title?: string; tree?: string; content?: string } {
    if (result.success === false) {
      throw new Error(result.error || "rtrvr.ai scrape failed");
    }
    if (result.status && result.status !== "success") {
      throw new Error(result.error || `rtrvr.ai scrape ${result.status}`);
    }
    const tab = Array.isArray(result.tabs) ? result.tabs[0] : undefined;
    if (tab?.status === "error") {
      throw new Error(tab.error || "rtrvr.ai scrape tab failed");
    }
    const url = tab?.url ?? result.url ?? fallbackUrl;
    const title = tab?.title ?? result.title;
    const tree = tab?.tree ?? result.tree ?? result.text;
    const content = tab?.content ?? result.content ?? result.text;
    if (!tree) {
      throw new Error("rtrvr.ai scrape did not return an accessibility tree");
    }
    return { url, title, tree, content };
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

      // Extract ID from [id=N] or [ref=eN] pattern
      const idMatch = line.match(/\[id=(\d+)\]/) ?? line.match(/\[ref=e(\d+)\]/);
      const ref = idMatch ? `e${idMatch[1]}` : `e${nodes.length}`;

      // Extract role and name
      const content = line
        .trim()
        .replace(/\[id=\d+\]/, "")
        .replace(/\[ref=e\d+\]/, "")
        .trim();
      const parts = content.split(/\s+/);
      const role = parts[0] ?? "generic";
      const name = parts.slice(1).join(" ");

      nodes.push({ ref, role, name, depth });
    }

    return nodes;
  }

  private countRefs(tree: string): number {
    const refMatches = tree.match(/\[ref=e\d+\]/g);
    if (refMatches?.length) return refMatches.length;
    const idMatches = tree.match(/\[id=\d+\]/g);
    return idMatches?.length ?? 0;
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
      url?: string;
      submit?: boolean;
      doubleClick?: boolean;
      button?: string;
      startRef?: string;
      endRef?: string;
      values?: string[];
      timeMs?: number;
    },
    tabId?: number,
  ): RtrvrPageAction {
    const elementId = request.ref ? this.parseRefToElementId(request.ref) : undefined;

    switch (request.kind) {
      case "click":
        if (!elementId) throw new Error("ref is required for click");
        return {
          tab_id: tabId,
          tool_name: request.doubleClick
            ? "double_click_element"
            : request.button?.toLowerCase() === "right"
              ? "right_click_element"
              : "click_element",
          args: { element_id: elementId },
        };

      case "type":
        if (!elementId) throw new Error("ref is required for type");
        return {
          tab_id: tabId,
          tool_name: request.submit ? "type_and_enter" : "type_into_element",
          args: { element_id: elementId, text: request.text ?? "" },
        };

      case "press":
        return {
          tab_id: tabId,
          tool_name: "press_key",
          args: { key: request.key ?? "Enter" },
        };

      case "hover":
        if (!elementId) throw new Error("ref is required for hover");
        return {
          tab_id: tabId,
          tool_name: "hover_element",
          args: { element_id: elementId },
        };

      case "scrollIntoView":
        if (!elementId) throw new Error("ref is required for scrollIntoView");
        return {
          tab_id: tabId,
          tool_name: "scroll_to_element",
          args: { element_id: elementId, position: "center" },
        };

      case "wait":
        if (!request.timeMs) {
          throw new Error("timeMs is required for wait in rtrvr.ai");
        }
        return {
          tab_id: tabId,
          tool_name: "wait_action",
          args: { duration: request.timeMs },
        };

      case "close":
        return {
          tab_id: tabId,
          tool_name: "close_tab",
          args: {},
        };

      case "select":
        if (!elementId) throw new Error("ref is required for select");
        if (!request.values?.length) throw new Error("values are required for select");
        return {
          tab_id: tabId,
          tool_name: "select_dropdown_value",
          args: { element_id: elementId, value: request.values[0] ?? "" },
        };

      case "drag":
        if (!request.startRef || !request.endRef) {
          throw new Error("startRef and endRef are required for drag");
        }
        {
          const sourceId = this.parseRefToElementId(request.startRef);
          const targetId = this.parseRefToElementId(request.endRef);
          if (!sourceId || !targetId) {
            throw new Error("Invalid drag refs for rtrvr.ai");
          }
          return {
            tab_id: tabId,
            tool_name: "drag_and_drop",
            args: { source_element_id: sourceId, target_element_id: targetId },
          };
        }

      case "fill":
        throw new Error("fill should be handled separately");

      case "resize":
        throw new Error("resize is not supported for rtrvr.ai");

      case "evaluate":
        throw new Error("evaluate should be handled separately");
    }

    throw new Error("Unsupported action kind for rtrvr.ai");
  }

  private parseRefToElementId(ref: string): number | undefined {
    const match = ref.match(/(?:\[?(?:ref|id)=)?e?(\d+)\]?/);
    return match ? parseInt(match[1], 10) : undefined;
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
