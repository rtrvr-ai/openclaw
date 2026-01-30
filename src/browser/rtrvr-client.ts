/**
 * rtrvr API Client
 *
 * Client for communicating with the rtrvr cloud API for browser automation.
 * Supports both extension-based (rtrvr) and cloud-only (rtrvr-cloud) modes.
 *
 * API Documentation: https://www.rtrvr.ai/docs/mcp
 */

const DEFAULT_RTRVR_API_URL = "https://us-central1-rtrvraibot.cloudfunctions.net";
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

export type RtrvrClientConfig = {
  apiKey: string;
  apiUrl?: string;
  deviceId?: string;
  timeoutMs?: number;
};

export type RtrvrTab = {
  tabId: number;
  url: string;
  title: string;
  active?: boolean;
  windowId?: number;
};

export type RtrvrPageTree = {
  tabId: number;
  url: string;
  title?: string;
  tree: string;
  content?: string;
};

export type RtrvrDevice = {
  deviceId: string;
  deviceName: string;
  lastSeen: string;
  hasFcmToken: boolean;
};

export type RtrvrCredits = {
  plan?: string;
  creditsRemaining?: number;
  creditsUsed?: number;
  renewalDate?: string;
};

export type RtrvrActionResult = {
  success: boolean;
  trees?: RtrvrPageTree[];
  actionResults?: unknown[];
  message?: string;
  creditsUsed?: number;
};

export type RtrvrActResult = {
  success: boolean;
  actions?: unknown[];
  extractedData?: unknown;
  creditsUsed?: number;
};

export type RtrvrExtractResult = {
  success: boolean;
  extractedData?: unknown[];
  recordCount?: number;
  sheetUrl?: string;
  creditsUsed?: number;
};

export type RtrvrCloudScrapeResult = {
  success: boolean;
  status?: string;
  trajectoryId?: string;
  tabCount?: number;
  tabs?: Array<{
    tabId?: number;
    url?: string;
    title?: string;
    status?: string;
    content?: string;
    tree?: string;
    error?: string;
  }>;
  usageData?: unknown;
  error?: string;
};

export type RtrvrCloudAgentResult = {
  success: boolean;
  status?: string;
  trajectoryId?: string;
  result?: { text?: string; json?: unknown };
  usage?: { creditsUsed?: number; creditsLeft?: number };
  metadata?: {
    phase?: string;
    taskRef?: string;
    stepsExecuted?: number;
  };
  steps?: Array<{
    stepNumber: number;
    toolName?: string;
    status?: string;
    hasOutput?: boolean;
    executionTime?: number;
  }>;
  warnings?: string[];
  error?: string;
};

export type SystemToolName =
  | "click"
  | "type"
  | "press"
  | "scroll"
  | "navigate"
  | "go_back"
  | "go_forward"
  | "refresh"
  | "wait"
  | "hover"
  | "select_dropdown"
  | "google_search"
  | "close_tab";

export type RtrvrPageAction = {
  tab_id?: number;
  tool_name: SystemToolName;
  args: Record<string, unknown>;
};

/**
 * rtrvr API Client for browser automation
 */
export class RtrvrClient {
  private apiKey: string;
  private apiUrl: string;
  private deviceId?: string;
  private timeoutMs: number;

