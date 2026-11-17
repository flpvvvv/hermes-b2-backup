import type { StandaloneConfig } from "@backblaze-labs/agent-backup-core";

const AUTH_URL = "https://api.backblazeb2.com/b2api/v3/b2_authorize_account";
const USER_AGENT = "b2ai-hermes-backup";
const MAX_ATTEMPTS = 4;

export type FileVersion = {
  fileName: string;
  fileId: string;
  action: string;
  size?: number;
  uploadTimestamp?: number;
};

type AuthorizeResponse = {
  accountId: string;
  authorizationToken: string;
  apiInfo?: {
    storageApi?: {
      apiUrl?: string;
      bucketId?: string;
      bucketName?: string;
      s3ApiUrl?: string;
    };
  };
  apiUrl?: string;
  s3ApiUrl?: string;
};

type ListVersionsResponse = {
  files: FileVersion[];
  nextFileName?: string | null;
  nextFileId?: string | null;
};

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 8_000) + Math.floor(Math.random() * 250);
}

export async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await fn(items[index]!);
    }
  });
  await Promise.all(workers);
}

/**
 * Small B2 Native API client, used only for operations the S3 client cannot do:
 * listing every file version and permanently deleting a version (including hide
 * markers). S3 DELETE without `versionId` only inserts another hide marker.
 */
export class B2Native {
  private apiUrl: string;
  private token: string;
  private readonly accountId: string;
  readonly bucketId: string;
  readonly region?: string;

  private constructor(
    private readonly config: StandaloneConfig,
    auth: {
      apiUrl: string;
      token: string;
      accountId: string;
      bucketId: string;
      region?: string;
    },
  ) {
    this.apiUrl = auth.apiUrl;
    this.token = auth.token;
    this.accountId = auth.accountId;
    this.bucketId = auth.bucketId;
    this.region = auth.region;
  }

  static async create(config: StandaloneConfig): Promise<B2Native> {
    const auth = await B2Native.authorize(config);
    return new B2Native(config, auth);
  }

  private static async authorize(config: StandaloneConfig): Promise<{
    apiUrl: string;
    token: string;
    accountId: string;
    bucketId: string;
    region?: string;
  }> {
    const basic = Buffer.from(`${config.keyId}:${config.applicationKey}`).toString("base64");
    const res = await fetch(AUTH_URL, {
      headers: { authorization: `Basic ${basic}`, "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`b2 authorize failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const data = (await res.json()) as AuthorizeResponse;
    const storage = data.apiInfo?.storageApi;
    const apiUrl = storage?.apiUrl ?? data.apiUrl;
    const token = data.authorizationToken;
    const accountId = data.accountId;
    if (!apiUrl || !token || !accountId) {
      throw new Error("b2 authorize response is missing apiUrl, authorizationToken or accountId");
    }
    const s3Url = storage?.s3ApiUrl ?? data.s3ApiUrl;
    const region = s3Url?.match(/s3\.([^.]+)\.backblazeb2\.com/)?.[1];

    let bucketId = storage?.bucketId;
    if (!bucketId) {
      const res2 = await fetch(`${apiUrl}/b2api/v3/b2_list_buckets`, {
        method: "POST",
        headers: { authorization: token, "content-type": "application/json", "user-agent": USER_AGENT },
        body: JSON.stringify({ accountId, bucketName: config.bucket }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res2.ok) {
        const text = await res2.text().catch(() => "");
        throw new Error(`b2 list buckets failed (${res2.status}): ${text.slice(0, 300)}`);
      }
      const list = (await res2.json()) as { buckets?: { bucketId: string; bucketName: string }[] };
      const match = list.buckets?.find((b) => b.bucketName === config.bucket);
      if (!match) throw new Error(`b2 bucket not found or not accessible: ${config.bucket}`);
      bucketId = match.bucketId;
    }
    return { apiUrl, token, accountId, bucketId, region };
  }

  private async reauthorize(): Promise<void> {
    const auth = await B2Native.authorize(this.config);
    this.apiUrl = auth.apiUrl;
    this.token = auth.token;
  }

  private async request<T>(endpoint: string, body: unknown): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(`${this.apiUrl}/b2api/v3/${endpoint}`, {
          method: "POST",
          headers: {
            authorization: this.token,
            "content-type": "application/json",
            "user-agent": USER_AGENT,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });
        if (res.status === 401 && attempt < MAX_ATTEMPTS) {
          await this.reauthorize();
          continue;
        }
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt));
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`b2 ${endpoint} failed (${res.status}): ${text.slice(0, 300)}`);
        }
        return (await res.json()) as T;
      } catch (err) {
        lastError = err;
        if (attempt < MAX_ATTEMPTS) {
          await sleep(backoffMs(attempt));
          continue;
        }
      }
    }
    throw new Error(`b2 ${endpoint} failed after ${MAX_ATTEMPTS} attempts: ${String(lastError)}`);
  }

  /** Every file version and hide marker under `prefix`, oldest first as returned by B2. */
  async listFileVersions(prefix: string): Promise<FileVersion[]> {
    const all: FileVersion[] = [];
    let startFileName: string | undefined;
    let startFileId: string | undefined;
    for (;;) {
      const body: Record<string, unknown> = {
        bucketId: this.bucketId,
        prefix,
        maxFileCount: 1000,
      };
      if (startFileName) {
        body.startFileName = startFileName;
        body.startFileId = startFileId;
      }
      const page = await this.request<ListVersionsResponse>("b2_list_file_versions", body);
      all.push(...(page.files ?? []));
      if (!page.nextFileName) break;
      if (page.nextFileName === startFileName && page.nextFileId === startFileId) {
        throw new Error(`b2 list_file_versions pagination stalled under ${prefix}`);
      }
      startFileName = page.nextFileName;
      startFileId = page.nextFileId ?? undefined;
    }
    return all;
  }

  async deleteFileVersion(version: Pick<FileVersion, "fileName" | "fileId">): Promise<void> {
    await this.request("b2_delete_file_version", {
      fileName: version.fileName,
      fileId: version.fileId,
    });
  }

  async deleteVersions(
    versions: readonly FileVersion[],
    onProgress?: (done: number) => void,
  ): Promise<number> {
    let done = 0;
    await mapLimit(versions, 8, async (version) => {
      await this.deleteFileVersion(version);
      done++;
      if (done % 200 === 0) onProgress?.(done);
    });
    onProgress?.(done);
    return done;
  }

  /**
   * Permanently remove every version under `prefix`. With `deleteManifestFirst`,
   * the snapshot's manifest is removed before any data so a crash cannot leave a
   * "complete" snapshot missing chunks. `excludePrefix` filters out keys that
   * must be kept (used to preserve `archives/` during legacy cleanup).
   */
  async purgePrefix(
    prefix: string,
    options: {
      deleteManifestFirst?: boolean;
      excludePrefix?: string;
      onProgress?: (done: number) => void;
    } = {},
  ): Promise<number> {
    const versions = (await this.listFileVersions(prefix)).filter(
      (v) => !options.excludePrefix || !v.fileName.startsWith(options.excludePrefix),
    );
    if (options.deleteManifestFirst) {
      const manifestKey = `${prefix}manifest.enc`;
      const manifests = versions.filter((v) => v.fileName === manifestKey);
      await this.deleteVersions(manifests, options.onProgress);
      const rest = versions.filter((v) => v.fileName !== manifestKey);
      await this.deleteVersions(rest, options.onProgress);
      return manifests.length + rest.length;
    }
    return this.deleteVersions(versions, options.onProgress);
  }
}
