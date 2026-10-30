import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { GetObjectCommand, PutObjectCommand, S3Client, type S3ClientConfig } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { artifactNameSchema } from "@codecitadel/contracts";

export interface PresignedArtifactUpload {
  url: string;
  headers: Record<string, string>;
  key: string;
  expiresAt: string;
}

export interface S3ArtifactStorageOptions {
  bucket: string;
  region: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  uploadTtlSeconds?: number;
}

/** Private S3-compatible bucket adapter. Keys are opaque and the bucket remains private. */
export class S3ArtifactStorage {
  private readonly client: S3Client;
  private readonly ttl: number;

  constructor(private readonly options: S3ArtifactStorageOptions) {
    if (options.bucket.trim() === "") throw new Error("S3 bucket must not be empty.");
    const ttl = options.uploadTtlSeconds ?? 900;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 3600) {
      throw new Error("S3 upload URL lifetime must be from 60 to 3600 seconds.");
    }
    this.ttl = ttl;
    const config: S3ClientConfig = {
      region: options.region,
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      forcePathStyle: options.forcePathStyle ?? options.endpoint !== undefined,
    };
    this.client = new S3Client(config);
  }

  async createUpload(input: {
    organizationId: string;
    runId: string;
    name: string;
    digest: string;
    bytes: number;
  }): Promise<PresignedArtifactUpload> {
    if (!artifactNameSchema.safeParse(input.name).success) throw new Error("Invalid artifact name.");
    if (!/^sha256:[0-9a-f]{64}$/.test(input.digest) || !Number.isSafeInteger(input.bytes) || input.bytes <= 0) {
      throw new Error("Artifact digest or byte count is invalid.");
    }
    const key = `artifacts/${encodeURIComponent(input.organizationId)}/${encodeURIComponent(input.runId)}/${input.name}/${randomUUID()}`;
    const checksum = Buffer.from(input.digest.slice(7), "hex").toString("base64");
    const command = new PutObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
      ContentLength: input.bytes,
      ChecksumSHA256: checksum,
      ContentType: "application/octet-stream",
    });
    return {
      url: await getSignedUrl(this.client, command, { expiresIn: this.ttl }),
      headers: {
        "content-type": "application/octet-stream",
        "x-amz-checksum-sha256": checksum,
      },
      key,
      expiresAt: new Date(Date.now() + this.ttl * 1000).toISOString(),
    };
  }

  async verifyUpload(key: string, expectedDigest: string, expectedBytes: number): Promise<void> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
    if (response.Body === undefined) throw new Error("S3 returned an empty artifact body.");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const part of response.Body as AsyncIterable<Uint8Array>) {
      const chunk = Buffer.from(part);
      bytes += chunk.length;
      if (bytes > expectedBytes) throw new Error("Uploaded artifact is larger than declared.");
      hash.update(chunk);
    }
    if (bytes !== expectedBytes || `sha256:${hash.digest("hex")}` !== expectedDigest) {
      throw new Error("Uploaded artifact bytes do not match the declared size and SHA-256 digest.");
    }
  }

  async getStream(key: string): Promise<{ body: Readable; bytes: number }> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }));
    if (response.Body === undefined) throw new Error("S3 returned an empty artifact body.");
    const body = response.Body instanceof Readable ? response.Body : Readable.from(response.Body as AsyncIterable<Uint8Array>);
    return { body, bytes: response.ContentLength ?? 0 };
  }

  close(): void {
    this.client.destroy();
  }
}
