#!/usr/bin/env node
/**
 * fetch_models.mjs -- download the model files the benchmark compares.
 *
 *   node tests/vision_model/fetch_models.mjs
 *   node tests/vision_model/fetch_models.mjs lite
 *
 * They land in tests/vision_model/models/, which is gitignored: they are 5-30
 * MB each and only one of them (the full model, already vendored in assets/)
 * belongs in the repo. Nothing here touches assets/ -- swapping the SHIPPED
 * model is a deliberate act with a service-worker cache bump attached to it
 * (see the deploy notes), not something a benchmark script does behind your
 * back.
 */

import { mkdirSync, existsSync, statSync, createWriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MODELS } from "./config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const want = process.argv.slice(2);

let failed = 0;
for (const m of MODELS) {
  if (want.length && !want.includes(m.id)) continue;
  if (!m.url) continue;                       // vendored, or a delegate variant
  const out = resolve(ROOT, m.task);
  if (existsSync(out)) {
    console.log(`have  ${m.id}  ${(statSync(out).size / 1e6).toFixed(1)} MB  ${m.task}`);
    continue;
  }
  mkdirSync(dirname(out), { recursive: true });
  process.stdout.write(`fetch ${m.id} ... `);
  try {
    const res = await fetch(m.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(out));
    console.log(`${(statSync(out).size / 1e6).toFixed(1)} MB -> ${m.task}`);
  } catch (err) {
    failed++;
    console.log(`FAILED: ${err.message}`);
    console.log(`      download by hand from ${m.url}`);
    console.log(`      and save it as ${m.task}`);
  }
}
process.exit(failed ? 1 : 0);