  constructor(config: RtrvrClientConfig) {
    if (!config.apiKey) {
      throw new Error("rtrvr API key is required");
    }
    this.apiKey = config.apiKey;
    this.apiUrl = (config.apiUrl ?? DEFAULT_RTRVR_API_URL).replace(/\/$/, "");
    this.deviceId = config.deviceId;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request<T>(
    endpoint: string,
    body: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.apiUrl}/${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(`rtrvr API error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as {
        success?: boolean;
        data?: T;
        error?: { message?: string };
      };

      if (data.success === false && data.error?.message) {
        throw new Error(`rtrvr API error: ${data.error.message}`);
      }

      return (data.data ?? data) as T;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`rtrvr API request timed out after ${timeoutMs}ms`);
      }
      throw err;
    }
  }

  /**
   * List available devices with rtrvr extension installed
   */
  async listDevices(): Promise<{ online: boolean; devices: RtrvrDevice[] }> {
    const result = await this.request<{
      online: boolean;
      deviceCount: number;
      devices: RtrvrDevice[];
    }>("mcpServer", {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: "list_devices",
        arguments: {},
      },
    });
    return {
      online: result.online ?? false,
      devices: result.devices ?? [],
    };
  }

  /**
   * Get current credit balance
   */
  async getCredits(): Promise<RtrvrCredits> {
    return await this.request<RtrvrCredits>("mcpServer", {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: "get_current_credits",
        arguments: {},
      },
    });
  }

  /**
   * Get browser tabs from the extension
   * Requires rtrvr extension to be running
   */
  async getBrowserTabs(opts?: {
    filter?: "all" | "active" | "domain";
    domain?: string;
    deviceId?: string;
  }): Promise<{ tabs: RtrvrTab[]; activeTab?: RtrvrTab }> {
    const result = await this.request<{
      success: boolean;
      tabs: RtrvrTab[];
      activeTab?: RtrvrTab;
      tabCount: number;
    }>("mcpServer", {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: "get_browser_tabs",
        arguments: {
          filter: opts?.filter ?? "all",
          domain: opts?.domain,
          device_id: opts?.deviceId ?? this.deviceId,
        },
      },
    });
    return {
      tabs: result.tabs ?? [],
      activeTab: result.activeTab,
    };
  }

  /**
   * Get page data (accessibility trees) from browser tabs
   * Requires rtrvr extension to be running
   */
  async getPageData(opts: {
    tabIds: number[];
    deviceId?: string;
  }): Promise<{ trees: RtrvrPageTree[] }> {
    const result = await this.request<{
      success: boolean;
      trees: RtrvrPageTree[];
    }>("mcpServer", {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: "get_page_data",
        arguments: {
          tabIds: opts.tabIds,
          device_id: opts.deviceId ?? this.deviceId,
        },
      },
    });
    return { trees: result.trees ?? [] };
  }

  /**
   * Execute page actions on browser tabs
   * Requires rtrvr extension to be running
   */
  async takePageAction(opts: {
    actions: RtrvrPageAction[];
    deviceId?: string;
  }): Promise<RtrvrActionResult> {
    return await this.request<RtrvrActionResult>("mcpServer", {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: {
        name: "take_page_action",
        arguments: {
          actions: opts.actions,
          device_id: opts.deviceId ?? this.deviceId,
        },
      },
    });
  }

  /**
   * AI-powered browser interaction
   * Requires rtrvr extension to be running
   */
  async actOnTab(opts: {
    userInput: string;
    tabUrls?: string[];
    tabId?: number;
    schema?: {
      fields: Array<{ name: string; description?: string; type?: string; required?: boolean }>;
    };
    deviceId?: string;
  }): Promise<RtrvrActResult> {
    return await this.request<RtrvrActResult>(
      "mcpServer",
      {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "act_on_tab",
          arguments: {
            user_input: opts.userInput,
            tab_urls: opts.tabUrls,
            tab_id: opts.tabId,
            schema: opts.schema,
            device_id: opts.deviceId ?? this.deviceId,
          },
        },
      },
      { timeoutMs: this.timeoutMs },
    );
  }

  /**
   * Extract structured data from web pages
   * Requires rtrvr extension to be running
   */
  async extractFromTab(opts: {
    userInput: string;
    tabUrls?: string[];
    tabId?: number;
    schema?: {
      fields: Array<{ name: string; description?: string; type?: string; required?: boolean }>;
    };
    outputDestination?: {
      type: "json" | "google_sheet";
      newSheetTitle?: string;
      existingSheetId?: string;
    };
    deviceId?: string;
  }): Promise<RtrvrExtractResult> {
    return await this.request<RtrvrExtractResult>(
      "mcpServer",
      {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "extract_from_tab",
          arguments: {
            user_input: opts.userInput,
            tab_urls: opts.tabUrls,
            tab_id: opts.tabId,
            schema: opts.schema,
            output_destination: opts.outputDestination,
            device_id: opts.deviceId ?? this.deviceId,
          },
        },
      },
      { timeoutMs: this.timeoutMs },
    );
  }

  /**
   * Execute JavaScript in browser sandbox
   * Requires rtrvr extension to be running
   */
  async executeJavaScript(opts: {
    code: string;
    timeout?: number;
    context?: Record<string, unknown>;
    deviceId?: string;
  }): Promise<{ success: boolean; result?: unknown; consoleOutput?: string[]; error?: string }> {
    return await this.request<{
      success: boolean;
      result?: unknown;
      consoleOutput?: string[];
      error?: string;
    }>(
      "mcpServer",
      {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "execute_javascript",
          arguments: {
            code: opts.code,
            timeout: opts.timeout,
            context: opts.context,
            device_id: opts.deviceId ?? this.deviceId,
          },
        },
      },
      { timeoutMs: opts.timeout ?? 150_000 },
    );
  }

  // ============ Cloud-only tools (no extension required) ============

  /**
   * Scrape web pages using rtrvr's cloud browsers
   * Does NOT require the rtrvr extension
   */
  async cloudScrape(opts: {
    urls: string[];
    settings?: {
      extractionConfig?: { onlyTextContent?: boolean; maxTreeDepth?: number };
    };
    timeoutMs?: number;
  }): Promise<RtrvrCloudScrapeResult> {
    return await this.request<RtrvrCloudScrapeResult>(
      "mcpServer",
      {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "cloud_scrape",
          arguments: {
            urls: opts.urls,
            settings: opts.settings,
            timeoutMs: opts.timeoutMs ?? 60_000,
          },
        },
      },
      { timeoutMs: Math.min(opts.timeoutMs ?? 60_000, 120_000) + 10_000 },
    );
  }

  /**
   * Execute an AI agent task using rtrvr's cloud browsers
   * Does NOT require the rtrvr extension
   */
  async cloudAgent(opts: {
    userInput: string;
    urls?: string[];
    schema?: {
      fields: Array<{ name: string; description?: string; type?: string; required?: boolean }>;
    };
    files?: Array<{ name: string; mimeType: string; data: string }>;
    settings?: { llmIntegration?: { model?: string } };
    timeoutMs?: number;
  }): Promise<RtrvrCloudAgentResult> {
    return await this.request<RtrvrCloudAgentResult>(
      "mcpServer",
      {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "cloud_agent",
          arguments: {
            user_input: opts.userInput,
            urls: opts.urls,
            schema: opts.schema,
            files: opts.files,
            settings: opts.settings,
            timeoutMs: opts.timeoutMs ?? 300_000,
          },
        },
      },
      { timeoutMs: Math.min(opts.timeoutMs ?? 300_000, 540_000) + 10_000 },
    );
  }

  // ============ Helper methods ============

  /**
   * Check if the rtrvr extension is available and online
   */
  async isExtensionAvailable(): Promise<boolean> {
    try {
      const { online } = await this.listDevices();
      return online;
    } catch {
      return false;
    }
  }

  /**
   * Get the configured device ID, or the first available device
   */
  async getEffectiveDeviceId(): Promise<string | undefined> {
    if (this.deviceId) return this.deviceId;
    const { devices } = await this.listDevices();
    const available = devices.filter((d) => d.hasFcmToken);
    return available[0]?.deviceId;
  }
}

/**
 * Create a new rtrvr client instance
 */
export function createRtrvrClient(config: RtrvrClientConfig): RtrvrClient {
  return new RtrvrClient(config);
}
