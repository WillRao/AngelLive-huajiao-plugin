// 弹幕端到端验证：按宿主的 plugin_js_v1 驱动契约跑一遍
// getDanmaku → createDanmakuSession → 开 socket → onDanmakuOpen → onDanmakuFrame → onDanmakuTick
//
//   node dev/verify-danmaku.mjs            # 用当前在播的随机房间
//   node dev/verify-danmaku.mjs 350413218  # 指定房间号
//   HJ_VERBOSE=1 node dev/verify-danmaku.mjs   # 打印每次 WS 收发

import { installHost, loadPlugin, makeChecker } from "./host-shim.mjs";

const verbose = process.env.HJ_VERBOSE === "1";
const runSeconds = Number(process.env.HJ_DURATION || 30);

installHost({ verbose });
const { plugin, manifest } = loadPlugin();
const { check, summary } = makeChecker();

// ---- 找一个在播房间 ----
let roomId = process.argv[2];
if (!roomId) {
  const rooms = await plugin.getRooms({ parentBiz: "live", page: 1 });
  roomId = rooms[0] && rooms[0].roomId;
}
console.log(`房间号：${roomId}\n`);

// ---- 1. 弹幕计划 ----
console.log("== getDanmaku ==");
const plan = await plugin.getDanmaku({ roomId });
check("transport 为 websocket", plan.transport.kind === "websocket", plan.transport.url);
check("帧类型为 binary", plan.transport.frameType === "binary");
check("driver 为 plugin_js_v1", plan.runtime.driver === "plugin_js_v1", plan.runtime.protocolId);
check("capabilities.danmaku 已声明", manifest.capabilities.danmaku.status !== "undefined");

// ---- 2. 按宿主契约驱动 ----
console.log("\n== 驱动会话 ==");
const connectionId = "conn-" + Math.random().toString(36).slice(2);
const session = await plugin.createDanmakuSession({
  connectionId,
  roomId: plan.args.roomId,
  args: plan.args,
  headers: plan.headers,
  transport: plan.transport
});
check("createDanmakuSession 返回 ok", session.ok === true, JSON.stringify(session.timer));

const socket = await Host.ws.open({
  url: plan.transport.url,
  headers: plan.headers || {},
  timeoutMs: 15000
});

const received = [];
let opened = false;
let joinConfirmed = false;
let heartbeatTimer = null;

function applyTimer(timer) {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (timer && timer.mode === "heartbeat" && timer.intervalMs) {
    heartbeatTimer = setInterval(async () => {
      const tick = await plugin.onDanmakuTick({ connectionId, reason: "heartbeat" });
      for (const write of tick.writes || []) await socket.send(write);
      applyTimer(tick.timer);
    }, timer.intervalMs);
  }
}

socket.onMessage(async (event) => {
  if (event.type === "open") {
    opened = true;
    const result = await plugin.onDanmakuOpen({ connectionId, roomId, args: plan.args });
    for (const write of result.writes || []) await socket.send(write);
    applyTimer(result.timer);
    return;
  }
  if (event.type === "error") {
    check("传输层无错误", false, event.message);
    return;
  }
  if (event.type === "closed") {
    return;
  }

  const result = await plugin.onDanmakuFrame({
    connectionId,
    frameType: event.type,
    bytesBase64: event.bytesBase64,
    text: event.text,
    roomId
  });
  for (const write of result.writes || []) await socket.send(write);
  for (const message of result.messages || []) {
    received.push(message);
    console.log(`  💬 [${message.nickname}] ${message.text}`);
  }
  // 进房确认后 stage 会推进到 live，timer 变成 heartbeat
  if (result.timer && result.timer.mode === "heartbeat" && !joinConfirmed) {
    joinConfirmed = true;
    console.log("  —— 已进房，开始接收弹幕 ——");
  }
  applyTimer(result.timer);
});

await new Promise((resolve) => setTimeout(resolve, runSeconds * 1000));

check("WebSocket 已建立", opened);
check("握手/登录/进房完成", joinConfirmed, "收到进房响应后开始心跳");
check("收到弹幕消息", received.length > 0, `${received.length} 条`);
if (received.length > 0) {
  const sample = received[0];
  check("弹幕含 nickname", !!sample.nickname, sample.nickname);
  check("弹幕含 text", !!sample.text, sample.text.slice(0, 40));
}

if (heartbeatTimer) clearInterval(heartbeatTimer);
await socket.close();
await plugin.destroyDanmakuSession({ connectionId });

process.exit(summary() ? 1 : 0);
