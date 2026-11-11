import { asRecord, errorMessage } from "@/utils/misc";

import type {
  DesktopMcpConfig,
  DesktopPluginPreview,
  DesktopPluginPreviewAction,
  DesktopPluginPreviewIcons,
  DesktopPluginPreviewResult,
  DesktopPluginSecret,
} from "./desktopClient";

/** Match server limits so local previews reject packages the server cannot install. */
const MAX_PACKAGE_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_ICON_BYTES = 1_000_000;

/** Supported icon formats and MIME types in server preference order. */
const ICON_TYPES: ReadonlyArray<readonly [string, string]> = [
  ["icon.svg", "image/svg+xml"],
  ["icon.png", "image/png"],
  ["icon.jpg", "image/jpeg"],
  ["icon.jpeg", "image/jpeg"],
  ["icon.webp", "image/webp"],
];

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const END_OF_CENTRAL_DIRECTORY_SIZE = 22;
const MAX_ZIP_COMMENT_SIZE = 0xffff;
const ZIP64_MARKER = 0xffffffff;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const FLAG_ENCRYPTED = 0x1;

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

interface IconAsset {
  name: string;
  mime: string;
  entry: ZipEntry;
}

async function readView(file: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await file.slice(start, end).arrayBuffer());
}

/** Read ZIP entries from the central directory. */
async function readZipEntries(file: File): Promise<ZipEntry[]> {
  const tailStart = Math.max(0, file.size - END_OF_CENTRAL_DIRECTORY_SIZE - MAX_ZIP_COMMENT_SIZE);
  const tail = await readView(file, tailStart, file.size);
  let end = -1;
  for (let index = tail.byteLength - END_OF_CENTRAL_DIRECTORY_SIZE; index >= 0; index -= 1) {
    if (tail.getUint32(index, true) === END_OF_CENTRAL_DIRECTORY) {
      end = index;
      break;
    }
  }
  if (end < 0) throw new Error("This file is not a valid zip archive.");

  const entryCount = tail.getUint16(end + 10, true);
  const directorySize = tail.getUint32(end + 12, true);
  const directoryOffset = tail.getUint32(end + 16, true);
  if (directoryOffset === ZIP64_MARKER || entryCount === 0xffff) {
    throw new Error("ZIP64 archives are not supported. Re-create the zip with a standard tool.");
  }

  const directory = await readView(file, directoryOffset, directoryOffset + directorySize);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let cursor = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (directory.getUint32(cursor, true) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new Error("The zip archive's file list is damaged.");
    }
    const nameLength = directory.getUint16(cursor + 28, true);
    const extraLength = directory.getUint16(cursor + 30, true);
    const commentLength = directory.getUint16(cursor + 32, true);
    const nameStart = directory.byteOffset + cursor + 46;
    entries.push({
      flags: directory.getUint16(cursor + 8, true),
      method: directory.getUint16(cursor + 10, true),
      compressedSize: directory.getUint32(cursor + 20, true),
      uncompressedSize: directory.getUint32(cursor + 24, true),
      localHeaderOffset: directory.getUint32(cursor + 42, true),
      name: decoder.decode(new Uint8Array(directory.buffer, nameStart, nameLength)),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Read a stream up to `limit` bytes, failing immediately if exceeded. */
async function readLimited(stream: ReadableStream<Uint8Array>, limit: number, label: string) {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error(`${label} is larger than ${limit.toLocaleString()} bytes.`);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readZipEntry(file: File, entry: ZipEntry, limit: number, label: string) {
  if (entry.flags & FLAG_ENCRYPTED) throw new Error(`${label} is encrypted.`);
  if (entry.uncompressedSize > limit) {
    throw new Error(`${label} is larger than ${limit.toLocaleString()} bytes.`);
  }
  const header = await readView(file, entry.localHeaderOffset, entry.localHeaderOffset + 30);
  if (header.getUint32(0, true) !== LOCAL_FILE_HEADER) {
    throw new Error(`The zip entry for ${label} is damaged.`);
  }
  // Read the local header separately because its extra field may differ from the central
  // directory.
  const dataStart =
    entry.localHeaderOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const data = file.slice(dataStart, dataStart + entry.compressedSize).stream();
  if (entry.method === METHOD_STORED) return readLimited(data, limit, label);
  if (entry.method === METHOD_DEFLATED) {
    return readLimited(data.pipeThrough(new DecompressionStream("deflate-raw")), limit, label);
  }
  throw new Error(`${label} uses an unsupported zip compression method.`);
}

function isIgnoredEntry(name: string): boolean {
  return name.split("/").some((part) => part === "__MACOSX" || part === ".DS_Store");
}

/**
 * Find `manifest.json` at the archive root or inside a single top-level directory containing
 * all entries, matching server validation.
 */
function packageRoot(names: string[]): string {
  if (names.includes("manifest.json")) return "";
  const roots = names.map((name) => {
    const slash = name.indexOf("/");
    if (slash < 0) return null;
    return name.slice(0, slash);
  });
  const root = roots[0];
  const singleRoot = root !== null && root !== undefined && roots.every((other) => other === root);
  if (!singleRoot || !names.includes(`${root}/manifest.json`)) {
    throw new Error(
      "manifest.json must be at the top of the zip, or inside one folder that holds everything else.",
    );
  }
  return `${root}/`;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  return typeof value === "string" ? value : "";
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = stringField(record, field).trim();
  if (!value) throw new Error(`manifest.json is missing "${field}".`);
  return value;
}

interface NamedManifestItem {
  name: string;
  description: string;
}

function namedItems(value: unknown, field: string): NamedManifestItem[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`manifest.json "${field}" must be a list.`);
  return value.map((item, index) => {
    const record = asRecord(item);
    if (!record) throw new Error(`manifest.json "${field}[${index}]" must be an object.`);
    return { name: stringField(record, "name"), description: stringField(record, "description") };
  });
}

function parseMcpConfig(value: unknown): DesktopMcpConfig {
  const mcp = asRecord(value);
  if (!mcp) throw new Error('manifest.json "mcp" must be an object.');
  const transport = stringField(mcp, "transport");
  if (transport === "stdio" || transport === "streamable_http") {
    requiredString(mcp, transport === "stdio" ? "command" : "url");
    return mcp as unknown as DesktopMcpConfig;
  }
  throw new Error('manifest.json "mcp.transport" must be "stdio" or "streamable_http".');
}

function parseManifest(bytes: Uint8Array): DesktopPluginPreview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("manifest.json is not valid JSON.");
  }
  const manifest = asRecord(parsed);
  if (!manifest) throw new Error("manifest.json must be a JSON object.");

  const version = stringField(manifest, "version").trim();
  const base = {
    id: requiredString(manifest, "id"),
    name: requiredString(manifest, "name"),
    version: version || undefined,
    description: stringField(manifest, "description"),
    themeColor: stringField(manifest, "themeColor"),
    secrets: namedItems(manifest.secrets, "secrets") satisfies DesktopPluginSecret[],
  };

  const runtime = stringField(manifest, "runtime");
  if (runtime === "wasm") {
    const actions: DesktopPluginPreviewAction[] = namedItems(manifest.actions, "actions");
    if (actions.length === 0) throw new Error("manifest.json must declare at least one action.");
    return { ...base, runtime: "wasm", actions };
  }
  if (runtime === "mcp") {
    return { ...base, runtime: "mcp", mcp: parseMcpConfig(manifest.mcp) };
  }
  throw new Error('manifest.json "runtime" must be "wasm" or "mcp".');
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(String(reader.result));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("The icon could not be read."));
    };
    reader.readAsDataURL(blob);
  });
}

