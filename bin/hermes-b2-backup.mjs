#!/usr/bin/env node
import { runCli } from "../dist/index.mjs";

runCli().catch((err) => {
  console.error(`hermes-b2-backup: ${err?.message ?? err}`);
  process.exit(1);
});
