import test from "node:test";
import assert from "node:assert/strict";
import { resolveDataDir } from "../src/services/data-dir.ts";

test("paper mode routes shared runtime state into the isolated paper directory", () => {
  const previous = { action: process.env.ACTION_MODE, data: process.env.PIXYMON_DATA_DIR, live: process.env.PIXYMON_LIVE_DATA_DIR, paper: process.env.PIXYMON_PAPER_DATA_DIR };
  process.env.ACTION_MODE = "paper";
  process.env.PIXYMON_DATA_DIR = "/tmp/pixymon-live";
  process.env.PIXYMON_LIVE_DATA_DIR = "/tmp/pixymon-live";
  process.env.PIXYMON_PAPER_DATA_DIR = "/tmp/pixymon-paper";
  try {
    assert.equal(resolveDataDir(), "/tmp/pixymon-paper");
  } finally {
    if (previous.action === undefined) delete process.env.ACTION_MODE; else process.env.ACTION_MODE = previous.action;
    if (previous.data === undefined) delete process.env.PIXYMON_DATA_DIR; else process.env.PIXYMON_DATA_DIR = previous.data;
    if (previous.live === undefined) delete process.env.PIXYMON_LIVE_DATA_DIR; else process.env.PIXYMON_LIVE_DATA_DIR = previous.live;
    if (previous.paper === undefined) delete process.env.PIXYMON_PAPER_DATA_DIR; else process.env.PIXYMON_PAPER_DATA_DIR = previous.paper;
  }
});

test("paper mode fails closed without a distinct paper directory", () => {
  const previous = { action: process.env.ACTION_MODE, data: process.env.PIXYMON_DATA_DIR, live: process.env.PIXYMON_LIVE_DATA_DIR, paper: process.env.PIXYMON_PAPER_DATA_DIR };
  process.env.ACTION_MODE = "paper";
  process.env.PIXYMON_DATA_DIR = "/tmp/pixymon-live";
  process.env.PIXYMON_LIVE_DATA_DIR = "/tmp/pixymon-live";
  try {
    delete process.env.PIXYMON_PAPER_DATA_DIR;
    assert.throws(() => resolveDataDir(), /PIXYMON_PAPER_DATA_DIR/);
    process.env.PIXYMON_PAPER_DATA_DIR = "/tmp/pixymon-live";
    assert.throws(() => resolveDataDir(), /separate/);
  } finally {
    if (previous.action === undefined) delete process.env.ACTION_MODE; else process.env.ACTION_MODE = previous.action;
    if (previous.data === undefined) delete process.env.PIXYMON_DATA_DIR; else process.env.PIXYMON_DATA_DIR = previous.data;
    if (previous.live === undefined) delete process.env.PIXYMON_LIVE_DATA_DIR; else process.env.PIXYMON_LIVE_DATA_DIR = previous.live;
    if (previous.paper === undefined) delete process.env.PIXYMON_PAPER_DATA_DIR; else process.env.PIXYMON_PAPER_DATA_DIR = previous.paper;
  }
});

test("shared state honors the live directory alias and never reuses it for paper", () => {
  const previous = { action: process.env.ACTION_MODE, data: process.env.PIXYMON_DATA_DIR, live: process.env.PIXYMON_LIVE_DATA_DIR, paper: process.env.PIXYMON_PAPER_DATA_DIR };
  process.env.PIXYMON_DATA_DIR = "/tmp/pixymon-legacy";
  process.env.PIXYMON_LIVE_DATA_DIR = "/tmp/pixymon-live-alias";
  try {
    process.env.ACTION_MODE = "live";
    assert.equal(resolveDataDir(), "/tmp/pixymon-live-alias");
    process.env.ACTION_MODE = "paper";
    process.env.PIXYMON_PAPER_DATA_DIR = "/tmp/pixymon-live-alias";
    assert.throws(() => resolveDataDir(), /separate/);
  } finally {
    if (previous.action === undefined) delete process.env.ACTION_MODE; else process.env.ACTION_MODE = previous.action;
    if (previous.data === undefined) delete process.env.PIXYMON_DATA_DIR; else process.env.PIXYMON_DATA_DIR = previous.data;
    if (previous.live === undefined) delete process.env.PIXYMON_LIVE_DATA_DIR; else process.env.PIXYMON_LIVE_DATA_DIR = previous.live;
    if (previous.paper === undefined) delete process.env.PIXYMON_PAPER_DATA_DIR; else process.env.PIXYMON_PAPER_DATA_DIR = previous.paper;
  }
});
