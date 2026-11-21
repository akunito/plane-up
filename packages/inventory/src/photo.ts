// Item photos (APLANE-66). Online only: the device queue never carries a photo. Flow: shrink on the device →
// POST photo/ (the server makes a pending row and a presigned POST) → the bytes go straight to storage →
// PATCH photo/<id>/ confirms it, and it becomes THE photo (the server soft-deletes the previous one).
//
// The re-encode is not optional: a phone photo is 3–8 MB against the server's 5 MB FILE_SIZE_LIMIT, and
// drawing it onto a canvas drops its EXIF, GPS position included, before anything leaves the phone.

import { requestJson } from "./client";
import type { ClientOptions, Fetched } from "./client";

export const PHOTO_MAX_SIDE = 1600;
export const PHOTO_TYPE = "image/jpeg";
/** The server's default FILE_SIZE_LIMIT; a smaller server limit comes back as `too_large` with `limit`. */
export const PHOTO_LIMIT = 5 * 1024 * 1024;
const QUALITIES = [0.82, 0.7, 0.55, 0.4];

export function fitSize(width: number, height: number, max = PHOTO_MAX_SIDE): { width: number; height: number } {
  const longest = width > height ? width : height;
  if (longest <= max) return { width, height };
  const scale = max / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export interface Decoded {
  width: number;
  height: number;
  close(): void;
}

/** What shrinking needs from the browser; injectable so it is testable without a canvas. */
export interface ImageEnv<D extends Decoded = Decoded> {
  decode(file: Blob): Promise<D>;
  encode(image: D, width: number, height: number, quality: number): Promise<Blob>;
}

function paint(
  g: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null,
  image: CanvasImageSource,
  width: number,
  height: number
) {
  if (!g) throw new Error("no 2d context");
  // JPEG has no transparency: without a fill a transparent PNG comes out black (phase 8 audit).
  g.fillStyle = "#fff";
  g.fillRect(0, 0, width, height);
  g.drawImage(image, 0, 0, width, height);
}

export const browserImageEnv: ImageEnv<ImageBitmap & Decoded> = {
  // from-image: phones store portrait shots as rotated landscape plus an EXIF flag, which the re-encode drops.
  // A browser that rejects the option still decodes without it (upright as stored) rather than refusing the photo.
  decode: (file) => createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => createImageBitmap(file)),
  async encode(image, width, height, quality) {
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(width, height);
      paint(canvas.getContext("2d"), image, width, height);
      return canvas.convertToBlob({ type: PHOTO_TYPE, quality });
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    paint(canvas.getContext("2d"), image, width, height);
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => {
          if (b) resolve(b);
          else reject(new Error("encode failed"));
        },
        PHOTO_TYPE,
        quality
      );
    });
  },
};

/** A JPEG of at most PHOTO_MAX_SIDE on its longest side and at most `limit` bytes, or null if it cannot be. */
export async function shrinkPhoto<D extends Decoded>(
  file: Blob,
  env: ImageEnv<D>,
  limit = PHOTO_LIMIT
): Promise<Blob | null> {
  const image = await env.decode(file);
  try {
    const { width, height } = fitSize(image.width, image.height);
    for (let i = 0; i < QUALITIES.length; i++) {
      // Sequential on purpose: each lower quality is tried only when the one before did not fit.
      // oxlint-disable-next-line no-await-in-loop
      const out = await env.encode(image, width, height, QUALITIES[i]);
      if (out.size > 0 && out.size <= limit) return out;
    }
    return null;
  } finally {
    image.close();
  }
}

const photoPath = (opts: ClientOptions, projectId: string, itemId: string) =>
  `workspaces/${encodeURIComponent(opts.slug)}/projects/${encodeURIComponent(projectId)}/inventory/items/${encodeURIComponent(itemId)}/photo/`;

/** The <img> source of a confirmed photo: the server redirects to a short-lived storage URL. */
export const photoUrl = (opts: ClientOptions, projectId: string, itemId: string, assetId: string) =>
  `${opts.base}/api/${photoPath(opts, projectId, itemId)}${encodeURIComponent(assetId)}/`;

interface Started {
  asset_id: string;
  upload_data: { url: string; fields: Record<string, string> };
}

/**
 * Upload an already shrunk photo and make it the item's photo. Answers the item's payload. A failure at
 * storage is "failed"/"server" (or "offline"); the pending row it leaves is the server's to expire.
 */
export async function uploadPhoto<T>(
  opts: ClientOptions,
  projectId: string,
  itemId: string,
  photo: Blob,
  /** Called just before the confirming request: the payload it answers is as fresh as that moment, not as the
   * start of an upload that can take two minutes (merges by fetch time drop it otherwise; phase 8 audit F1). */
  beforeConfirm?: () => void
): Promise<Fetched<T>> {
  const path = photoPath(opts, projectId, itemId);
  const started = await requestJson<Started>(opts, "POST", path, { type: photo.type, size: photo.size });
  if (started.kind !== "ok") return started;
  const { asset_id, upload_data } = started.body;
  const form = new FormData();
  for (const [key, value] of Object.entries(upload_data.fields)) form.append(key, value);
  // Last: S3 ignores form fields after the file.
  form.append("file", photo);
  let stored: Response;
  try {
    stored = await (opts.fetchImpl ?? fetch)(upload_data.url, {
      method: "POST",
      body: form,
      // Storage is another service: no Plane cookies to it, as in the main app's uploader (withCredentials false).
      credentials: "omit",
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    return { kind: "failed", failure: "offline", status: 0 };
  }
  if (!stored.ok) return { kind: "failed", failure: "server", status: stored.status };
  beforeConfirm?.();
  return requestJson<T>(opts, "PATCH", `${path}${encodeURIComponent(asset_id)}/`, {});
}

export const removePhoto = <T>(opts: ClientOptions, projectId: string, itemId: string) =>
  requestJson<T>(opts, "DELETE", photoPath(opts, projectId, itemId));
