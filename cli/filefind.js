#!/usr/bin/env node
"use strict";
// Dòng lệnh: kiểm tra / khôi phục file video mà không cần mở app.
//   node cli/filefind.js check FILE... [--full] [--json]
//   node cli/filefind.js repair FILE_MAU FILE_HONG [FILE_KET_QUA] [--dry-run] [--dump-moov FILE] [--max-chunks N]
const fs = require("fs");
const Analyzer = require("../src/core/analyzer.js");
const { repair, defaultOutName, RepairError } = require("../src/core/repair.js");

const HELP = `Cách dùng:
  filefind check FILE... [--full] [--json]
      Kiểm tra file MP4/MOV: chỉ mục, đoạn xem được, vùng byte trống.
      --full  quét từng byte (chậm hơn, chính xác hơn)

  filefind repair FILE_MAU FILE_HONG [FILE_KET_QUA] [--dry-run] [--max-chunks N]
      Dựng lại chỉ mục cho file Sony XAVC bị mất chỉ mục.
      FILE_MAU: file tốt quay cùng máy, cùng cài đặt. FILE_HONG chỉ được đọc.
      --dry-run  chỉ quét và báo kết quả, không ghi file`;

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  process.argv.splice(i, 2);
  return v;
}
function flag(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return false;
  process.argv.splice(i, 1);
  return true;
}

async function check(files, full, json) {
  let worst = 0;
  for (const file of files) {
    const fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const src = {
      size, name: file,
      read: async (o, n) => {
        n = Math.max(0, Math.min(n, size - o));
        const b = Buffer.allocUnsafe(n);
        const got = n ? fs.readSync(fd, b, 0, n, o) : 0;
        return new Uint8Array(b.buffer, b.byteOffset, got);
      }
    };
    const r = await Analyzer.analyze(src, { full });
    fs.closeSync(fd);
    worst = Math.max(worst, r.level || 0);
    if (json) { console.log(JSON.stringify(r)); continue; }
    const { fmtB, fmtT, pct } = Analyzer;
    console.log(`\n== ${file} (${fmtB(r.size)})`);
    console.log(`Kết luận: ${r.level ? "HỎNG" : "TỐT"}`);
    if (r.duration) console.log(`Thời lượng: ${fmtT(r.duration)}, xem được: ${fmtT(r.playable || 0)}`);
    console.log(`Dữ liệu thật: ${pct(r.dataPct)}, byte trống: ${pct(r.ffPct + r.zeroPct)} (${full ? "quét kỹ" : "quét nhanh"})`);
    for (const s of r.segments || []) console.log(`  ${fmtT(s.t0)}–${fmtT(s.t1)} ${s.state}`);
    if (r.meta) console.log(`Máy quay: ${r.meta.model} ${r.meta.serial || ""}, quay lúc ${r.meta.created}`);
    for (const i of r.issues) console.log(`Lỗi: ${i.t}`);
    for (const n of r.notes) console.log(`Nên làm: ${n}`);
  }
  return worst ? 1 : 0;
}

async function main() {
  const full = flag("--full"), json = flag("--json"), dry = flag("--dry-run");
  const dump = arg("--dump-moov"), maxChunks = arg("--max-chunks");
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "check" && rest.length) return check(rest, full, json);
  if (cmd === "repair" && rest.length >= 2) {
    const [ref, broken, out = defaultOutName(rest[1])] = rest;
    let last = "";
    const r = repair(ref, broken, out, {
      dryRun: dry || !!dump, maxChunks: maxChunks ? +maxChunks : undefined,
      log: s => console.log(s),
      progress: (stage, f, text) => { if (text !== last && process.stdout.isTTY) { process.stdout.write(`\r${text}          `); last = text; } }
    });
    if (process.stdout.isTTY) process.stdout.write("\n");
    if (dump) fs.writeFileSync(dump, Buffer.concat([r.head, r.moov]));
    console.log(`Kết quả: ${r.chunks} chu kỳ, ${r.frames} khung, ${(r.seconds / 60).toFixed(1)} phút` + (dry || dump ? " (chạy thử, không ghi file)" : ` → ${out}`));
    return 0;
  }
  console.log(HELP);
  return 2;
}

main().then(code => { process.exitCode = code; }, e => {
  console.error(e instanceof RepairError ? `Lỗi: ${e.message}` : e);
  process.exitCode = 1;
});