/** Resolve the import-preview icon using the server's primary and light/dark variant rules. */
async function readIcon(
  file: File,
  entries: Map<string, ZipEntry>,
  root: string,
): Promise<DesktopPluginPreviewIcons> {
  const primaries: IconAsset[] = ICON_TYPES.flatMap(([name, mime]) => {
    const entry = entries.get(`${root}${name}`);
    return entry ? [{ name, mime, entry }] : [];
  });
  if (primaries.length > 1) {
    throw new Error("The package must contain at most one primary icon.");
  }

  const dark = entries.get(`${root}icon-dark.svg`);
  const light = entries.get(`${root}icon-light.svg`);
  const hasPrimary = primaries.length === 1;
  const hasDark = dark !== undefined;
  const hasLight = light !== undefined;

  if (hasDark !== hasLight) {
    throw new Error(
      hasPrimary
        ? "The package must contain both icon-dark.svg and icon-light.svg, or neither."
        : "The package needs both icon-dark.svg and icon-light.svg when it has no primary icon.",
    );
  }
  if (!hasPrimary && !hasDark) {
    throw new Error(
      "The package needs an icon: icon.svg, or both icon-dark.svg and icon-light.svg.",
    );
  }

  if (light && dark) {
    const [lightBytes, darkBytes] = await Promise.all([
      readZipEntry(file, light, MAX_ICON_BYTES, "icon-light.svg"),
      readZipEntry(file, dark, MAX_ICON_BYTES, "icon-dark.svg"),
    ]);
    return {
      light: await blobToDataUrl(new Blob([lightBytes], { type: "image/svg+xml" })),
      dark: await blobToDataUrl(new Blob([darkBytes], { type: "image/svg+xml" })),
    };
  }

  const icon = primaries[0];
  const bytes = await readZipEntry(file, icon.entry, MAX_ICON_BYTES, icon.name);
  const dataUrl = await blobToDataUrl(new Blob([bytes], { type: icon.mime }));
  return { light: dataUrl, dark: dataUrl };
}

async function readPluginPackage(file: File) {
  if (!file.name.toLowerCase().endsWith(".zip")) {
    throw new Error("Choose a .zip Plugin package.");
  }
  if (file.size > MAX_PACKAGE_BYTES) {
    throw new Error(`The package is larger than ${MAX_PACKAGE_BYTES.toLocaleString()} bytes.`);
  }
  const entries = (await readZipEntries(file)).filter((entry) => !isIgnoredEntry(entry.name));
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const root = packageRoot(entries.map((entry) => entry.name));
  const manifestEntry = byName.get(`${root}manifest.json`);
  if (!manifestEntry) throw new Error("The package has no manifest.json.");
  const manifestBytes = await readZipEntry(
    file,
    manifestEntry,
    MAX_MANIFEST_BYTES,
    "manifest.json",
  );
  const plugin = parseManifest(manifestBytes);
  const iconDataUrls = await readIcon(file, byName, root);
  return { plugin, iconDataUrls };
}

/** Preview a package locally. Return failures as error results instead of rejecting. */
export async function previewPluginPackage(file: File): Promise<DesktopPluginPreviewResult> {
  try {
    const { plugin, iconDataUrls } = await readPluginPackage(file);
    return { fileName: file.name, status: "previewed", iconDataUrls, plugin };
  } catch (error) {
    return { fileName: file.name, status: "error", error: errorMessage(error) };
  }
}
