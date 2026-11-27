"use strict";
// Tạo file giả lập có cấu trúc giống Sony XAVC để kiểm thử (không cần file quay thật).
// Mỗi chu kỳ: [rtmd × FR][FR khung hình H.264 giả][(đệm 0)][tiếng PCM]
const fs = require("fs");
const os = require("os");
const path = require("path");

const FR = 3;              // khung hình mỗi chu kỳ
const RT_FIXED = 64;       // byte mỗi mẫu rtmd
const AU_SPC = 5760;       // mẫu tiếng mỗi chu kỳ (0,12 s × 48 kHz)
const AU_FIXED = 4;        // 16-bit stereo
const AU_LEN = AU_SPC * AU_FIXED;

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const box = (t, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(t, "latin1"), body]); };
const fbox = (t, ...parts) => box(t, u32(0), ...parts);

function rng(seed) { let s = seed; return () => (s = s * 16807 % 2147483647) / 2147483647; }

function rtmdSample(i) {
  const b = Buffer.alloc(RT_FIXED, 0x22);
  b.set([0x00, 0x1c, 0x01, 0x00], 0);
  b.writeUInt32BE(0x4a4329a1 + (i % 7), 4); // byte 4-7 thay đổi như máy thật
  b.set([0xf0, 0x01, 0x00, 0x10], 8);
  b.set([0x06, 0x0e, 0x2b, 0x34], 28);
  return b;
}
function nal(type, len, fill) { const b = Buffer.alloc(4 + len, fill); b.writeUInt32BE(len, 0); b[4] = type; return b; }

// Trả về { data, chunks: [{rtmd, video, sizes, idr, audio}] } với offset tính từ base
function makeStream(nChunks, base, seed = 7) {
  const rand = rng(seed), parts = [], chunks = [];
  let pos = base;
  for (let c = 0; c < nChunks; c++) {
    const rt = Buffer.concat(Array.from({ length: FR }, (_, i) => rtmdSample(c * FR + i)));
    const ch = { rtmd: pos, video: pos + rt.length, sizes: [], idr: [] };
    parts.push(rt); pos += rt.length;
    for (let f = 0; f < FR; f++) {
      const isIdr = f === 0 && c % 2 === 0;
      const fr = Buffer.concat([nal(0x09, 2, 0xf0), nal(0x06, 12, 0x05), nal(isIdr ? 0x65 : 0x41, 800 + Math.floor(rand() * 3000), 0x55), nal(isIdr ? 0x65 : 0x41, 500 + Math.floor(rand() * 900), 0x5a)]);
      let frame = fr;
      if (f === FR - 1 && c % 3 === 1) frame = Buffer.concat([fr, Buffer.alloc(300)]); // đoạn đệm số 0 như máy Sony
      ch.sizes.push(frame.length); ch.idr.push(isIdr);
      parts.push(frame); pos += frame.length;
    }
    ch.audio = pos;
    parts.push(Buffer.alloc(AU_LEN, 0x11)); pos += AU_LEN;
    chunks.push(ch);
  }
  return { data: Buffer.concat(parts), chunks };
}

function moovFor(chunks) {
  const n = chunks.length, frames = n * FR, mvTs = 90000;
  const dur = Math.trunc(frames * 1000 / 25000 * mvTs);
  const mvhd = fbox("mvhd", u32(0), u32(0), u32(mvTs), u32(dur), u32(0x10000), u16(0x100), Buffer.alloc(10), Buffer.alloc(36), Buffer.alloc(24), u32(4));
  const trak = (id, kind, ts, delta, stsd, spc, stszBody, offs, extra = []) => box("trak",
    fbox("tkhd", u32(0), u32(0), u32(id), u32(0), u32(dur), Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(36), u32(kind === "vide" ? 3840 << 16 : 0), u32(kind === "vide" ? 2160 << 16 : 0)),
    box("edts", fbox("elst", u32(1), u32(dur), u32(0), u32(0x10000))),
    box("mdia",
      fbox("mdhd", u32(0), u32(0), u32(ts), u32(n * spc * delta), u32(0)),
      fbox("hdlr", u32(0), Buffer.from(kind, "latin1"), Buffer.alloc(12), Buffer.alloc(1)),
      box("minf", box("stbl",
        fbox("stsd", u32(1), stsd),
        fbox("stts", u32(1), u32(n * spc), u32(delta)),
        ...extra,
        fbox("stsc", u32(1), u32(1), u32(spc), u32(1)),
        fbox("stsz", stszBody),
        fbox("co64", u32(offs.length), ...offs.map(u64))))));
  const vEntry = box("avc1", Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(3840), u16(2160), u32(0x480000), u32(0x480000), u32(0), u16(1), Buffer.alloc(32), u16(24), u16(0xffff));
  const aEntry = box("twos", Buffer.alloc(6), u16(1), u16(0), u16(0), u32(0), u16(2), u16(16), u16(0), u16(0), u32(48000 << 16));
  const rEntry = box("rtmd", Buffer.alloc(6), u16(1));
  const sizes = chunks.flatMap(c => c.sizes), idr = chunks.flatMap(c => c.idr);
  const keys = []; idr.forEach((x, i) => { if (x) keys.push(i + 1); });
  const pat = [2000, 0, 0];
  const ctts = fbox("ctts", u32(frames), ...Array.from({ length: frames }, (_, i) => Buffer.concat([u32(1), u32(pat[i % 3])])));
  return box("moov", mvhd,
    trak(1, "vide", 25000, 1000, vEntry, FR, Buffer.concat([u32(0), u32(frames), ...sizes.map(u32)]), chunks.map(c => c.video),
      [ctts, fbox("stss", u32(keys.length), ...keys.map(u32))]),
    trak(2, "soun", 48000, 1, aEntry, AU_SPC, Buffer.concat([u32(AU_FIXED), u32(n * AU_SPC)]), chunks.map(c => c.audio)),
    trak(3, "meta", 25000, 1000, rEntry, FR, Buffer.concat([u32(RT_FIXED), u32(frames)]), chunks.map(c => c.rtmd)));
}

const HEAD = Buffer.concat([box("ftyp", Buffer.from("XAVC", "latin1"), u32(0x010b1fff), Buffer.from("XAVCmp42iso6", "latin1")), box("free", Buffer.alloc(980))]);
const DATA_START = HEAD.length + 16;

function mdatHeader(len) { return Buffer.concat([u32(1), Buffer.from("mdat", "latin1"), u64(16 + len)]); }

// File tốt có chỉ mục
function goodFile(nChunks, seed) {
  const s = makeStream(nChunks, DATA_START, seed);
  return { buf: Buffer.concat([HEAD, mdatHeader(s.data.length), s.data, moovFor(s.chunks)]), chunks: s.chunks };
}

// File hỏng: mất phần đầu (FF), mất chỉ mục ở cuối (FF), một chu kỳ ở giữa bị xóa trống
function brokenFile(nChunks, seed, destroy = []) {
  const s = makeStream(nChunks, DATA_START, seed);
  const buf = Buffer.concat([Buffer.alloc(DATA_START, 0xff), s.data, Buffer.alloc(200000, 0xff)]);
  for (const k of destroy) {
    const c = s.chunks[k], end = c.audio + AU_LEN;
    buf.fill(0xff, c.rtmd, end);
  }
  return { buf, chunks: s.chunks.filter((_, i) => !destroy.includes(i)) };
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "video-check-test-")); }

module.exports = { goodFile, brokenFile, tmpDir, FR, AU_LEN, DATA_START };
