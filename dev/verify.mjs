// 本地验证：把 index.js 放进一个模拟的宿主环境里真跑一遍。
// 用途：改插件后不必装进 App 就能确认端点、签名、字段映射是否还对。
//
//   node dev/verify.mjs            # 跑全部
//   node dev/verify.mjs rooms 颜值  # 只跑某个分类

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(here, "..");

// ---- 宿主 Host.* 桥接的最小实现（对齐 JSRuntime.swift 的表层语义）----
globalThis.console.log = console.log;

globalThis.Host = {
  makeError(code, message, context) {
    return new Error("LP_PLUGIN_ERROR:" + JSON.stringify({ code, message, context: context || {} }));
  },
  raise(code, message, context) {
    throw globalThis.Host.makeError(code, message, context);
  },
  crypto: {
    md5(input) {
      return createHash("md5").update(String(input), "utf8").digest("hex");
    }
  },
  http: {
    async request(options) {
      const url = options && options.url;
      if (!url) throw globalThis.Host.makeError("NETWORK", "missing url", {});
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), (options.timeout || 20) * 1000);
      try {
        const response = await fetch(url, {
          method: options.method || "GET",
          headers: options.headers || {},
          body: options.body || undefined,
          signal: controller.signal,
          redirect: "follow"
        });
        const headers = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        return {
          status: response.status,
          headers,
          url: response.url,
          bodyText: await response.text()
        };
      } catch (error) {
        throw globalThis.Host.makeError("NETWORK", String((error && error.message) || error), { url });
      } finally {
        clearTimeout(timer);
      }
    }
  }
};

// ---- 加载插件（preloadScripts 先于 entry）----
const manifest = JSON.parse(readFileSync(join(pluginRoot, "manifest.json"), "utf8"));
for (const script of manifest.preloadScripts || []) {
  try {
    (0, eval)(readFileSync(join(pluginRoot, script), "utf8"));
  } catch (error) {
    console.log(`[warn] preload ${script} 加载失败：${error.message}`);
  }
}
(0, eval)(readFileSync(join(pluginRoot, manifest.entry), "utf8"));

const plugin = globalThis.LiveParsePlugin;
if (!plugin) throw new Error("插件没有导出 globalThis.LiveParsePlugin");

