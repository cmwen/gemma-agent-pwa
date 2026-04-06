import { promises as fs } from "node:fs";
import path from "node:path";

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "entry"
  );
}

export function normalizeAgentId(value: string): string {
  return slugify(value);
}

export function compactTimestamp(timestamp: string): string {
  return timestamp.slice(0, 19).replace(/[^0-9]/g, "");
}

export function isoFromCompactTimestamp(compact: string): string {
  if (!/^\d{14}$/.test(compact)) {
    return compact;
  }

  const year = compact.slice(0, 4);
  const month = compact.slice(4, 6);
  const day = compact.slice(6, 8);
  const hour = compact.slice(8, 10);
  const minute = compact.slice(10, 12);
  const second = compact.slice(12, 14);
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

export function displayTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toISOString().slice(0, 16).replace("T", " ");
}

export function firstParagraph(markdown: string): string {
  const cleaned = markdown
    .replace(/^---[\s\S]*?---\n?/, "")
    .split(/\n\s*\n/)
    .map((block) => block.replace(/^#+\s+/gm, "").trim())
    .find((block) => block.length > 0);

  return cleaned ?? "No description provided.";
}

export function toPosixRelative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

export function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function readOptionalFile(
  targetPath: string
): Promise<string | undefined> {
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function readDirNames(root: string): Promise<string[]> {
  if (!(await pathExists(root))) {
    return [];
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

export async function walkFiles(root: string): Promise<string[]> {
  if (!(await pathExists(root))) {
    return [];
  }

  const results: string[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const resolvedPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walkFiles(resolvedPath)));
      continue;
    }

    if (entry.isFile()) {
      results.push(resolvedPath);
    }
  }

  return results;
}
