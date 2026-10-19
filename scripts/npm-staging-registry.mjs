// A local npm registry for staged tarballs. It serves the staged packages itself and passes every
// other request to the public registry, so `npm install --registry <url>` resolves a staged graph
// exactly as it would once published: dependencies, peers, optional dependencies, `--omit`.
// Only reads reach the public registry. Used by scripts/smoke-npm-pack.mjs.
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";

/**
 * @param {{ tarballs: { manifest: object, path: string, integrity: string, shasum: string }[],
 *           upstream?: string }} options
 * @returns {Promise<{ url: string, close: () => Promise<void>, requests: string[] }>}
 */
export function startStagingRegistry({ tarballs, upstream = "https://registry.npmjs.org" }) {
  const byName = new Map();
  for (const t of tarballs) {
    const entry = byName.get(t.manifest.name) ?? [];
    entry.push(t);
    byName.set(t.manifest.name, entry);
  }
  const requests = [];
  let url = "";

  const server = createServer((req, res) => {
    const path = decodeURIComponent((req.url ?? "/").split("?")[0]);
    requests.push(`${req.method} ${path}`);
    // A staged tarball, at the path the public registry would serve it from (a shrinkwrap records
    // those URLs, and npm sends them here because this is its registry).
    const tarball = tarballs.find((t) => path === tarballPath(t.manifest));
    if (tarball) {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return void createReadStream(tarball.path).pipe(res);
    }
    const name = path.slice(1);
    const staged = byName.get(name);
    if (staged && req.method === "GET") {
      const versions = Object.fromEntries(
        staged.map((t) => [
          t.manifest.version,
          {
            ...t.manifest,
            _id: `${t.manifest.name}@${t.manifest.version}`,
            // The public registry sets this when the tarball holds an npm-shrinkwrap.json, and npm
            // reads a shrinkwrap only when it is set.
            ...(t.hasShrinkwrap ? { _hasShrinkwrap: true } : {}),
            dist: {
              tarball: `${url}${tarballPath(t.manifest)}`,
              integrity: t.integrity,
              shasum: t.shasum,
            },
          },
        ]),
      );
      const latest = staged.at(-1).manifest.version;
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ _id: name, name, "dist-tags": { latest }, versions }));
    }
    // Everything else, the third-party packuments and tarballs, comes from the public registry.
    const upstreamReq = httpsRequest(
      `${upstream}${req.url}`,
      {
        method: req.method,
        headers: {
          accept: req.headers.accept ?? "*/*",
          "user-agent": req.headers["user-agent"] ?? "pathrule-staging-registry",
        },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, {
          "content-type": upstreamRes.headers["content-type"] ?? "application/octet-stream",
          ...(upstreamRes.headers.location ? { location: upstreamRes.headers.location } : {}),
        });
        upstreamRes.pipe(res);
      },
    );
    upstreamReq.on("error", (error) => {
      res.writeHead(502).end(String(error));
    });
    req.pipe(upstreamReq);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      url = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url,
        requests,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/** Where the public registry serves a package's tarball: `/<name>/-/<unscoped name>-<version>.tgz`. */
export function tarballPath(manifest) {
  return `/${manifest.name}/-/${manifest.name.split("/").pop()}-${manifest.version}.tgz`;
}

/** The tarballs a staging run wrote (scripts/stage-npm-packages.mjs), read from its staging.json. */
export function stagedTarballs(stagingDir) {
  const report = JSON.parse(readFileSync(join(stagingDir, "staging.json"), "utf8"));
  return report.packages.map((p) => {
    const dir = join(stagingDir, "packages", p.name.split("/")[1]);
    return {
      manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")),
      hasShrinkwrap: existsSync(join(dir, "npm-shrinkwrap.json")),
      path: join(stagingDir, p.tarball),
      integrity: p.integrity,
      shasum: p.shasum,
    };
  });
}
