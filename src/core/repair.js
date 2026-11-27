"use strict";
// Khôi phục file MP4 Sony XAVC bị mất chỉ mục (moov) hoặc mất phần đầu.
//
// Máy Sony ghi dữ liệu theo chu kỳ:
//   [metadata rtmd × N][N khung hình H.264/H.265][tiếng PCM của N khung]
// Công cụ đọc từng chu kỳ trong file hỏng, đo kích thước từng khung hình,
// rồi dựng lại chỉ mục (moov) theo mẫu chỉ mục của một file tốt quay cùng máy,
// cùng cài đặt. File hỏng chỉ được đọc, không bao giờ bị sửa.

const fs = require("fs");
const path = require("path");

const RTMD_SIG = Buffer.from([0x00, 0x1c, 0x01, 0x00]);
const RTMD_TAIL = Buffer.from([0x06, 0x0e, 0x2b, 0x34]);
const VIDEO = new Set(["avc1", "avc3", "hvc1", "hev1"]);
const AUDIO = new Set(["twos", "sowt", "lpcm", "in24", "in32"]);
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts"]);

class RepairError extends Error {}

// Đầu mỗi mẫu rtmd: byte 4-7 thay đổi theo chu kỳ, chỉ so các byte cố định.
function rtmdMatch(b, o = 0) {
  return b.length - o >= 32 &&
    b[o] === 0 && b[o + 1] === 0x1c && b[o + 2] === 1 && b[o + 3] === 0 &&
    b[o + 8] === 0xf0 && b[o + 9] === 0x01 &&
    b[o + 28] === 0x06 && b[o + 29] === 0x0e && b[o + 30] === 0x2b && b[o + 31] === 0x34;
}

// Đọc file có bộ đệm, vì quá trình quét đọc rất nhiều đoạn nhỏ liền nhau.
class Reader {
  constructor(file) {
    this.fd = fs.openSync(file, "r");
    this.size = fs.fstatSync(this.fd).size;
    this.win = Buffer.alloc(0);
    this.winPos = 0;
  }
  read(pos, n) {
    if (pos < 0 || pos >= this.size || n <= 0) return Buffer.alloc(0);
    n = Math.min(n, this.size - pos);
    if (pos >= this.winPos && pos + n <= this.winPos + this.win.length) {
      return this.win.subarray(pos - this.winPos, pos - this.winPos + n);
    }
    const len = Math.min(Math.max(n, 1 << 20), this.size - pos);
    const buf = Buffer.allocUnsafe(len);
    const got = fs.readSync(this.fd, buf, 0, len, pos);
    this.win = buf.subarray(0, got);
    this.winPos = pos;
    return this.win.subarray(0, Math.min(n, got));
  }
  readFresh(pos, n) {
    n = Math.max(0, Math.min(n, this.size - pos));
    const buf = Buffer.allocUnsafe(n);
    const got = n ? fs.readSync(this.fd, buf, 0, n, pos) : 0;
    return buf.subarray(0, got);
  }
  close() { fs.closeSync(this.fd); }
}

function* boxes(d, s, e) {
  while (s + 8 <= e) {
    let sz = d.readUInt32BE(s);
    const t = d.toString("latin1", s + 4, s + 8);
    let hl = 8;
    if (sz === 1) { sz = Number(d.readBigUInt64BE(s + 8)); hl = 16; }
    if (sz < 8) break;
    yield { t, o: s, z: sz, hl };
    s += sz;
  }
}

function findTop(reader, name) {
  let pos = 0;
  while (pos + 8 <= reader.size) {
    const h = reader.readFresh(pos, 16);
    let sz = h.readUInt32BE(0);
    const t = h.toString("latin1", 4, 8);
    let hl = 8;
    if (sz === 1) { sz = Number(h.readBigUInt64BE(8)); hl = 16; }
    else if (sz === 0) sz = reader.size - pos;
    if (t === name) return { o: pos, z: sz, hl };
    if (sz < 8) break;
    pos += sz;
  }
  return null;
}

// ---------- đọc file mẫu ----------
function readReference(file) {
  const r = new Reader(file);
  try {
    const m = findTop(r, "moov");
    const md = findTop(r, "mdat");
    if (!m || !md || m.o + m.z > r.size) throw new RepairError("File mẫu không có chỉ mục (moov) hoặc dữ liệu (mdat) nguyên vẹn.");
    const moov = Buffer.from(r.readFresh(m.o, m.z));
    const head = Buffer.from(r.readFresh(0, md.o));
    return { moov, head, dataStart: md.o + 16 };
  } finally { r.close(); }
}

