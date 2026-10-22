"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";

import { primaryButtonClass } from "@/components/ui/styles";
import { getMessages, interpolate } from "@/lib/i18n";
import { memberPhotoBasePath, PHOTO_LIMITS } from "@/lib/wedding-site/photos/model";

/**
 * "Subir fotos" (UX-01B, ADR-022 §3, plan §3). For each chosen file: check
 * ≤ 15 MB and an image type, decode it in the browser (orientation applied),
 * downsize to ≤ 2400 px and re-encode as a ≤ 4 MB JPEG — a TRANSPORT step for
 * Vercel's request limit, never trusted: the server checks, decodes and
 * re-encodes again — then POST it to the upload route with real progress, at
 * most three at a time. Each file's state is announced politely; the page
 * refreshes when all are done.
 */

type Status =
  | { kind: "queued" | "preparing" | "processing" | "done" }
  | { kind: "uploading"; percent: number }
  | { kind: "failed"; message: string };

type Item = { key: string; name: string; status: Status };

const ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,.jpg,.jpeg,.png,.webp,.heic,.heif";
const IMAGE_TYPES = /^image\/(jpeg|png|webp|heic|heif)$/;
const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|heic|heif)$/i;

const errors = () => getMessages().site.photos.errors;

function reasonMessage(reason: unknown): string {
  const e = errors();
  switch (reason) {
    case "unsupported":
      return e.unsupported;
    case "too_small":
      return e.tooSmall;
    case "too_large":
      return e.tooLarge;
    case "limit":
      return e.limit;
    case "busy":
      return e.busy;
    case "daily_limit":
      return e.dailyLimit;
    case "storage_limit":
      return e.storageLimit;
    case "paused":
      return e.paused;
    case "disabled":
      return e.disabled;
    default:
      return e.failed;
  }
}

/** Decodes, orients, downsizes and re-encodes in the browser. Throws "unsupported" when the browser can't read it. */
async function prepare(file: File): Promise<Blob> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("unsupported");
  }
  const scale = Math.min(1, PHOTO_LIMITS.transportMaxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  if (Math.min(width, height) < PHOTO_LIMITS.minShortEdge) {
    bitmap.close();
    throw new Error("too_small");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    bitmap.close();
    throw new Error("failed");
  }
  // A transparent PNG becomes JPEG on white, not black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  for (const quality of [0.9, 0.82, 0.74, 0.66]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size <= PHOTO_LIMITS.transportBytes) return blob;
  }
  throw new Error("too_large");
}

function send(url: string, blob: Blob, onProgress: (percent: number) => void, onSent: () => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.responseType = "json";
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    };
    request.upload.onload = onSent;
    request.onload = () => resolve(request.response);
    request.onerror = () => reject(new Error("network"));
    const form = new FormData();
    form.append("photo", blob, "photo.jpg");
    request.send(form);
  });
}

export function PhotoUploader({ weddingId, remaining }: { weddingId: string; remaining: number }) {
  const copy = getMessages().site.photos.upload;
  const router = useRouter();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);

  const update = (key: string, status: Status) =>
    setItems((current) => current.map((item) => (item.key === key ? { ...item, status } : item)));

  async function uploadOne(item: Item, file: File) {
    if (file.size > PHOTO_LIMITS.inputBytes) return update(item.key, { kind: "failed", message: errors().tooBig });
    if (!IMAGE_TYPES.test(file.type) && !IMAGE_EXTENSIONS.test(file.name)) {
      return update(item.key, { kind: "failed", message: errors().unsupported });
    }
    update(item.key, { kind: "preparing" });
    let blob: Blob;
    try {
      blob = await prepare(file);
    } catch (error) {
      return update(item.key, { kind: "failed", message: reasonMessage(error instanceof Error ? error.message : "") });
    }
    update(item.key, { kind: "uploading", percent: 0 });
    try {
      const response = await send(
        `${memberPhotoBasePath(weddingId)}/upload`,
        blob,
        (percent) => update(item.key, { kind: "uploading", percent }),
        () => update(item.key, { kind: "processing" }),
      );
      const result = response as { ok?: unknown; reason?: unknown } | null;
      if (result && result.ok === true) update(item.key, { kind: "done" });
      else update(item.key, { kind: "failed", message: reasonMessage(result?.reason) });
    } catch {
      update(item.key, { kind: "failed", message: errors().network });
    }
  }

  async function start() {
    const files = Array.from(input.current?.files ?? []);
    if (files.length === 0 || busy) return;
    setBusy(true);
    setFinished(false);
    const batch = files.map((file, index) => ({
      item: { key: `${Date.now()}-${index}`, name: file.name, status: { kind: "queued" } as Status },
      file,
    }));
    // Files beyond the 20-photo limit are refused here; the server refuses them anyway.
    setItems(
      batch.map(({ item }, index) =>
        index < remaining ? item : { ...item, status: { kind: "failed", message: errors().limit } },
      ),
    );
    const queue = batch.slice(0, Math.max(0, remaining));
    const workers = Array.from({ length: Math.min(PHOTO_LIMITS.concurrentUploads, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await uploadOne(next.item, next.file);
    });
    await Promise.all(workers);
    if (input.current) input.current.value = "";
    setBusy(false);
    setFinished(true);
    router.refresh();
  }

  const label = (status: Status) => {
    switch (status.kind) {
      case "queued":
        return "…";
      case "preparing":
        return copy.preparing;
      case "uploading":
        return interpolate(copy.uploading, { percent: String(status.percent) });
      case "processing":
        return copy.processing;
      case "done":
        return copy.done;
      case "failed":
        return status.message;
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label htmlFor={inputId} className="block font-semibold">
          {copy.label}
        </label>
        <p className="text-muted text-sm">{copy.hint}</p>
        <input
          ref={input}
          id={inputId}
          type="file"
          accept={ACCEPT}
          multiple
          disabled={busy || remaining <= 0}
          className="block w-full max-w-md text-sm file:mr-3 file:min-h-11 file:rounded-full file:border file:border-border file:bg-surface file:px-4 file:font-semibold"
          data-testid="photo-upload-input"
        />
      </div>
      <button type="button" onClick={start} disabled={busy || remaining <= 0} className={primaryButtonClass}>
        {copy.button}
      </button>
      {items.length > 0 ? (
        <ul aria-label={copy.listLabel} aria-live="polite" className="space-y-2 text-sm" data-testid="photo-upload-status">
          {items.map((item) => (
            <li key={item.key} className="flex flex-wrap justify-between gap-x-4 gap-y-1 rounded-lg border border-border px-3 py-2">
              <span className="min-w-0 break-all">{item.name}</span>
              <span className={item.status.kind === "failed" ? "text-danger font-semibold" : "font-semibold"}>
                {label(item.status)}
              </span>
              {item.status.kind === "uploading" ? (
                <progress className="h-1.5 w-full" max={100} value={item.status.percent} aria-hidden="true" />
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {finished ? (
        <p role="status" className="text-sm font-semibold">
          {copy.allDone}
        </p>
      ) : null}
    </div>
  );
}
