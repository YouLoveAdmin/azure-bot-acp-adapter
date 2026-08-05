import fs from "fs";
import path from "path";

export type SymlinkMapping = {
  source: string;
  target: string;
};

function normalizeMapping(value: string): string {
  return value.trim();
}

export function parseSymlinkMappings(raw: string | undefined): SymlinkMapping[] {
  if (!raw) {
    return [];
  }

  const entries = raw
    .split(",")
    .map((entry) => normalizeMapping(entry))
    .filter((entry) => entry.length > 0);

  return entries.flatMap((entry) => {
    const separator = entry.includes("=>") ? "=>" : entry.includes("=") ? "=" : entry.includes(":") ? ":" : null;
    if (!separator) {
      return [];
    }

    const [sourcePart, targetPart] = entry.split(separator);
    const source = sourcePart?.trim();
    const target = targetPart?.trim();

    if (!source || !target) {
      return [];
    }

    return [{ source, target }];
  });
}

function ensureDirectory(targetPath: string): void {
  fs.mkdirSync(targetPath, { recursive: true });
}

export function applySymlinkMappings(rawMappings: string | undefined): void {
  const mappings = parseSymlinkMappings(rawMappings);
  for (const { source, target } of mappings) {
    const sourcePath = path.resolve(source);
    const targetPath = path.resolve(target);

    if (!fs.existsSync(sourcePath)) {
      ensureDirectory(sourcePath);
    }

    if (!fs.existsSync(targetPath)) {
      ensureDirectory(targetPath);
    }

    if (fs.existsSync(sourcePath) && fs.lstatSync(sourcePath).isDirectory() && fs.existsSync(targetPath) && fs.lstatSync(targetPath).isDirectory()) {
      const targetParent = path.dirname(targetPath);
      if (!fs.existsSync(path.join(targetParent, path.basename(sourcePath)))) {
        // create a directory placeholder when a direct symlink is not possible
        fs.symlinkSync(sourcePath, targetPath, "dir");
      }
    }
  }
}