function child(moov, o, z, name) {
  for (const b of boxes(moov, o + 8, o + z)) if (b.t === name) return b;
  return null;
}

function trackInfo(moov) {
  const tracks = [];
  for (const tr of boxes(moov, 8, moov.length)) {
    if (tr.t !== "trak") continue;
    const mdia = child(moov, tr.o, tr.z, "mdia");
    const minf = mdia && child(moov, mdia.o, mdia.z, "minf");
    const stbl = minf && child(moov, minf.o, minf.z, "stbl");
    if (!stbl) throw new RepairError("Chỉ mục file mẫu thiếu bảng mẫu (stbl).");
    const tabs = {};
    for (const b of boxes(moov, stbl.o + 8, stbl.o + stbl.z)) tabs[b.t] = b;
    const mdhd = child(moov, mdia.o, mdia.z, "mdhd");
    const v = moov[mdhd.o + 8];
    const timescale = moov.readUInt32BE(mdhd.o + (v ? 28 : 20));
    const codec = moov.toString("latin1", tabs.stsd.o + 20, tabs.stsd.o + 24);
    const spc = moov.readUInt32BE(tabs.stsc.o + 20);
    const fixed = moov.readUInt32BE(tabs.stsz.o + 12);
    const delta = moov.readUInt32BE(tabs.stts.o + 20);
    let ctts = null;
    if (tabs.ctts) {
      const s = tabs.ctts.o, n = moov.readUInt32BE(s + 12);
      ctts = [];
      for (let k = 0; k < n; k++) {
        const c = moov.readUInt32BE(s + 16 + 8 * k), off = moov.readUInt32BE(s + 20 + 8 * k);
        for (let i = 0; i < c; i++) ctts.push(off);
      }
    }
    tracks.push({ codec, spc, fixed, delta, ctts, timescale });
  }
  return tracks;
}

function pickTracks(tracks) {
  const vid = tracks.find(t => VIDEO.has(t.codec));
  const aud = tracks.find(t => AUDIO.has(t.codec));
  const rt = tracks.find(t => t.codec === "rtmd");
  if (!vid || !aud || !rt) {
    throw new RepairError("File mẫu không có đủ 3 track hình + tiếng PCM + metadata rtmd của Sony XAVC (" +
      tracks.map(t => t.codec).join(", ") + ").");
  }
  if (!aud.fixed || !rt.fixed) throw new RepairError("File mẫu có kích thước mẫu tiếng/metadata không cố định, chưa hỗ trợ.");
  return { vid, aud, rt };
}

