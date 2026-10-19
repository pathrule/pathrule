// SPDX-License-Identifier: Apache-2.0
// One `pathrule ui` per Pathrule home. The running one publishes `<Pathrule home>/ui.json` (0600, in
// a 0700 home): its pid, port, version and a control token. A second `pathrule ui` that finds a live
// one asks it for a fresh launch link (`POST /control/launch` with the control token, no browser
// headers) instead of starting another server. A record whose process is gone is replaced, and the
// running one removes its record when it stops, only while the record is still its own.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";

import { withFileLock } from "@pathrule/core/storage/file-lock.js";
import {
  PATHRULE_DIR_MODE,
  PATHRULE_FILE_MODE,
  pathruleHome,
} from "@pathrule/core/storage/paths.js";
import { processAlive } from "@pathrule/host/discovery.js";

import { UI_LOOPBACK_HOST } from "./server.js";

const RECORD_LOCK = { timeoutMs: 10_000, staleMs: 10_000 } as const;
const CONTROL_TIMEOUT_MS = 3_000;

export interface UiInstanceRecord {
  pid: number;
  port: number;
  /** The bearer `/control/launch` takes. Never printed. */
  controlToken: string;
  version: string;
}

export function uiRecordFile(env: NodeJS.ProcessEnv): string {
  return join(pathruleHome(env), "ui.json");
}

function lockFile(env: NodeJS.ProcessEnv): string {
  return `${uiRecordFile(env)}.lock`;
}

function isRecord(value: unknown): value is UiInstanceRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    Number.isInteger(r.pid) &&
    Number.isInteger(r.port) &&
    typeof r.controlToken === "string" &&
    r.controlToken.length > 0 &&
    typeof r.version === "string"
  );
}

/** The published record, or null when there is none or it is unreadable. */
export async function readUiRecord(env: NodeJS.ProcessEnv): Promise<UiInstanceRecord | null> {
  try {
    const value: unknown = JSON.parse(await readFile(uiRecordFile(env), "utf8"));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The record of a `pathrule ui` that is still running, or null. */
export async function liveUiRecord(env: NodeJS.ProcessEnv): Promise<UiInstanceRecord | null> {
  const record = await readUiRecord(env);
  return record && processAlive(record.pid) ? record : null;
}

/** Created 0600 from the first byte, then renamed into place: the token is never readable by others. */
async function writeRecord(env: NodeJS.ProcessEnv, record: UiInstanceRecord): Promise<void> {
  const home = pathruleHome(env);
  await mkdir(home, { recursive: true, mode: PATHRULE_DIR_MODE });
  const target = uiRecordFile(env);
  const tmp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, {
      mode: PATHRULE_FILE_MODE,
      flag: "wx",
    });
    await chmod(tmp, PATHRULE_FILE_MODE);
    await rename(tmp, target);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Publishes `ours`, unless another live `pathrule ui` holds the home: then that one's record is
 * returned and nothing is written. `replace` names a record already found unusable (its pid lives,
 * but it did not answer), which is overwritten.
 */
export async function claimUiRecord(
  env: NodeJS.ProcessEnv,
  ours: UiInstanceRecord,
  replace: UiInstanceRecord | null = null,
): Promise<UiInstanceRecord | null> {
  await mkdir(pathruleHome(env), { recursive: true, mode: PATHRULE_DIR_MODE });
  return withFileLock(
    lockFile(env),
    async () => {
      const current = await readUiRecord(env);
      if (
        current &&
        current.controlToken !== ours.controlToken &&
        current.controlToken !== replace?.controlToken &&
        processAlive(current.pid)
      ) {
        return current;
      }
      await writeRecord(env, ours);
      return null;
    },
    RECORD_LOCK,
  );
}

/** Removes the record while it is still the one holding `controlToken`. */
export async function releaseUiRecord(
  env: NodeJS.ProcessEnv,
  controlToken: string,
): Promise<boolean> {
  return withFileLock(
    lockFile(env),
    async () => {
      const current = await readUiRecord(env);
      if (current?.controlToken !== controlToken) return false;
      await rm(uiRecordFile(env), { force: true });
      return true;
    },
    RECORD_LOCK,
  ).catch(() => false);
}

export interface UiLaunchAnswer {
  launchUrl: string;
  port: number;
  pid: number;
}

/** Asks the running `pathrule ui` for a fresh launch link. Throws when it does not answer. */
export function requestLaunch(
  record: UiInstanceRecord,
  timeoutMs = CONTROL_TIMEOUT_MS,
): Promise<UiLaunchAnswer> {
  return new Promise((resolve, reject) => {
    const body = "{}";
    const req = request(
      {
        host: UI_LOOPBACK_HOST,
        port: record.port,
        path: "/control/launch",
        method: "POST",
        headers: {
          host: `${UI_LOOPBACK_HOST}:${record.port}`,
          authorization: `Bearer ${record.controlToken}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            reject(new Error(`the running pathrule ui answered ${res.statusCode}`));
            return;
          }
          try {
            const answer = JSON.parse(text) as Partial<UiLaunchAnswer>;
            if (typeof answer.launchUrl !== "string" || typeof answer.port !== "number") {
              throw new Error("no launch link in the answer");
            }
            resolve({
              launchUrl: answer.launchUrl,
              port: answer.port,
              pid: typeof answer.pid === "number" ? answer.pid : record.pid,
            });
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)));
    req.on("error", reject);
    req.end(body);
  });
}
