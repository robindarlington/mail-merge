/**
 * template — load a plain-text message template from disk (T-081-03).
 *
 * Ported from send-credentials.ts::loadTemplate: the first `Subject:` line
 * becomes the subject, the remainder (minus one leading blank line) is the body.
 *
 * Path-traversal hardening: the operator supplies their OWN path, but we still
 * `resolve` it and confirm it is a regular file (`statSync().isFile()`) before
 * reading — a directory or missing path errors NAMING THE FLAG, never leaking
 * file contents.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import type { MessageTemplate } from "../../../lib/core/index.js";

/**
 * Read `path` and split it into `{ subject, body }`. Throws (naming --template)
 * if the path is not a regular file or lacks a leading `Subject:` line.
 */
export function loadTemplate(path: string): MessageTemplate {
  const resolved = resolve(path);

  let isFile = false;
  try {
    isFile = statSync(resolved).isFile();
  } catch {
    throw new Error(`--template path is not readable: ${path}`);
  }
  if (!isFile) {
    throw new Error(`--template must point to a file: ${path}`);
  }

  const raw = readFileSync(resolved, "utf8");
  const match = raw.match(/^Subject:\s*(.*)\r?\n/i);
  if (!match) {
    throw new Error('--template must start with a "Subject: ..." line');
  }
  return {
    subject: match[1].trim(),
    body: raw.slice(match[0].length).replace(/^\r?\n/, ""),
  };
}