// ---------- quét file hỏng ----------
function scan(broken, tracks, dataStart, opts = {}) {
  const { vid, aud, rt } = pickTracks(tracks);
  const FR = vid.spc, RT_LEN = rt.fixed * rt.spc, AU_LEN = aud.fixed * aud.spc;
  const log = opts.log || (() => {}), progress = opts.progress || (() => {});
  const r = new Reader(broken);
  const size = r.size;
  const isRtmd = p => p >= 0 && rtmdMatch(r.read(p, 32));
  const allFF = b => { for (let i = 0; i < b.length; i++) if (b[i] !== 0xff) return false; return true; };
  const allZero = b => { for (let i = 0; i < b.length; i++) if (b[i] !== 0) return false; return true; };

  // tìm đầu một cụm rtmd (mẫu rtmd đầu tiên của chu kỳ, không phải mẫu ở giữa cụm)
  const resync = from => {
    const B = 8 << 20;
    for (let pos = from; pos < size; pos += B) {
      const b = r.readFresh(pos, B + RTMD_SIG.length);
      let i = b.indexOf(RTMD_SIG);
      while (i >= 0) {
        const q = pos + i;
        if (isRtmd(q) && isRtmd(q + (rt.spc - 1) * rt.fixed) && !isRtmd(q - rt.fixed)) return q;
        i = b.indexOf(RTMD_SIG, i + 1);
      }
    }
    return null;
  };

  const chunks = []; // { rtmd, video, sizes[], idr[], audio }
  let pos = dataStart, skipped = 0, lastReport = 0;
  try {
    while (pos !== null && pos < size) {
      if (opts.maxChunks && chunks.length >= opts.maxChunks) break;
      if (!isRtmd(pos)) {
        const np = resync(pos + 1);
        if (np === null) break;
        skipped += np - pos;
        log(`Vùng hỏng: bỏ qua ${(np - pos) / 1e6 | 0} MB tại ${(pos / 1e9).toFixed(2)} GB`);
        pos = np;
        continue;
      }
      const v0 = pos + RT_LEN;
      let p = v0, ok = true, curStart = null, curIdr = false;
      const sizes = [], idr = [];
      for (;;) {
        const h = r.read(p, 5);
        if (h.length < 5) { ok = false; break; }
        const n = h.readUInt32BE(0), typ = h[4] & 0x1f;
        const valid = (h[4] & 0x80) === 0 && n > 0 && n < 50000000 && p + 4 + n <= size;
        if (sizes.length === FR - 1 && curStart !== null && p > curStart && isRtmd(p + AU_LEN)) {
          // khung cuối, không có đoạn đệm: tiếng PCM nằm ngay sau NAL cuối
          sizes.push(p - curStart); idr.push(curIdr);
          break;
        }
        if (valid && typ === 9) { // AUD = bắt đầu khung mới
          if (curStart !== null) { sizes.push(p - curStart); idr.push(curIdr); }
          curStart = p; curIdr = false;
        } else if (!valid || curStart === null) {
          if (sizes.length === FR - 1 && curStart !== null) {
            // khung cuối có đoạn đệm (số 0) rồi mới đến tiếng PCM:
            // điểm kết thúc = chu kỳ rtmd tiếp theo - độ dài tiếng
            const b = r.readFresh(p, 4 << 20);
            let i = b.indexOf(RTMD_SIG);
            while (i >= 0 && !rtmdMatch(b, i)) i = b.indexOf(RTMD_SIG, i + 1);
            const end = i >= 0 ? p + i - AU_LEN : -1;
            // giữa NAL cuối và tiếng chỉ được là đoạn đệm số 0; nếu không, chu kỳ sau đã bị hỏng
            if (i >= 0 && end >= p && allZero(b.subarray(0, end - p))) { sizes.push(end - curStart); idr.push(curIdr); break; }
          }
          ok = false; break;
        }
        if (typ === 5) curIdr = true;
        p += 4 + n;
      }
      if (!ok || sizes.length !== FR) {
        const np = resync(pos + 1);
        if (np === null) break;
        skipped += np - pos;
        log(`Chu kỳ lỗi tại ${(pos / 1e9).toFixed(2)} GB, bỏ qua ${((np - pos) / 1e6).toFixed(1)} MB`);
        pos = np;
        continue;
      }
      const a0 = v0 + sizes.reduce((a, b) => a + b, 0);
      if (a0 + AU_LEN > size) break;
      if (allFF(r.readFresh(a0, AU_LEN))) { // tiếng bị xóa trống: bỏ chu kỳ này, tìm chu kỳ tốt tiếp theo
        const np = resync(pos + 1);
        if (np === null) break;
        skipped += np - pos;
        log(`Tiếng bị xóa trống tại ${(pos / 1e9).toFixed(2)} GB, bỏ qua ${((np - pos) / 1e6).toFixed(1)} MB`);
        pos = np;
        continue;
      }
      chunks.push({ rtmd: pos, video: v0, sizes, idr, audio: a0 });
      pos = a0 + AU_LEN;
      if (pos - lastReport > 200e6) { lastReport = pos; progress(pos / size, chunks.length); }
      if (opts.shouldStop && opts.shouldStop()) throw new RepairError("Đã hủy.");
    }
  } finally { r.close(); }
  return { chunks, skipped, audioLen: AU_LEN };
}

// ---------- dựng chỉ mục mới ----------
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }
function box(t, body) { return Buffer.concat([u32(8 + body.length), Buffer.from(t, "latin1"), body]); }
function full(t, body) { return box(t, Buffer.concat([u32(0), body])); }
function u32arr(a) { const b = Buffer.alloc(4 * a.length); a.forEach((v, i) => b.writeUInt32BE(v >>> 0, 4 * i)); return b; }
function u64arr(a) { const b = Buffer.alloc(8 * a.length); a.forEach((v, i) => b.writeBigUInt64BE(BigInt(v), 8 * i)); return b; }

