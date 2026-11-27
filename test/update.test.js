"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const u = require("../src/core/update.js");

const SLUG = "vietcong69/Repair-file-";
const REL = {
  tag_name: "v1.2.0", name: "Video Check v1.2.0", html_url: `https://github.com/${SLUG}/releases/tag/v1.2.0`, body: "ghi chú",
  assets: ["mac-arm64.dmg", "mac-arm64.zip", "mac-x64.dmg", "win-x64.exe", "portable.exe"].map(s => ({
    name: `Video-Check-1.2.0-${s}`, size: 1000, browser_download_url: `https://github.com/${SLUG}/releases/download/v1.2.0/Video-Check-1.2.0-${s}`
  }))
};

test("so sánh phiên bản", () => {
  assert.ok(u.compareVersions("1.0.10", "1.0.9") > 0);
  assert.ok(u.compareVersions("v2.0.0", "1.9.9") > 0);
  assert.equal(u.compareVersions("1.0.1", "v1.0.1"), 0);
  assert.ok(u.compareVersions("1.2.0", "1.2.0-beta.1") > 0);
  assert.ok(u.compareVersions("1.0.0", "1.0.1") < 0);
});

test("đọc repository từ package.json", () => {
  assert.equal(u.repoSlug({ repository: { url: `git+https://github.com/${SLUG}.git` } }), SLUG);
  assert.equal(u.repoSlug({ homepage: `https://github.com/${SLUG}` }), SLUG);
  assert.equal(u.repoSlug({}), null);
});

test("chọn đúng file cài cho từng máy", () => {
  assert.match(u.pickAsset(REL.assets, "darwin", "arm64").name, /mac-arm64\.dmg$/);
  assert.match(u.pickAsset(REL.assets, "darwin", "x64").name, /mac-x64\.dmg$/);
  assert.match(u.pickAsset(REL.assets, "win32", "x64").name, /win-x64\.exe$/);
  assert.equal(u.pickAsset(REL.assets, "linux", "x64"), null);
});

test("báo có bản mới và chỉ tin đường dẫn của repository", async () => {
  const info = await u.checkForUpdate({ currentVersion: "1.0.1", slug: SLUG, platform: "darwin", arch: "arm64", fetchJson: async () => REL });
  assert.equal(info.newer, true);
  assert.equal(info.latest, "1.2.0");
  assert.match(info.download.url, /mac-arm64\.dmg$/);
  const evil = Object.assign({}, REL, { html_url: "https://evil.example/x", assets: [{ name: "Video-Check-1.2.0-mac-arm64.dmg", browser_download_url: "https://evil.example/a.dmg" }] });
  const info2 = await u.checkForUpdate({ currentVersion: "1.0.1", slug: SLUG, platform: "darwin", arch: "arm64", fetchJson: async () => evil });
  assert.equal(info2.download, null);
  assert.equal(info2.pageUrl, `https://github.com/${SLUG}/releases/latest`);
});

test("không báo khi đang dùng bản mới nhất", async () => {
  const info = await u.checkForUpdate({ currentVersion: "1.2.0", slug: SLUG, platform: "win32", arch: "x64", fetchJson: async () => REL });
  assert.equal(info.newer, false);
});

test("tự kiểm tra tối đa 1 lần/ngày và tắt được", () => {
  const now = Date.now();
  assert.equal(u.shouldAutoCheck({}, now), true);
  assert.equal(u.shouldAutoCheck({ lastCheck: now - 3600e3 }, now), false);
  assert.equal(u.shouldAutoCheck({ lastCheck: now - 25 * 3600e3 }, now), true);
  assert.equal(u.shouldAutoCheck({ autoCheck: false }, now), false);
});
