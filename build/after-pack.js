"use strict";
// Ký ad-hoc cho app macOS sau khi đóng gói.
// Mac chip Apple từ chối chạy app không có chữ ký nào. Ký ad-hoc không cần chứng chỉ Apple trả phí,
// đủ để app chạy được; lần đầu mở vẫn cần cho phép trong System Settings → Privacy & Security.
const { execFileSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ký ad-hoc ${app}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], { stdio: "inherit" });
};
