/**
 * Normalize icon URLs, uploaded files and pasted SVG for server storage. Convert files and SVG
 * to base64 data URIs; preserve HTTP(S) URLs.
 */

/** Supported plugin icon MIME types. */
export const ICON_TYPES = ["image/svg+xml", "image/png", "image/jpeg", "image/webp"];

/** Maximum stored icon size in bytes. */
export const MAX_ICON_BYTES = 1_000_000;

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** Detect SVG markup with optional XML declarations, comments, or doctype prefixes. */
export function isSvgMarkup(text: string) {
  return /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*|<!doctype[^>]*>\s*)*<svg[\s>]/i.test(
    text,
  );
}

/** Return an icon-validation error, or null for a supported image. */
export function iconProblem(type: string, bytes: number) {
  if (!ICON_TYPES.includes(type)) {
    return "Icons can be SVG, PNG, JPEG or WebP.";
  }
  if (bytes > MAX_ICON_BYTES) {
    return "Icons can be up to 1 MB.";
  }
  return null;
}

/** Read a blob as a base64 data URI. */
export function readDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(String(reader.result));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("The image could not be read."));
    };
    reader.readAsDataURL(blob);
  });
}

/** Add a missing SVG namespace to pasted markup so it renders as an image. */
export function svgBlob(markup: string) {
  const text = markup.trim();
  const named = /<svg\b[^>]*\sxmlns\s*=/i.test(text);
  const svg = named ? text : text.replace(/<svg\b/i, `<svg xmlns="${SVG_NAMESPACE}"`);
  return new Blob([svg], { type: "image/svg+xml" });
}