// ---- 断言小工具 ----
let passed = 0;
let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}${detail ? " — " + detail : ""}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`);
  }
}

const filter = process.argv[2] || "";

// ---- 1. 分类 ----
let firstRank = "live";
if (!filter || filter === "categories") {
  console.log("\n== getCategories ==");
  const categories = await plugin.getCategories();
  check("返回非空分类", categories.length > 0, `${categories.length} 个`);
  for (const item of categories) {
    check(
      `分类「${item.title}」结构完整`,
      !!item.id && !!item.biz && Array.isArray(item.subList) && item.subList.length > 0,
      `id=${item.id} biz=${item.biz}`
    );
  }
  if (categories.length) firstRank = categories.find((c) => c.id === "live")?.id || categories[0].id;
}

// ---- 2. 房间列表 ----
let sampleRoom = null;
if (!filter || filter === "rooms" || filter.startsWith("rooms")) {
  const rank = process.argv[3] || firstRank;
  console.log(`\n== getRooms (rank=${rank}) ==`);
  const rooms = await plugin.getRooms({
    category: { id: rank, parentId: rank, title: rank, icon: "", biz: rank },
    parentBiz: rank,
    page: 1
  });
  check("返回非空房间", rooms.length > 0, `${rooms.length} 个`);
  for (const key of ["roomId", "userId", "userName", "roomTitle", "roomCover", "userHeadImg", "liveState"]) {
    check(`字段 ${key} 存在`, rooms[0] && rooms[0][key] !== undefined, rooms[0] ? String(rooms[0][key]).slice(0, 40) : "-");
  }
  check(
    "roomId 为纯数字",
    rooms[0] && /^\d+$/.test(rooms[0].roomId),
    rooms[0] ? rooms[0].roomId : "-"
  );
  sampleRoom = rooms[0] || null;

  if (process.argv.includes("--page2")) {
    const page2 = await plugin.getRooms({
      category: { id: rank, parentId: rank, title: rank, icon: "", biz: rank },
      parentBiz: rank,
      page: 2
    });
    const overlap = page2.filter((r) => rooms.some((x) => x.roomId === r.roomId)).length;
    check("第 2 页与第 1 页基本不重复", page2.length > 0 && overlap < page2.length, `重叠 ${overlap}/${page2.length}`);
  }
  console.log("  样例：", sampleRoom ? `${sampleRoom.userName} / ${sampleRoom.roomTitle} / roomId=${sampleRoom.roomId}` : "-");
}

// ---- 3. 详情 / 状态 / 取流 ----
if (!filter || ["detail", "state", "playback", "share"].includes(filter)) {
  const roomId = process.env.HJ_ROOM_ID || (sampleRoom && sampleRoom.roomId) || "350413218";

  console.log(`\n== getRoomDetail (roomId=${roomId}) ==`);
  try {
    const detail = await plugin.getRoomDetail({ roomId });
    check("拿到房间详情", !!detail.roomId, `${detail.userName} / ${detail.roomTitle}`);
    check("userId 非空", !!detail.userId, detail.userId);
  } catch (error) {
    check("拿到房间详情", false, error.message);
  }

  console.log(`\n== getLiveState (roomId=${roomId}) ==`);
  try {
    const state = await plugin.getLiveState({ roomId });
    check("返回 liveState 字段", state && state.liveState !== undefined, JSON.stringify(state));
    // 回归断言：这一项曾经因为把 feed.mode === "video" 当成录播而误判为 "2"。
    // 热门榜里的房间必然在播，所以这里必须是 "1"。
    check(
      "热门榜房间判为直播中(1)",
      state.liveState === "1",
      `liveState=${state.liveState}（若为 2 说明录播判据又退化了）`
    );
    const offline = await plugin.getLiveState({ roomId: "999999999999" });
    check("不存在的房间判为下播", offline.liveState === "0", JSON.stringify(offline));
  } catch (error) {
    check("返回 liveState 字段", false, error.message);
  }

  console.log(`\n== getPlayback (roomId=${roomId}) ==`);
  try {
    const groups = await plugin.getPlayback({ roomId });
    const qualities = groups[0].qualitys;
    check("返回线路", qualities.length > 0, `${qualities.length} 条`);
    // HLS 应排在首位：AVPlayer 原生解封装最稳（花椒流是 H.265，FLV 需要 FFmpeg 兜底）。
    check(
      "首条线路是 HLS(m3u8)",
      qualities[0] && qualities[0].liveCodeType === "m3u8",
      qualities[0] ? qualities[0].liveCodeType : "-"
    );
    for (const quality of qualities) {
      let ok = false;
      let info = "";
      try {
        const response = await fetch(quality.url, {
          headers: Object.assign({}, quality.headers, { "User-Agent": quality.userAgent }),
          redirect: "follow"
        });
        ok = response.ok;
        info = `HTTP ${response.status} ${response.headers.get("content-type") || ""}`;
      } catch (error) {
        info = error.message;
      }
      check(`线路 ${quality.liveCodeType} 可访问`, ok, `${info} | ${quality.url.slice(0, 90)}`);
    }

    // HLS 的 m3u8 里是裸文件名分片，必须能按播放列表所在目录拼出可下载的分片。
    const hls = qualities.find((q) => q.liveCodeType === "m3u8");
    if (hls) {
      try {
        const playlist = await (await fetch(hls.url, { headers: Object.assign({}, hls.headers, { "User-Agent": hls.userAgent }) })).text();
        const segment = playlist.split("\n").map((l) => l.trim()).find((l) => /\.ts(\?|$)/.test(l));
        check("m3u8 含 TS 分片", !!segment, segment ? segment.slice(0, 60) : "播放列表里没有 .ts 行");
        if (segment) {
          const base = hls.url.slice(0, hls.url.lastIndexOf("/") + 1);
          const segmentURL = /^https?:/.test(segment) ? segment : base + segment;
          const head = await fetch(segmentURL, {
            method: "GET",
            headers: Object.assign({}, hls.headers, { "User-Agent": hls.userAgent })
          });
          check("分片可下载", head.ok, `HTTP ${head.status} ${head.headers.get("content-type") || ""}`);
        }
      } catch (error) {
        check("m3u8 含 TS 分片", false, error.message);
      }
    }
  } catch (error) {
    check("返回线路", false, error.message);
  }

  console.log(`\n== refreshPlayback (roomId=${roomId}) ==`);
  try {
    const refreshed = await plugin.refreshPlayback({
      roomId,
      quality: { requestContext: { kind: "hls" } }
    });
    check("刷新返回单条线路", !!refreshed && !!refreshed.url, refreshed ? refreshed.liveCodeType : "-");
    check("刷新命中 m3u8", refreshed.liveCodeType === "m3u8", refreshed.url.slice(0, 80));
  } catch (error) {
    check("刷新返回单条线路", false, error.message);
  }

  console.log("\n== resolveShare ==");
  try {
    const room = await plugin.resolveShare({ shareCode: `https://h.huajiao.com/l/index?liveid=${roomId}&qd=hu` });
    check("解析分享链接", !!room.roomId, room.roomId);
    const byNumber = await plugin.resolveShare({ shareCode: String(roomId) });
    check("解析纯房间号", byNumber.roomId === String(roomId), byNumber.roomId);
  } catch (error) {
    check("解析分享链接", false, error.message);
  }
}

// ---- 4. 弹幕声明 ----
if (!filter || filter === "danmaku") {
  console.log("\n== getDanmaku ==");
  try {
    const roomId = process.env.HJ_ROOM_ID || (sampleRoom && sampleRoom.roomId) || "350413218";
    const plan = await plugin.getDanmaku({ roomId });
    check("transport.kind = websocket", plan.transport.kind === "websocket", plan.transport.url);
    check("runtime.driver = plugin_js_v1", plan.runtime.driver === "plugin_js_v1", plan.runtime.protocolId);
  } catch (error) {
    check("返回弹幕计划", false, error.message);
  }
}

console.log(`\n—— ${passed} 通过 / ${failed} 失败 ——`);
process.exit(failed ? 1 : 0);
