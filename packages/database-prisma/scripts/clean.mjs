import { rm, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(packageRoot, "dist");
const generatedDir = path.join(packageRoot, "generated");

const artifactSuffixes = [".js", ".js.map", ".d.ts", ".d.ts.map"];

function isBuildArtifact(fileName) {
  return artifactSuffixes.some((suffix) => fileName.endsWith(suffix));
}

async function removeGeneratedArtifacts(directory) {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }

    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await removeGeneratedArtifacts(entryPath);
      continue;
    }

    if (isBuildArtifact(entry.name)) {
      await rm(entryPath, { force: true });
    }
  }
}

await rm(distDir, { recursive: true, force: true });
await removeGeneratedArtifacts(generatedDir);
