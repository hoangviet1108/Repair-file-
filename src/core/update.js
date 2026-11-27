"use strict";
// Kiểm tra phiên bản mới trên GitHub Releases. Chỉ gợi ý và mở trang tải về,
// không tự cài (app chưa ký số bằng chứng chỉ Apple/Microsoft nên không tự cập nhật được).

function parseVersion(v) {
  const m = String(v || "").trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  return m ? { nums: [+m[1], +m[2], +m[3]], pre: m[4] || "" } : null;
}

// > 0 nếu a mới hơn b
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i] - y.nums[i];
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;   // 1.2.0 mới hơn 1.2.0-beta
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

function repoSlug(pkg) {
  const url = (pkg.repository && (pkg.repository.url || pkg.repository)) || pkg.homepage || "";
  const m = String(url).match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?]|$)/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

// Chọn file cài đặt hợp với máy đang chạy
function pickAsset(assets, platform, arch) {
  const names = (assets || []).map(a => ({ name: a.name, url: a.browser_download_url, size: a.size }));
  const find = re => names.find(a => re.test(a.name));
  if (platform === "darwin") return find(new RegExp(`mac-${arch === "arm64" ? "arm64" : "x64"}\\.dmg$`, "i")) || find(/mac.*\.dmg$/i);
  if (platform === "win32") return find(/win-x64\.exe$/i) || find(/\.exe$/i);
  return null;
}

// fetchJson(url) -> Promise<object>; trả về thông tin cập nhật hoặc ném lỗi
async function checkForUpdate({ currentVersion, slug, platform, arch, fetchJson }) {
  if (!slug) throw new Error("Không xác định được repository GitHub của app.");
  const rel = await fetchJson(`https://api.github.com/repos/${slug}/releases/latest`);
  if (!rel || !rel.tag_name) throw new Error("GitHub không trả về thông tin phiên bản.");
  const latest = String(rel.tag_name).replace(/^v/i, "");
  const asset = pickAsset(rel.assets, platform, arch);
  const pageOk = typeof rel.html_url === "string" && rel.html_url.startsWith(`https://github.com/${slug}/`);
  return {
    current: currentVersion,
    latest,
    newer: compareVersions(latest, currentVersion) > 0,
    name: rel.name || `v${latest}`,
    publishedAt: rel.published_at || null,
    notes: typeof rel.body === "string" ? rel.body.slice(0, 4000) : "",
    pageUrl: pageOk ? rel.html_url : `https://github.com/${slug}/releases/latest`,
    download: asset && asset.url && asset.url.startsWith(`https://github.com/${slug}/`) ? asset : null
  };
}

const DAY = 24 * 3600 * 1000;
// Có nên tự kiểm tra khi mở app không (tối đa 1 lần / ngày, có thể tắt)
function shouldAutoCheck(settings, now = Date.now()) {
  if (settings && settings.autoCheck === false) return false;
  return !(settings && settings.lastCheck && now - settings.lastCheck < DAY);
}

module.exports = { parseVersion, compareVersions, repoSlug, pickAsset, checkForUpdate, shouldAutoCheck };
