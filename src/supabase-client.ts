import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.js";
import { qs } from "./utils";

type MetricsStatus = number | "NETWORK_ERROR";
type LogEntry = { method: string; endpoint: string; status: number; durationMs: number };
type RequestEntry = LogEntry & { url: string; timestamp: string };
interface RequestStats {
  sessionStartTime: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  requestsPerMinute: number;
  statusCodes: Record<string, number>;
  methods: Record<string, number>;
  totalResponseTimeMs: number;
  averageResponseTimeMs: number;
  minResponseTimeMs: number | null;
  maxResponseTimeMs: number;
  lastRequestTimestamp: string | null;
  requestsLog: RequestEntry[];
}

class SupabaseMetricsClient {
  private readonly client: SupabaseClient;
  private readonly telemetryBuffer: LogEntry[] = [];
  private readonly flushIntervalMs = 15_000;
  private readonly stats: RequestStats = {
    sessionStartTime: new Date().toISOString(),
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    requestsPerMinute: 0,
    statusCodes: {},
    methods: {},
    totalResponseTimeMs: 0,
    averageResponseTimeMs: 0,
    minResponseTimeMs: null,
    maxResponseTimeMs: 0,
    lastRequestTimestamp: null,
    requestsLog: [],
  };

  constructor(url: string, key: string) {
    this.client = createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      global: { fetch: this.trackedFetch.bind(this) },
    });
    window.setInterval(() => void this.flushTelemetry(), this.flushIntervalMs);
  }

  private async trackedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const start = performance.now();
    const method = (init?.method ?? "GET").toUpperCase();
    let status: MetricsStatus = "NETWORK_ERROR";
    let success = false;
    try {
      // All PostgREST table writes, reads and RPCs pass through FastAPI.
      // Auth, Storage and Realtime remain direct Supabase connections.
      const originalUrl = input instanceof Request ? input.url : input.toString();
      const dataPrefix = `${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/`;
      let dataInput: RequestInfo | URL = input;
      if (originalUrl.startsWith(dataPrefix)) {
        const relativePath = originalUrl.slice(dataPrefix.length);
        const proxyUrl = `${location.origin}/api/db/${relativePath}`;
        dataInput = input instanceof Request ? new Request(proxyUrl, input) : proxyUrl;
      }
      const result = await fetch(dataInput, init);
      status = result.status;
      success = result.ok;
      return result;
    } finally {
      const url = typeof input === "string" ? input : input.toString();
      const excluded = ["get_pg_version", "flush_client_metrics", "get_global_metrics_24h"];
      if (!excluded.some((name) => url.includes(`/rpc/${name}`))) {
        this.recordMetrics(method, url, performance.now() - start, status, success);
      }
    }
  }

  private recordMetrics(method: string, url: string, duration: number, status: MetricsStatus, success: boolean): void {
    const stats = this.stats;
    const durationMs = Number(duration.toFixed(2));
    stats.totalRequests += 1;
    stats.totalResponseTimeMs += duration;
    stats.lastRequestTimestamp = new Date().toISOString();
    if (success) stats.successfulRequests += 1;
    else stats.failedRequests += 1;
    stats.methods[method] = (stats.methods[method] ?? 0) + 1;
    stats.statusCodes[status] = (stats.statusCodes[status] ?? 0) + 1;
    stats.minResponseTimeMs = Math.min(stats.minResponseTimeMs ?? durationMs, durationMs);
    stats.maxResponseTimeMs = Math.max(stats.maxResponseTimeMs, durationMs);
    stats.averageResponseTimeMs = Number((stats.totalResponseTimeMs / stats.totalRequests).toFixed(2));
    const elapsedMinutes = (Date.now() - Date.parse(stats.sessionStartTime)) / 60_000;
    stats.requestsPerMinute = elapsedMinutes > 0 ? Number((stats.totalRequests / elapsedMinutes).toFixed(2)) : 0;
    let endpoint = url;
    try { endpoint = new URL(url).pathname; } catch { /* URL may be relative */ }
    const log: LogEntry = { method, endpoint, status: status === "NETWORK_ERROR" ? 0 : status, durationMs };
    this.telemetryBuffer.push(log);
    stats.requestsLog.push({ ...log, timestamp: stats.lastRequestTimestamp, url: endpoint });
    if (stats.requestsLog.length > 128) stats.requestsLog.shift();
  }

  private async flushTelemetry(): Promise<void> {
    if (!currentUser || this.telemetryBuffer.length === 0) return;
    const metrics = this.telemetryBuffer.splice(0);
    const { error } = await this.client.rpc("flush_client_metrics", { metrics });
    if (error) {
      this.telemetryBuffer.unshift(...metrics);
      if (this.telemetryBuffer.length > 500) this.telemetryBuffer.splice(0, this.telemetryBuffer.length - 500);
      console.error("Failed to synchronize metrics", error);
    }
  }

  getStatsSnapshot(): Promise<RequestStats> {
    return Promise.resolve(structuredClone(this.stats));
  }

  getClient(): SupabaseClient { return this.client; }
}

export const supabaseWrapper = new SupabaseMetricsClient(SUPABASE_URL, SUPABASE_ANON_KEY);
export const UserRoles = Object.freeze({ ADMIN: "admin", SUPERVISOR: "supervisor", CARTEIRO: "carteiro" });
export let appInitialized = false;
export let currentUserRole: string | null = null;
export let currentUser: User | null = null;
export const sb = supabaseWrapper.getClient();

export function setCurrentUser(user: User | null): void { currentUser = user; }
export function setCurrentUserRole(role: string | null): void { currentUserRole = role; }
export function setAppInitialized(value: boolean): void { appInitialized = value; }

let pingInitialized = false;
export function initSupabasePing(): void {
  if (pingInitialized) return;
  pingInitialized = true;
  const dot = qs("#ping-dot");
  const text = qs("#ping-text");
  if (!dot || !text) return;
  window.setInterval(async () => {
    if (document.visibilityState !== "visible" || currentUserRole !== UserRoles.ADMIN) return;
    const startedAt = performance.now();
    try {
      const { error } = await sb.rpc("get_pg_version");
      if (error) throw error;
      const latency = Math.round(performance.now() - startedAt);
      text.textContent = `${latency}ms`;
      dot.className = latency < 200 ? "ping-dot ping-green" : latency < 800 ? "ping-dot ping-yellow" : "ping-dot ping-red";
    } catch {
      dot.className = "ping-dot ping-red";
      text.textContent = "Err";
    }
  }, 3000);
}
