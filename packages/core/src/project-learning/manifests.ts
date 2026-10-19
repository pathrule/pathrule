// SPDX-License-Identifier: Apache-2.0

import { parse as parseToml } from "smol-toml";
import type { ManifestFacts } from "@pathrule/protocol/project-learning-types.js";

// Only declaration names leave the parser. No scripts, URLs, versions or source bodies.
function name(value: unknown): string | undefined {
  return typeof value === "string" && /^[\w@][\w@./+-]{0,159}$/.test(value) ? value : undefined;
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function validManifestFacts(value: unknown): value is ManifestFacts {
  const facts = object(value);
  return (
    ["node", "rust", "python", "go"].includes(String(facts.ecosystem)) &&
    (facts.name === undefined || name(facts.name) !== undefined) &&
    Array.isArray(facts.dependencies) &&
    facts.dependencies.length <= 100 &&
    facts.dependencies.every(
      (dep) =>
        name(object(dep).name) !== undefined &&
        ["runtime", "development", "peer", "optional"].includes(String(object(dep).kind)),
    ) &&
    Array.isArray(facts.taskNames) &&
    facts.taskNames.length <= 20 &&
    facts.taskNames.every((task) => typeof task === "string" && /^[\w:-]{1,64}$/.test(task))
  );
}

export function readManifestFacts(path: string, body: string): ManifestFacts | undefined {
  const base = path.split("/").at(-1);
  try {
    const dependencies: ManifestFacts["dependencies"] = [];
    const add = (value: unknown, kind: ManifestFacts["dependencies"][number]["kind"]) => {
      for (const key of Object.keys(object(value)).sort()) {
        const valid = name(key);
        if (valid && dependencies.length < 100) dependencies.push({ name: valid, kind });
      }
    };
    if (base === "package.json") {
      const data = object(JSON.parse(body));
      add(data.dependencies, "runtime");
      add(data.devDependencies, "development");
      add(data.peerDependencies, "peer");
      add(data.optionalDependencies, "optional");
      return {
        ecosystem: "node",
        name: name(data.name),
        dependencies,
        taskNames: Object.keys(object(data.scripts))
          .filter((key) => /^[\w:-]{1,64}$/.test(key))
          .sort()
          .slice(0, 20),
      };
    }
    if (base === "Cargo.toml") {
      const data = object(parseToml(body));
      add(data.dependencies, "runtime");
      add(data["dev-dependencies"], "development");
      return {
        ecosystem: "rust",
        name: name(object(data.package).name),
        dependencies,
        taskNames: [],
      };
    }
    if (base === "pyproject.toml") {
      const data = object(parseToml(body));
      const project = object(data.project);
      for (const dependency of Array.isArray(project.dependencies)
        ? project.dependencies.slice(0, 100)
        : []) {
        const valid =
          typeof dependency === "string" ? name(dependency.match(/^[\w.-]+/)?.[0]) : undefined;
        if (valid) dependencies.push({ name: valid, kind: "runtime" });
      }
      const poetry = object(object(data.tool).poetry);
      if (!dependencies.length) add(poetry.dependencies, "runtime");
      return {
        ecosystem: "python",
        name: name(project.name) ?? name(poetry.name),
        dependencies,
        taskNames: [],
      };
    }
    if (base === "go.mod") {
      const moduleName = name(body.match(/^module\s+(\S+)/m)?.[1]);
      let block = false;
      for (const raw of body.split("\n")) {
        const line = raw.replace(/\/\/.*$/, "").trim();
        if (/^require\s*\($/.test(line)) {
          block = true;
          continue;
        }
        if (line === ")") {
          block = false;
          continue;
        }
        const match = block ? line.match(/^(\S+)\s+v\S+/) : line.match(/^require\s+(\S+)\s+v\S+/);
        const valid = name(match?.[1]);
        if (valid && dependencies.length < 100) dependencies.push({ name: valid, kind: "runtime" });
      }
      return { ecosystem: "go", name: moduleName, dependencies, taskNames: [] };
    }
  } catch {
    /* Invalid declarations supply no facts, rather than stale cached facts. */
  }
  return undefined;
}
