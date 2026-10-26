import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Bucket, awsRegion } from './env';

/**
 * Reads the evidence bucket directly with the AWS SDK — no browser, no Microsoft page, no MFA during the run.
 * Credentials come from the standard AWS chain: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN in .env
 * (temporary keys of the QA-S3-Readonly role from the portal's "Access keys"), or AWS_PROFILE (aws sso login).
 */
export class S3Reader {
  private client: S3Client;
  constructor(private bucket = s3Bucket, region = awsRegion) {
    this.client = new S3Client({ region });
  }

  /** Every S3 call gets a time limit — a stalled connection (or a key that expired while a call was in flight) used to hang the run for ever. */
  private async send<T>(cmd: any, ms = 60_000): Promise<T> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ms);
    try { return (await this.client.send(cmd, { abortSignal: ac.signal })) as T; }
    catch (e: any) {
      if (ac.signal.aborted) throw new Error(`S3 call timed out after ${ms / 1000}s (network stalled, or the AWS keys expired while it was running)`);
      throw e;
    } finally { clearTimeout(timer); }
  }

  /** Fails early with a readable message when the keys are missing / expired / not allowed. */
  async check(prefix: string): Promise<void> {
    try {
      await this.send<any>(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: 1 }));
    } catch (e: any) {
      const n = e?.name || '';
      if (/ExpiredToken|InvalidToken|InvalidAccessKeyId|SignatureDoesNotMatch|CredentialsProviderError/i.test(n) || /credential/i.test(e?.message || ''))
        throw new Error(`AWS keys are missing or expired [AWS said: ${n || 'Error'} — ${String(e?.message || '').slice(0, 160)}] [env: key id ${(process.env.AWS_ACCESS_KEY_ID || '').slice(0, 4) || 'EMPTY'}…, secret ${process.env.AWS_SECRET_ACCESS_KEY ? 'set' : 'EMPTY'}, token ${process.env.AWS_SESSION_TOKEN ? 'set' : 'EMPTY'}, profile ${process.env.AWS_PROFILE || '-'}]. Open the AWS access portal → QA-S3-Readonly → "Access keys", copy the 3 values into .env (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN) and run again.`);
      if (/AccessDenied/i.test(n)) throw new Error(`Access denied on s3://${this.bucket}/${prefix} — the role cannot read this path.`);
      throw new Error(describeAwsError(e));
    }
  }

  async list(prefix: string): Promise<{ folders: string[]; files: string[] }> {
    const folders: string[] = []; const files: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.send<any>(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, Delimiter: '/', ContinuationToken: token }));
      (r.CommonPrefixes || []).forEach((c) => c.Prefix && folders.push(c.Prefix));
      (r.Contents || []).forEach((c) => c.Key && c.Key !== prefix && files.push(c.Key));
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
    return { folders, files };
  }

  async walk(prefix: string, maxDepth = 6, maxFolders = 200): Promise<{ exists: boolean; files: string[] }> {
    const files: string[] = []; let exists = false; let seen = 0;
    const queue: { p: string; d: number }[] = [{ p: prefix, d: 0 }];
    while (queue.length && seen < maxFolders) {
      const { p, d } = queue.shift()!; seen++;
      const r = await this.list(p);
      if (r.folders.length || r.files.length) exists = true;
      files.push(...r.files);
      if (d < maxDepth) r.folders.forEach((f) => queue.push({ p: f, d: d + 1 }));
    }
    return { exists, files };
  }

  async readText(key: string): Promise<string> {
    const r = await this.send<any>(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return r.Body!.transformToString();
  }

  /** Whole file as bytes (any type), for saving an exact copy. */
  async readBytes(key: string): Promise<Uint8Array> {
    const r = await this.send<any>(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return r.Body!.transformToByteArray();
  }

  /** First bytes of a file (for the s3-files.json overview). */
  async readHead(key: string, bytes = 1500): Promise<string> {
    const r = await this.send<any>(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${bytes - 1}` }));
    return r.Body!.transformToString();
  }
}

/** AWS errors sometimes have an empty message (e.g. an expired token on a HEAD request) — always say what we know. */
export function describeAwsError(e: any): string {
  const name = e?.name || 'Error';
  const status = e?.$metadata?.httpStatusCode;
  const code = e?.Code || e?.code;
  const msg = String(e?.message || '').trim();
  const bits = [`${name}${code && code !== name ? ` (${code})` : ''}`, status ? `HTTP ${status}` : '', msg].filter(Boolean).join(' — ');
  const hint = !msg || /ExpiredToken|UnknownError|^4(00|03)$/i.test(`${name} ${code} ${status}`)
    ? ' — the temporary AWS keys most likely EXPIRED (they last about an hour): copy fresh QA-S3-Readonly keys into .env and run `npm run s3` (S3_RESULTS_DIR=<results folder>, S3_FORCE=1) to re-check this branch'
    : '';
  return `S3 error: ${bits}${hint}`;
}