function buildMoov(moov, tracks, chunks, shift) {
  const n = chunks.length;
  const vidIdx = tracks.findIndex(t => VIDEO.has(t.codec));
  const vid = tracks[vidIdx];
  const nframes = n * vid.spc;
  const vsizes = chunks.flatMap(c => c.sizes);
  const vidr = chunks.flatMap(c => c.idr);
  let mvTs = 0;
  for (const b of boxes(moov, 8, moov.length)) if (b.t === "mvhd") mvTs = moov.readUInt32BE(b.o + (moov[b.o + 8] ? 28 : 20));
  const durS = nframes * vid.delta / vid.timescale;
  const movieDur = Math.trunc(durS * mvTs);
  let trakNo = -1;

  const setDur = (raw, off0, off1, value) => { // v0 → 32-bit tại off0, v1 → 64-bit tại off1
    const b = Buffer.from(raw);
    if (b[8]) b.writeBigUInt64BE(BigInt(value), off1); else b.writeUInt32BE(value >>> 0, off0);
    return b;
  };

  const rebuild = (s, e, ti) => {
    const out = [];
    for (const b of boxes(moov, s, e)) {
      const raw = moov.subarray(b.o, b.o + b.z);
      if (CONTAINERS.has(b.t)) {
        let t2 = ti;
        if (b.t === "trak") t2 = ++trakNo;
        out.push(box(b.t, rebuild(b.o + b.hl, b.o + b.z, t2)));
        continue;
      }
      const tr = ti >= 0 ? tracks[ti] : null;
      const cnt = tr ? n * tr.spc : 0;
      switch (b.t) {
        case "mvhd": out.push(setDur(raw, 24, 32, movieDur)); break;
        case "tkhd": out.push(setDur(raw, 28, 36, movieDur)); break;
        case "elst": out.push(setDur(raw, 16, 16, movieDur)); break;
        case "mdhd": out.push(setDur(raw, 24, 32, cnt * tr.delta)); break;
        case "stts": out.push(full("stts", u32arr([1, cnt, tr.delta]))); break;
        case "stsz":
          out.push(tr.fixed ? full("stsz", u32arr([tr.fixed, cnt]))
            : full("stsz", Buffer.concat([u32arr([0, vsizes.length]), u32arr(vsizes)])));
          break;
        case "stco": case "co64": {
          const key = tr.codec === "rtmd" ? "rtmd" : ti === vidIdx ? "video" : "audio";
          const offs = chunks.map(c => c[key] + shift);
          out.push(full("co64", Buffer.concat([u32(offs.length), u64arr(offs)])));
          break;
        }
        case "stss": {
          const ks = [];
          vidr.forEach((x, i) => { if (x) ks.push(i + 1); });
          out.push(full("stss", Buffer.concat([u32(ks.length), u32arr(ks)])));
          break;
        }
        case "ctts": {
          const pat = tr.ctts;
          let gop = pat.length;
          for (let g = 1; g < pat.length; g++) {
            let same = true;
            for (let k = 0; k < pat.length; k++) if (pat[k] !== pat[k % g]) { same = false; break; }
            if (same) { gop = g; break; }
          }
          const ent = [];
          let k = 0;
          for (const x of vidr) {
            if (x) k = 0;
            const v = pat[k % gop]; k++;
            if (ent.length && ent[ent.length - 1][1] === v) ent[ent.length - 1][0]++;
            else ent.push([1, v]);
          }
          out.push(full("ctts", Buffer.concat([u32(ent.length), u32arr(ent.flat())])));
          break;
        }
        default: out.push(Buffer.from(raw));
      }
    }
    return Buffer.concat(out);
  };
  return { moov: box("moov", rebuild(8, moov.length, -1)), durS, nframes };
}

