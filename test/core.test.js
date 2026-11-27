"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Analyzer = require("../src/core/analyzer.js");
const { repair, RepairError, _internal } = require("../src/core/repair.js");
const { goodFile, brokenFile, tmpDir, FR } = require("./fixtures.js");

function srcOf(file) {
  const buf = fs.readFileSync(file);
  return { size: buf.length, name: path.basename(file), read: async (o, n) => new Uint8Array(buf.buffer, buf.byteOffset + o, Math.max(0, Math.min(n, buf.length - o))) };
}

const dir = tmpDir();
const REF = path.join(dir, "mau.MP4"), BROKEN = path.join(dir, "hong.MP4");
const ref = goodFile(10, 3);
const broken = brokenFile(40, 11, [17]);
// Chu kỳ 16 đứng ngay trước chu kỳ bị xóa và chu kỳ cuối cùng của file không có chu kỳ sau
// để xác định điểm kết thúc, nên cả hai bị bỏ (mỗi chu kỳ ≈ 0,5 giây ở file thật).
const kept = broken.chunks.filter((_, i) => i !== 16 && i !== broken.chunks.length - 1);
fs.writeFileSync(REF, ref.buf);
fs.writeFileSync(BROKEN, broken.buf);
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("kiểm tra: file tốt được báo là tốt", async () => {
  const r = await Analyzer.analyze(srcOf(REF), { full: true });
  assert.equal(r.level, 0, JSON.stringify(r.issues));
  assert.equal(r.tracks[0].w, 3840);
  assert.equal(r.badChunks, 0);
  assert.equal(r.segments.length, 1);
  assert.ok(Math.abs(r.duration - 10 * FR / 25) < 1e-6);
});

test("kiểm tra: file mất chỉ mục được nhận ra và gợi ý khôi phục", async () => {
  const r = await Analyzer.analyze(srcOf(BROKEN), {});
  assert.equal(r.level, 3);
  assert.ok(r.issues.some(i => /chỉ mục/.test(i.t)));
  assert.ok(r.issues.some(i => /Phần đầu file/.test(i.t)));
  assert.equal(r.sonyData, true);
});

test("kiểm tra: vùng dữ liệu bị xóa trống hiện đúng trên dòng thời gian", async () => {
  const g = goodFile(20, 5);
  const c = g.chunks[8];
  g.buf.fill(0xff, c.video, c.audio);
  const f = path.join(dir, "trong.MP4");
  fs.writeFileSync(f, g.buf);
  const r = await Analyzer.analyze(srcOf(f), { full: true });
  assert.equal(r.badChunks, 1);
  const blank = r.segments.find(s => s.state === "blank");
  assert.ok(blank && Math.abs(blank.t0 - 8 * FR / 25) < 1e-6);
});

test("khôi phục: đo đúng kích thước từng khung, bỏ qua chu kỳ bị xóa", () => {
  const { readReference, trackInfo, scan } = _internal;
  const { moov, dataStart } = readReference(REF);
  const res = scan(BROKEN, trackInfo(moov), dataStart);
  assert.equal(res.chunks.length, kept.length);
  res.chunks.forEach((c, i) => {
    assert.deepEqual(c.sizes, kept[i].sizes, `chu kỳ ${i}`);
    assert.equal(c.video, kept[i].video);
    assert.equal(c.audio, kept[i].audio);
  });
});

test("khôi phục: file mới phát được và kiểm tra là tốt", async () => {
  const out = path.join(dir, "ket_qua.MP4");
  const sum = repair(REF, BROKEN, out);
  assert.equal(sum.chunks, kept.length);
  assert.equal(sum.frames, kept.length * FR);
  const r = await Analyzer.analyze(srcOf(out), { full: true });
  assert.equal(r.badChunks, 0, JSON.stringify(r.issues));
  assert.ok(Math.abs(r.duration - kept.length * FR / 25) < 1e-6);
  // file hỏng không bị thay đổi
  assert.ok(fs.readFileSync(BROKEN).equals(broken.buf));
});

test("khôi phục: không ghi đè file có sẵn hoặc file gốc", () => {
  assert.throws(() => repair(REF, BROKEN, BROKEN), RepairError);
  assert.throws(() => repair(REF, BROKEN, REF), RepairError);
});

test("khôi phục: báo lỗi rõ ràng khi file mẫu không phải Sony XAVC", () => {
  const f = path.join(dir, "khong_phai.MP4");
  fs.writeFileSync(f, Buffer.alloc(1000, 0x41));
  assert.throws(() => repair(f, BROKEN, path.join(dir, "x.MP4")), RepairError);
});
