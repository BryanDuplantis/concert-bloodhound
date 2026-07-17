import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidClientMetadataError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

/**
 * File-backed persistence for the OAuth authorization server, ported from
 * brain-mcp with concert-bloodhound's OWN state directory — the two services
 * must never share a client store (silent cross-service clobber otherwise).
 *
 * Single-user, low-volume. Two on-disk files survive the systemd
 * `Restart=on-failure` the unit performs, so claude.ai never has to re-run the
 * DCR + password-consent flow after a Pi restart:
 *
 *   clients.json  → { [client_id]: OAuthClientInformationFull }   (DCR'd clients)
 *   refresh.json  → { [refreshToken]: RefreshRecord }             (long-lived)
 *
 * Access tokens and authorization codes are NEVER persisted — they live in the
 * provider's in-memory maps (short TTL). A restart simply forces one silent
 * refresh round-trip, which claude.ai handles transparently.
 */

export interface RefreshRecord {
  clientId: string;
  scopes: string[];
  issuedAt: number; // ms since epoch
}

export function oauthStateDir(): string {
  const override = process.env.BLOODHOUND_OAUTH_STATE_DIR;
  if (override && override.trim()) return override;
  return path.join(os.homedir(), ".local", "state", "concert-bloodhound", "oauth");
}

/**
 * Reject a redirect_uri that would let a LOCAL process capture auth codes:
 * a non-HTTPS scheme, or a loopback host (localhost / *.localhost / 127.0.0.0-8 /
 * ::1). The MCP SDK relaxes exact port-matching for loopback hosts, so a single
 * loopback entry in the allowlist would let ANY process on the Pi register a
 * client and capture authorization codes. HTTPS-only + non-loopback keeps the
 * allowlist to real remote callbacks. Throws (fail-closed) on a bad entry.
 */
export function assertSafeRedirectUri(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`OAUTH_ALLOWED_REDIRECT_URIS: not a valid absolute URL: ${JSON.stringify(uri)}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(
      `OAUTH_ALLOWED_REDIRECT_URIS: must be https, got ${parsed.protocol} in ${JSON.stringify(uri)}`,
    );
  }
  // URL.hostname is bracketless for names/IPv4 ('127.0.0.1') and bracketed for
  // IPv6 ('[::1]') — normalize both. 127.0.0.0/8 is entirely loopback.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host);
  if (loopback) {
    throw new Error(`OAUTH_ALLOWED_REDIRECT_URIS: loopback host not allowed: ${JSON.stringify(uri)}`);
  }
}

/**
 * Parse the redirect_uri allowlist from `OAUTH_ALLOWED_REDIRECT_URIS`
 * (comma-separated, exact match).
 *
 * Every non-empty entry is validated (`assertSafeRedirectUri`) so a loopback /
 * non-HTTPS entry fails LOUD. An EMPTY allowlist is a valid state ("DCR disabled"
 * — registerClient rejects all registration); only malformed entries throw.
 * Call this once at boot (http.ts) so a bad allowlist crashes startup rather
 * than surfacing on the first DCR.
 */
export function parseAllowedRedirectUris(): Set<string> {
  const raw = process.env.OAUTH_ALLOWED_REDIRECT_URIS ?? "";
  const uris = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const uri of uris) assertSafeRedirectUri(uri);
  return new Set(uris);
}

async function atomicWriteJson(file: string, data: unknown): Promise<void> {
  // mode 0o700: files are already 0o600, but the parent oauth state dir
  // inherited the umask (often 0o755 → client IDs world-listable). 0o700 has no
  // group/other bits so umask can't loosen it. NOTE: mkdir won't re-mode an
  // already-existing dir — a pre-existing Pi dir needs a one-time `chmod 700` at deploy.
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, file);
}

async function readJsonOrEmpty<T extends object>(file: string): Promise<T> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {} as T;
    throw err;
  }
}

export class FileClientStore implements OAuthRegisteredClientsStore {
  private readonly clientsFile: string;
  private readonly refreshFile: string;
  private clients: Record<string, OAuthClientInformationFull> = {};
  private refresh: Record<string, RefreshRecord> = {};
  private loaded = false;
  // Serialize writes — single process, low volume; a tail-chained promise is
  // enough to prevent two atomic writes from racing the same file.
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dir: string = oauthStateDir()) {
    this.clientsFile = path.join(dir, "clients.json");
    this.refreshFile = path.join(dir, "refresh.json");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.clients = await readJsonOrEmpty<Record<string, OAuthClientInformationFull>>(
      this.clientsFile,
    );
    this.refresh = await readJsonOrEmpty<Record<string, RefreshRecord>>(this.refreshFile);
    this.loaded = true;
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.writeChain = this.writeChain.then(fn, fn);
    return this.writeChain;
  }

  // --- OAuthRegisteredClientsStore ---

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    await this.load();
    return this.clients[clientId];
  }

  /**
   * DCR endpoint. The SDK has already generated client_id/client_secret and set
   * client_secret_expires_at before calling this. We REJECT any redirect_uri not
   * on the allowlist — closing code-exfiltration at registration time (the SDK
   * exact-matches authorize-time redirect_uri against the registered set, so an
   * attacker-controlled redirect_uri stored here would be the hole). Then persist.
   */
  async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    const allowed = parseAllowedRedirectUris();
    if (allowed.size === 0) {
      throw new InvalidClientMetadataError(
        "dynamic client registration is disabled (OAUTH_ALLOWED_REDIRECT_URIS unset)",
      );
    }
    for (const uri of client.redirect_uris) {
      if (!allowed.has(uri)) {
        throw new InvalidClientMetadataError(`redirect_uri not allowed: ${uri}`);
      }
    }
    await this.load();
    // SDK generates client_id when clientIdGeneration !== false; trust it.
    const full = client as OAuthClientInformationFull;
    this.clients[full.client_id] = full;
    const snapshot = { ...this.clients };
    await this.enqueue(() => atomicWriteJson(this.clientsFile, snapshot));
    return full;
  }

  // --- Refresh token persistence ---

  async getRefresh(token: string): Promise<RefreshRecord | undefined> {
    await this.load();
    return this.refresh[token];
  }

  async saveRefresh(token: string, record: RefreshRecord): Promise<void> {
    await this.load();
    this.refresh[token] = record;
    const snapshot = { ...this.refresh };
    await this.enqueue(() => atomicWriteJson(this.refreshFile, snapshot));
  }

  async deleteRefresh(token: string): Promise<void> {
    await this.load();
    if (!(token in this.refresh)) return;
    delete this.refresh[token];
    const snapshot = { ...this.refresh };
    await this.enqueue(() => atomicWriteJson(this.refreshFile, snapshot));
  }
}