// ---------- chương trình chính ----------
// opts: { log, progress(stage, fraction, text), shouldStop, maxChunks, dryRun }
function repair(refFile, brokenFile, outFile, opts = {}) {
  const log = opts.log || (() => {});
  const progress = opts.progress || (() => {});
  const res = (p) => path.resolve(p);
  if (!opts.dryRun) {
    if ([res(refFile), res(brokenFile)].includes(res(outFile))) throw new RepairError("File kết quả phải khác file gốc.");
    if (fs.existsSync(outFile)) throw new RepairError("File kết quả đã tồn tại, hãy chọn tên khác.");
  }

  progress("ref", 0, "Đọc file mẫu");
  const { moov, head, dataStart } = readReference(refFile);
  const tracks = trackInfo(moov);
  log(`File mẫu: track ${tracks.map(t => t.codec).join(", ")}, dữ liệu bắt đầu ở byte ${dataStart}`);

  progress("scan", 0, "Quét file hỏng");
  const { chunks, skipped, audioLen } = scan(brokenFile, tracks, dataStart, {
    log, maxChunks: opts.maxChunks, shouldStop: opts.shouldStop,
    progress: (f, n) => progress("scan", f, `Quét file hỏng: ${n} chu kỳ`)
  });
  if (!chunks.length) throw new RepairError("Không tìm thấy dữ liệu hợp lệ. File hỏng có thể không cùng máy/cài đặt với file mẫu.");
  const dataEnd = chunks[chunks.length - 1].audio + audioLen;
  const shift = head.length + 16 - dataStart; // vị trí mới = vị trí cũ + shift
  const { moov: newMoov, durS, nframes } = buildMoov(moov, tracks, chunks, shift);
  const summary = { chunks: chunks.length, frames: nframes, seconds: durS, skippedBytes: skipped, dataBytes: dataEnd - dataStart, outFile };
  log(`Tìm thấy ${chunks.length} chu kỳ = ${nframes} khung = ${(durS / 60).toFixed(1)} phút (bỏ qua ${(skipped / 1e6).toFixed(1)} MB dữ liệu hỏng)`);
  if (opts.dryRun) return Object.assign(summary, { moov: newMoov, head, dataStart, dataEnd });

  const total = dataEnd - dataStart;
  const need = head.length + 16 + total + newMoov.length;
  try {
    const st = fs.statfsSync(path.dirname(res(outFile)));
    const free = Number(st.bavail) * Number(st.bsize);
    if (free < need) throw new RepairError(`Ổ đĩa không đủ chỗ: cần ${(need / 1e9).toFixed(1)} GB, còn trống ${(free / 1e9).toFixed(1)} GB.`);
  } catch (e) { if (e instanceof RepairError) throw e; }

  const tmp = outFile + ".partial";
  const mdatHdr = Buffer.alloc(16);
  mdatHdr.writeUInt32BE(1, 0); mdatHdr.write("mdat", 4, "latin1"); mdatHdr.writeBigUInt64BE(BigInt(16 + total), 8);
  const fi = fs.openSync(brokenFile, "r");
  const fo = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fo, head); fs.writeSync(fo, mdatHdr);
    const B = 16 << 20, buf = Buffer.allocUnsafe(B);
    let done = 0, last = 0;
    const t0 = Date.now();
    while (done < total) {
      const want = Math.min(B, total - done);
      const got = fs.readSync(fi, buf, 0, want, dataStart + done);
      if (got <= 0) throw new RepairError("Đọc file hỏng thất bại giữa chừng.");
      fs.writeSync(fo, buf, 0, got);
      done += got;
      if (Date.now() - last > 300) {
        last = Date.now();
        const mbs = done / Math.max(0.001, (Date.now() - t0) / 1000) / 1e6;
        progress("write", done / total, `Ghi file mới: ${(done / 1e9).toFixed(2)}/${(total / 1e9).toFixed(2)} GB (${mbs | 0} MB/s)`);
        if (opts.shouldStop && opts.shouldStop()) throw new RepairError("Đã hủy.");
      }
    }
    fs.writeSync(fo, newMoov);
  } catch (e) {
    fs.closeSync(fo); fs.closeSync(fi);
    try { fs.unlinkSync(tmp); } catch (_) { /* bỏ qua */ }
    throw e;
  }
  fs.closeSync(fo); fs.closeSync(fi);
  fs.renameSync(tmp, outFile);
  progress("write", 1, "Xong");
  log(`Xong: ${outFile}`);
  return summary;
}

function defaultOutName(brokenFile) {
  const ext = path.extname(brokenFile);
  return path.join(path.dirname(brokenFile), path.basename(brokenFile, ext) + "_khoi_phuc" + (ext || ".MP4"));
}

module.exports = { repair, defaultOutName, RepairError, rtmdMatch, _internal: { readReference, trackInfo, scan, buildMoov } };
