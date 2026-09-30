// 录制弹幕夹具：把真实 WS 报文按顺序存下来，供 verify-parser.mjs 离线回放。
//
//   node dev/capture-fixture.mjs 350413328 90
//
// 会写入 dev/fixtures/danmaku-frames.json，覆盖旧夹具。
// 挑一个「说话人多」的房间录，否则抓不到 type=9 的文本聊天。

import { installHost, loadPlugin, pluginRoot } from "./host-shim.mjs";
import { chatTextsInFrame } from "./json-scan.mjs";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const roomId = process.argv[2];
if (!roomId) {
  console.error("用法：node dev/capture-fixture.mjs <房间号> [秒数]");
  console.error("房间号可从花椒房间链接取：https://h.huajiao.com/l/index?liveid=350413328");
  process.exit(1);
}
const seconds = Number(process.argv[3] || 90);

installHost({ verbose: false });
const { plugin } = loadPlugin();

const frames = [];
const chatTexts = new Set();

const plan = await plugin.getDanmaku({ roomId });
const connectionId = "cap-" + Math.random().toString(36).slice(2);
await plugin.createDanmakuSession({
  connectionId,
  roomId: plan.args.roomId,
  args: plan.args,
  headers: plan.headers,
  transport: plan.transport
});

const socket = await Host.ws.open({ url: plan.transport.url, headers: plan.headers || {}, timeoutMs: 15000 });

// 登录响应是用「本次会话的 secret」做 RC4 的，回放时必须用同一个密钥才解得开，
// 所以把它一起存进夹具。驱动脚本是全局 eval 的，__lp_hj_dmk_sessions 可直接读到。
const capturedSecret = globalThis.__lp_hj_dmk_sessions
  ? globalThis.__lp_hj_dmk_sessions[connectionId].secret
  : null;
console.log("捕获 secret:", capturedSecret ? capturedSecret.slice(0, 12) + "…" : "(取不到)");

let heartbeatTimer = null;
function applyTimer(timer) {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (timer && timer.mode === "heartbeat" && timer.intervalMs) {
    heartbeatTimer = setInterval(async () => {
      const tick = await plugin.onDanmakuTick({ connectionId, reason: "heartbeat" });
      for (const w of tick.writes || []) await socket.send(w);
      applyTimer(tick.timer);
    }, timer.intervalMs);
  }
}

let opened = false;
socket.onMessage(async (event) => {
  if (event.type === "open") {
    opened = true;
    const r = await plugin.onDanmakuOpen({ connectionId, roomId, args: plan.args });
    for (const w of r.writes || []) await socket.send(w);
    applyTimer(r.timer);
    return;
  }
  if (event.type !== "binary") return;

  // 关键：先录帧，再把帧喂回驱动，否则状态机停在握手阶段、后续帧根本不会来。
  frames.push({ frameType: "binary", bytesBase64: event.bytesBase64 });
  for (const text of chatTextsInFrame(event.bytesBase64)) chatTexts.add(text);

  try {
    const result = await plugin.onDanmakuFrame({
      connectionId,
      frameType: "binary",
      bytesBase64: event.bytesBase64,
      roomId
    });
    for (const w of result.writes || []) await socket.send(w);
    applyTimer(result.timer);
  } catch (error) {
    console.log("  [驱动异常]", error.message);
  }
});

console.log(`开始录制 ${seconds}s …`);
await new Promise((r) => setTimeout(r, seconds * 1000));
if (heartbeatTimer) clearInterval(heartbeatTimer);
try { await socket.close(); } catch (e) {}
await plugin.destroyDanmakuSession({ connectionId });

const outDir = join(pluginRoot, "dev", "fixtures");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "danmaku-frames.json");
writeFileSync(
  outPath,
  JSON.stringify(
    {
      note: "真实抓包：从握手响应开始的全部入站帧。按顺序 replay 给驱动状态机即可复现完整会话（写入方向被丢弃）。",
      roomId,
      capturedAt: new Date().toISOString(),
      secret: capturedSecret,
      secretNote: "登录响应按此密钥 RC4。回放前把它写回会话，否则登录帧解不开（握手用的是固定 key，不受影响）。",
      frameCount: frames.length,
      expectedChatTexts: Array.from(chatTexts),
      frames
    },
    null,
    2
  )
);

console.log(`\nopened=${opened} | 帧数=${frames.length} | 文本弹幕=${chatTexts.size}`);
console.log("已写入", outPath);
if (chatTexts.size === 0) {
  console.log("\n⚠️  这个房间这段时间没有文本聊天（type=9）。夹具仍可用，但覆盖不到文本弹幕路径。");
  console.log("   换一个说话人多的房间重录。");
} else {
  console.log("样本:");
  for (const t of Array.from(chatTexts).slice(0, 6)) console.log("   " + t);
}
process.exit(0);
