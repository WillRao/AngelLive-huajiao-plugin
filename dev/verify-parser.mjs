// 离线段解析回归测试：把 dev/fixtures/danmaku-frames.json 里的真实报文
// 按顺序回放给驱动状态机，验证解析链没有退化。
//
//   node dev/verify-parser.mjs
//
// 为什么需要它：解析层的 bug 是「静默」的 —— 比如把 JSON 取值误用成 protobuf
// 字段读取器时，不会抛错，只会一条消息都不产出。只有夹具回放能守住这条线。
// 也正因为不需要联网，它可以在没有可用直播间时随时跑。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { installHost, loadPlugin, makeChecker } from "./host-shim.mjs";
import { collectChatTexts } from "./json-scan.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures", "danmaku-frames.json");

installHost({ verbose: false });
const { plugin, manifest } = loadPlugin();
const { check, summary } = makeChecker();

let fixture;
try {
  fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
} catch (error) {
  console.log(`❌ 读不到夹具 ${fixturePath}：${error.message}`);
  console.log("   重新录制：见 README 的「录制夹具」一节。");
  process.exit(1);
}

console.log(`夹具：room ${fixture.roomId}，${fixture.frameCount} 帧，录于 ${fixture.capturedAt}`);
check("夹具含帧", Array.isArray(fixture.frames) && fixture.frames.length > 0, `${fixture.frames ? fixture.frames.length : 0} 帧`);

// ---- 独立 oracle：用 json-scan 从同一批帧里算出「应有的文本弹幕」----
const expected = collectChatTexts(fixture.frames);
console.log(`独立扫描出的文本弹幕：${expected.size} 条`);
check("夹具含至少 1 条文本弹幕", expected.size > 0, `${expected.size} 条`);

// danmaku.js 的驱动必须在 preload 阶段挂上
check("preload 已注册弹幕驱动", !!globalThis.__lp_hj_danmaku, "globalThis.__lp_hj_danmaku");
check(
  "manifest 声明 danmaku driver=plugin_js_v1",
  manifest.capabilities.danmaku.driver === "plugin_js_v1",
  manifest.capabilities.danmaku.status
);

// ---- 回放 ----
const connectionId = "replay-" + Math.random().toString(36).slice(2);
await plugin.createDanmakuSession({
  connectionId,
  roomId: fixture.roomId,
  args: { roomId: fixture.roomId },
  transport: { kind: "websocket", url: "wss://bridge.huajiao.com", frameType: "binary" }
});

// 登录响应是用「本次会话的 secret」加密的，每次会话都会重新随机生成。
// 回放用的是抓包时那一刻的字节，所以必须把当时的 secret 写回去，否则登录帧解不开。
// 驱动脚本是全局 eval 的，`var __lp_hj_dmk_sessions` 落在 globalThis 上，因此这里可直接拿到
// —— 纯测试侧的接缝，不需要生产代码为它开口子。
const sessions = globalThis.__lp_hj_dmk_sessions;
check("可从外部拿到驱动会话表（全局 eval 的 var）", !!sessions, "globalThis.__lp_hj_dmk_sessions");
if (sessions && fixture.secret) {
  sessions[connectionId].secret = fixture.secret;
  check("已注入抓包时的 secret", sessions[connectionId].secret === fixture.secret, fixture.secret.slice(0, 12) + "…");
}

const produced = [];
let reachedLive = false;
let errors = [];

for (const frame of fixture.frames) {
  let result;
  try {
    result = await plugin.onDanmakuFrame({
      connectionId,
      frameType: frame.frameType || "binary",
      bytesBase64: frame.bytesBase64
    });
  } catch (error) {
    errors.push(error.message);
    continue;
  }
  for (const message of result.messages || []) produced.push(message);
  // 进房成功 / 收到弹幕帧后，timer 会转成 heartbeat
  if (result.timer && result.timer.mode === "heartbeat") reachedLive = true;
}

check("回放无解析异常", errors.length === 0, errors.slice(0, 2).join(" | ") || "0 个");
check("回放走到 live（进房成功）", reachedLive);
check("有消息产出", produced.length > 0, `${produced.length} 条`);

// 1) 每条消息结构完整
const badShape = produced.filter((m) => !m || typeof m.text !== "string" || !m.text.trim() || typeof m.nickname !== "string" || !m.nickname.trim());
check(
  "每条消息都有非空 text / nickname",
  badShape.length === 0,
  badShape.length ? JSON.stringify(badShape[0]).slice(0, 120) : "全部合规"
);

// 2) 独立 oracle 算出的每一条文本弹幕，都必须被解析出来（核心断言）
const producedTexts = new Set(produced.map((m) => m.text));
const missing = Array.from(expected).filter((t) => !producedTexts.has(t));
check(
  "夹具中所有文本弹幕都被解析出来",
  missing.length === 0,
  missing.length ? `漏了 ${missing.length} 条，例如：${missing[0]}` : `${expected.size}/${expected.size}`
);

// 3) 噪音不该上屏（type 16 退场）
check(
  "退场等噪音未被渲染",
  !produced.some((m) => m.text === "quit"),
  "没有 quit 文本"
);

// 4) 昵称不能全是兜底值（说明 extends.nickname 取到了）
if (expected.size > 0) {
  const named = produced.filter((m) => m.nickname && m.nickname !== "花椒用户").length;
  check("至少一条取到了真实昵称", named > 0, `${named}/${produced.length} 条带真实昵称`);
}

console.log("\n回放产出的消息：");
for (const m of produced.slice(0, 12)) {
  console.log(`  💬 [${m.nickname}] ${m.text}${m.color !== undefined ? ` (color=${m.color})` : ""}`);
}
if (produced.length > 12) console.log(`  … 还有 ${produced.length - 12} 条`);

await plugin.destroyDanmakuSession({ connectionId });
process.exit(summary() ? 1 : 0);
