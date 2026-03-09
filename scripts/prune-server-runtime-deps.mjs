#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { builtinModules, createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parse } = require("@babel/parser");
const traverse = require("@babel/traverse").default;

const repoRoot = process.cwd();
const nodeModulesDir = path.join(repoRoot, "node_modules");
const serverEntry = path.join(repoRoot, "dist/server/index.mjs");
const dryRun = process.argv.includes("--dry-run");
const codeExtensions = new Set([".cjs", ".js", ".mjs"]);
const builtinSpecifiers = new Set(builtinModules.flatMap((name) => [name, name.replace(/^node:/u, "")]));

function fail(message) {
  console.error(`[prune-server-runtime-deps] ${message}`);
  process.exit(1);
}

function assertBuildArtifacts() {
  if (!fs.existsSync(nodeModulesDir)) {
    fail(`Missing node_modules at ${nodeModulesDir}.`);
  }

  if (!fs.existsSync(serverEntry)) {
    fail(`Missing built server entry at ${serverEntry}. Run pnpm build first.`);
  }
}

function assertHoistedNodeModules() {
  const pnpmDir = path.join(nodeModulesDir, ".pnpm");
  if (!fs.existsSync(pnpmDir)) {
    return;
  }

  const unexpectedEntries = fs.readdirSync(pnpmDir).filter((entry) => entry !== "lock.yaml" && entry !== "lock.yml");

  if (unexpectedEntries.length > 0) {
    fail("This prune script expects pnpm hoisted node_modules. Found non-hoisted entries in node_modules/.pnpm.");
  }
}

function isBareSpecifier(specifier) {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("node:");
}

function toPackageName(specifier) {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

function collectSpecifiers(filePath, source) {
  let ast;

  try {
    ast = parse(source, {
      sourceType: "unambiguous",
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      plugins: ["dynamicImport", "importAttributes", "jsx", "topLevelAwait"],
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[prune-server-runtime-deps] Skipping unparseable file ${filePath}: ${reason}`);
    return [];
  }

  const specifiers = new Set();

  traverse(ast, {
    CallExpression(nodePath) {
      const { node } = nodePath;
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "require" &&
        node.arguments.length === 1 &&
        node.arguments[0]?.type === "StringLiteral"
      ) {
        specifiers.add(node.arguments[0].value);
      }
    },
    ExportAllDeclaration(nodePath) {
      const sourceNode = nodePath.node.source;
      if (sourceNode?.type === "StringLiteral") {
        specifiers.add(sourceNode.value);
      }
    },
    ExportNamedDeclaration(nodePath) {
      const sourceNode = nodePath.node.source;
      if (sourceNode?.type === "StringLiteral") {
        specifiers.add(sourceNode.value);
      }
    },
    ImportDeclaration(nodePath) {
      const sourceNode = nodePath.node.source;
      if (sourceNode.type === "StringLiteral") {
        specifiers.add(sourceNode.value);
      }
    },
    ImportExpression(nodePath) {
      const sourceNode = nodePath.node.source;
      if (sourceNode.type === "StringLiteral") {
        specifiers.add(sourceNode.value);
      }
    },
  });

  return [...specifiers];
}

function collectRuntimePackages() {
  const keepPackages = new Set();
  const pendingFiles = [serverEntry];
  const visitedFiles = new Set();

  while (pendingFiles.length > 0) {
    const nextFile = pendingFiles.pop();
    if (!nextFile) {
      continue;
    }

    let resolvedFile;
    try {
      resolvedFile = fs.realpathSync.native(nextFile);
    } catch {
      continue;
    }

    if (visitedFiles.has(resolvedFile)) {
      continue;
    }
    visitedFiles.add(resolvedFile);

    if (!codeExtensions.has(path.extname(resolvedFile))) {
      continue;
    }

    const source = fs.readFileSync(resolvedFile, "utf8");
    const resolver = createRequire(resolvedFile);

    for (const specifier of collectSpecifiers(resolvedFile, source)) {
      const packageName = toPackageName(specifier);
      if (specifier.startsWith("node:") || builtinSpecifiers.has(specifier) || builtinSpecifiers.has(packageName)) {
        continue;
      }

      let resolvedDependency;
      try {
        resolvedDependency = resolver.resolve(specifier);
      } catch {
        continue;
      }

      if (isBareSpecifier(specifier)) {
        keepPackages.add(packageName);
      }

      if (
        resolvedDependency.startsWith(repoRoot) ||
        resolvedDependency.includes(`${path.sep}node_modules${path.sep}`)
      ) {
        pendingFiles.push(resolvedDependency);
      }
    }
  }

  return keepPackages;
}

function listInstalledPackages() {
  const installedPackages = new Set();
  const entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const entryPath = path.join(nodeModulesDir, entry.name);
    if (!(entry.isDirectory() || entry.isSymbolicLink())) {
      continue;
    }

    if (entry.name.startsWith("@")) {
      const scopedEntries = fs.readdirSync(entryPath, { withFileTypes: true });
      for (const scopedEntry of scopedEntries) {
        if (scopedEntry.isDirectory() || scopedEntry.isSymbolicLink()) {
          installedPackages.add(`${entry.name}/${scopedEntry.name}`);
        }
      }
      continue;
    }

    installedPackages.add(entry.name);
  }

  return installedPackages;
}

function removePackage(packageName) {
  if (packageName.startsWith("@")) {
    const [scope, name] = packageName.split("/");
    const scopeDir = path.join(nodeModulesDir, scope);
    const packageDir = path.join(scopeDir, name);
    fs.rmSync(packageDir, { recursive: true, force: true });

    if (fs.existsSync(scopeDir) && fs.readdirSync(scopeDir).length === 0) {
      fs.rmSync(scopeDir, { recursive: true, force: true });
    }
    return;
  }

  fs.rmSync(path.join(nodeModulesDir, packageName), { recursive: true, force: true });
}

function formatPackageList(packages) {
  const visiblePackages = packages.slice(0, 20);
  const suffix =
    packages.length > visiblePackages.length ? ` ... +${packages.length - visiblePackages.length} more` : "";
  return `${visiblePackages.join(", ")}${suffix}`;
}

assertBuildArtifacts();
assertHoistedNodeModules();

const keepPackages = [...collectRuntimePackages()].sort();
const installedPackages = [...listInstalledPackages()].sort();
const removablePackages = installedPackages.filter((packageName) => !keepPackages.includes(packageName));

console.log(
  `[prune-server-runtime-deps] Keeping ${keepPackages.length} runtime packages and pruning ${removablePackages.length} packages from node_modules.`,
);

if (removablePackages.length > 0) {
  console.log(`[prune-server-runtime-deps] Prune candidates: ${formatPackageList(removablePackages)}`);
}

if (dryRun) {
  process.exit(0);
}

for (const packageName of removablePackages) {
  removePackage(packageName);
}

console.log("[prune-server-runtime-deps] Runtime dependency pruning complete.");
