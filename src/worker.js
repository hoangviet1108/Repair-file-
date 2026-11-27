"use strict";
// Chạy việc nặng (đọc file hàng chục GB) ngoài luồng giao diện.
const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const Analyzer = require("./core/analyzer.js");
const { repair, RepairError } = require("./core/repair.js");

const send = (m) => parentPort.postMessage(m);

function throttle(ms, fn) {
  let last = 0;
  return (f, ...rest) => { const now = Date.now(); if (now - last >= ms || f >= 1) { last = now; fn(f, ...rest); } };
}

async function check({ file, full }) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const src = {
      size, name: path.basename(file),
      read: async (o, n) => {
        n = Math.max(0, Math.min(n, size - o));
        const b = Buffer.allocUnsafe(n);
        const got = n ? fs.readSync(fd, b, 0, n, o) : 0;
        return new Uint8Array(b.buffer, b.byteOffset, got);
      }
    };
    const r = await Analyzer.analyze(src, {
      full: !!full, cells: 160,
      progress: throttle(100, (f, label) => send({ type: "progress", f, label }))
    });
    r.path = file;
    return r;
  } finally { fs.closeSync(fd); }
}

function runRepair({ ref, broken, out }) {
  const weight = { ref: [0, 0.01], scan: [0.01, 0.39], write: [0.4, 0.6] };
  const prog = throttle(150, (f, stage, text) => {
    const [a, b] = weight[stage] || [0, 1];
    send({ type: "progress", f: a + b * f, label: text });
  });
  return repair(ref, broken, out, {
    log: (text) => send({ type: "log", text }),
    progress: (stage, f, text) => prog(f, stage, text)
  });
}

(async () => {
  try {
    const result = workerData.type === "check" ? await check(workerData) : runRepair(workerData);
    send({ type: "done", result });
  } catch (e) {
    send({ type: "error", message: e instanceof RepairError ? e.message : String((e && e.message) || e) });
  }
})();
