// 花椒直播 1.0.0 — AngelLive JS 插件
//
// 端点来源（2026-09-30 实测可用）：
//   分类   GET  https://setting.huajiao.com/config/multi?platform=web&version=1.0&module=h5_web_tab_setting
//   列表   GET  https://live.huajiao.com/feed/getLives   （JSONP + guid 签名）
//   详情   GET  https://h.huajiao.com/api/getFeedInfo?sid=<ms>&liveid=<relateid>
//   取流   同「详情」，取 data.live.main（HLS）/ data.live.h264_url（FLV）
//
// 房间号的真实语义：feed.relateid（即 https://h.huajiao.com/l/index?liveid=<relateid>）。

var __lp_hj_liveHost = "https://live.huajiao.com";
var __lp_hj_feedHost = "https://h.huajiao.com";
var __lp_hj_configHost = "https://setting.huajiao.com";

var __lp_hj_h5UserAgent =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// 播放 CDN 对 Referer 敏感，直接用 h.huajiao.com 会被拒。
var __lp_hj_playUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
var __lp_hj_playHeaders = { Referer: "https://h.huajiao.com/", Origin: "https://h.huajiao.com" };

// 榜单接口要求的固定签名盐（见 H5 站点 webpack 产物 getGuid()）。
var __lp_hj_guidSalt = "eac63e66d8c4a6f0303f00bc76d0217c";
var __lp_hj_pageSize = 40;

function _hj_throw(code, message, context) {
  if (globalThis.Host && typeof Host.raise === "function") {
    Host.raise(code, message, context || {});
  }
  throw new Error(
    "LP_PLUGIN_ERROR:" +
      JSON.stringify({ code: String(code || "UNKNOWN"), message: String(message || ""), context: context || {} })
  );
}

function _hj_text(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

function _hj_htmlHeaders() {
  return {
    "user-agent": __lp_hj_h5UserAgent,
    "accept-language": "zh-Hans-CN;q=1",
    accept: "application/json, text/plain, */*",
    referer: "https://h.huajiao.com/l/feedlist"
  };
}

async function _hj_getText(url, headers, timeoutSeconds) {
  var response = await Host.http.request({
    url: url,
    method: "GET",
    headers: headers || _hj_htmlHeaders(),
    timeout: timeoutSeconds || 20
  });
  var status = Number(response && response.status) || 0;
  var body = _hj_text(response && response.bodyText);
  if (status >= 400) {
    _hj_throw("UPSTREAM", "HTTP " + status + " for " + url, { url: url, status: status });
  }
  return body;
}

/// 榜单接口用 JSONP 包裹（callback({...})），错误时可能是裸 JSON。
function _hj_unwrapJSONP(text) {
  var raw = _hj_text(text).trim();
  if (!raw) return "";
  if (raw.charAt(0) === "{") return raw;
  var start = raw.indexOf("(");
  var end = raw.lastIndexOf(")");
  if (start < 0 || end <= start) return "";
  return raw.slice(start + 1, end).trim();
}

async function _hj_getJSON(url, headers, timeoutSeconds) {
  var text = await _hj_getText(url, headers, timeoutSeconds);
  var payload = _hj_unwrapJSONP(text);
  if (!payload) return null; // 空响应＝房间不存在或已下播
  try {
    return JSON.parse(payload);
  } catch (error) {
    _hj_throw("PARSE", "花椒返回体不是 JSON: " + text.slice(0, 160), { url: url });
  }
}

function _hj_md5(input) {
  var host = globalThis.Host;
  if (host && host.crypto && typeof host.crypto.md5 === "function") {
    return host.crypto.md5(String(input));
  }
  _hj_throw("UNSUPPORTED", "Host.crypto.md5 is required", {});
}

/// 复刻 H5 站点 getGuid()，缺任一段都会命中「不能重复请求」。
function _hj_signedQuery(extra) {
  var rand = Math.random();
  var time = Date.now();
  var guid = _hj_md5(
    "platform=ios" + "rand=" + rand + "time=" + time + "userid=" + "" + "version=7.0.0" + __lp_hj_guidSalt
  );

  var params = {
    partner: "h5Inner",
    rand: String(rand),
    time: String(time),
    platform: "ios",
    version: "7.0.0",
    userid: "",
    guid: guid
  };
  for (var key in extra) {
    if (Object.prototype.hasOwnProperty.call(extra, key)) params[key] = String(extra[key]);
  }

  var pairs = [];
  for (var name in params) {
    if (Object.prototype.hasOwnProperty.call(params, name)) {
      pairs.push(encodeURIComponent(name) + "=" + encodeURIComponent(params[name]));
    }
  }
  return pairs.join("&");
}

function _hj_roomFromFeed(feed, author) {
  var f = feed || {};
  var a = author || {};
  var roomId = _hj_text(f.relateid || f.liveid);
  if (!roomId) return null;

  return {
    userName: _hj_text(a.nickname),
    roomTitle: _hj_text(f.title),
    roomCover: _hj_text(f.image || f.webp_image),
    userHeadImg: _hj_text(a.avatar),
    liveState: _hj_liveStateFromFeed(f),
    userId: _hj_text(a.uid),
    roomId: roomId,
    liveWatchedCount: _hj_text(f.watches || f.current_heat || "0")
  };
}

/// 实测结论（2026-09-30，120 条在播房间抽样）：
///   在播房间统一是 feed.mode === "video" 且 feed.replay_status === 0。
///   所以 mode 只是「视频形态直播」的形态标记，**不能**用来判录播；
///   回放只有 replay_status === "1" 一个可靠信号。
function _hj_liveStateFromFeed(feed) {
  var f = feed || {};
  if (_hj_text(f.replay_status) === "1") return "2";
  return "1";
}

async function _hj_getLives(rankName, page) {
  var pageNumber = Number(page);
  if (!isFinite(pageNumber) || pageNumber < 1) pageNumber = 1;
  var offset = (pageNumber - 1) * __lp_hj_pageSize;

  var query = _hj_signedQuery({
    num: __lp_hj_pageSize,
    name: rankName,
    offset: offset,
    real_feeds: 0,
    callback: "lp_callback"
  });

  var payload = await _hj_getJSON(__lp_hj_liveHost + "/feed/getLives?" + query);
  if (!payload) return [];
  if (Number(payload.errno) !== 0) {
    _hj_throw("UPSTREAM", "花椒列表错误: " + _hj_text(payload.errmsg), {
      errno: _hj_text(payload.errno),
      name: rankName
    });
  }
  return payload;
}

function _hj_flattenRooms(payload) {
  var rooms = [];
  var seen = {};
  var data = (payload && payload.data) || {};
  var sections = data.sections || [];
  for (var i = 0; i < sections.length; i++) {
    var feeds = (sections[i] && sections[i].feeds) || [];
    for (var j = 0; j < feeds.length; j++) {
      var item = feeds[j] || {};
      if (Number(item.type) !== 1) continue; // 只留直播中；实测在播房间 type 恒为 1
      var room = _hj_roomFromFeed(item.feed, item.author);
      if (!room) continue;
      if (seen[room.roomId]) continue; // 多 section 时同一房间会重复出现
      seen[room.roomId] = true;
      rooms.push(room);
    }
  }
  return rooms;
}

async function _hj_getFeedInfo(roomId) {
  var id = _hj_text(roomId).trim();
  if (!id) _hj_throw("INVALID_ARGS", "roomId is required", { field: "roomId" });

  var url =
    __lp_hj_feedHost +
    "/api/getFeedInfo?sid=" +
    encodeURIComponent(String(Date.now())) +
    "&liveid=" +
    encodeURIComponent(id);

  var headers = _hj_htmlHeaders();
  headers.referer = "https://h.huajiao.com/l/index?liveid=" + encodeURIComponent(id) + "&qd=hu";

  var payload = await _hj_getJSON(url, headers);
  // 实测：不存在的 liveid 返回 HTTP 200 + 空响应体。
  if (!payload) return null;
  if (Number(payload.errno) !== 0) return null;
  return payload.data || null;
}

/// 从 feed 详情里挑出可播线路。
///
/// 2026-09-30 实测（房间 350413894）：
///   live.pull_m3u8 === live.main  → application/vnd.apple.mpegurl（标准 MPEG-TS 分片，H.265）
///   live.h264_url === feed.pull_url → video/x-flv（头 4 字节 FLV\x01）
/// AngelLive 播放器是 AVPlayer/KSPlayer：HLS 走原生解封装最稳，FLV(H.265) 需要 FFmpeg 兜底，
/// 因此把 HLS 排在前面（qn 用于线路排序，越小越优先）。
function _hj_playbackQualities(roomId, data) {
  var live = (data && data.live) || {};
  var feed = ((data && data.feed) || {}).feed || {};

  var hls = _hj_text(live.pull_m3u8 || live.main);
  var flv = _hj_text(live.h264_url || feed.pull_url);
  var qualities = [];

  if (hls) {
    qualities.push({
      roomId: _hj_text(roomId),
      title: "高清",
      qn: 1,
      url: hls,
      liveCodeType: "m3u8",
      liveType: "huajiao",
      userAgent: __lp_hj_playUserAgent,
      headers: __lp_hj_playHeaders,
      requestContext: { kind: "hls" }
    });
  }
  if (flv) {
    qualities.push({
      roomId: _hj_text(roomId),
      title: "原画",
      qn: 2,
      url: flv,
      liveCodeType: "flv",
      liveType: "huajiao",
      userAgent: __lp_hj_playUserAgent,
      headers: __lp_hj_playHeaders,
      requestContext: { kind: "flv" }
    });
  }
  return qualities;
}

function _hj_extractLiveId(input) {
  var text = _hj_text(input).trim();
  if (!text) return "";
  if (/^\d{3,}$/.test(text)) return text;
  var match = text.match(/[?&]liveid=(\d+)/i);
  if (match) return match[1];
  match = text.match(/huajiao\.com\/(?:l|live)\/(\d+)/i);
  if (match) return match[1];
  match = text.match(/(\d{6,})/);
  return match ? match[1] : "";
}

globalThis.LiveParsePlugin = {
  apiVersion: 1,

  async getCategories() {
    var url = __lp_hj_configHost + "/config/multi?platform=web&version=1.0&module=h5_web_tab_setting";
    var payload = await _hj_getJSON(url, _hj_htmlHeaders());

    var tabs = null;
    var setting = payload && payload.data && payload.data.h5_web_tab_setting;
    if (setting && setting.value) {
      try {
        tabs = JSON.parse(setting.value);
      } catch (error) {
        tabs = null;
      }
    }

    // 配置接口不可用时退回实测稳定的分类集合。
    if (!tabs || !tabs.length) {
      tabs = [
        { name: "热门", rank_name: "live" },
        { name: "推荐", rank_name: "tag_jingxuan" },
        { name: "跳舞", rank_name: "tag_跳舞" },
        { name: "颜值", rank_name: "tag_颜值" },
        { name: "音乐", rank_name: "tag_唱歌" },
        { name: "脱口秀", rank_name: "tag_脱口秀" }
      ];
    }

    var result = [];
    for (var i = 0; i < tabs.length; i++) {
      var tab = tabs[i] || {};
      var rankName = _hj_text(tab.rank_name);
      if (!rankName) continue;
      var title = _hj_text(tab.name) || rankName;

      result.push({
        id: rankName,
        title: title,
        icon: "",
        biz: rankName,
        subList: [
          {
            id: rankName,
            parentId: rankName,
            title: title,
            icon: "",
            biz: rankName
          }
        ]
      });
    }
    return result;
  },

  async getRooms(payload) {
    var category = (payload && payload.category) || {};
    var rankName = _hj_text(
      (payload && payload.parentBiz) || category.biz || category.id || (payload && payload.id)
    );
    if (!rankName) _hj_throw("INVALID_ARGS", "category is required", { field: "id" });

    var page = Number((payload && payload.page) || 1);
    var data = await _hj_getLives(rankName, page);
    return _hj_flattenRooms(data);
  },

  async getRoomDetail(payload) {
    var roomId = _hj_extractLiveId((payload && payload.roomId) || "");
    if (!roomId) _hj_throw("INVALID_ARGS", "roomId is required", { field: "roomId" });

    var data = await _hj_getFeedInfo(roomId);
    if (!data) {
      _hj_throw("NOT_FOUND", "花椒直播间不存在或已下播: " + roomId, { roomId: roomId });
    }

    var feed = (data.feed || {}).feed || {};
    var room = _hj_roomFromFeed(
      Object.assign({}, feed, { relateid: feed.relateid || roomId }),
      data.feed ? data.feed.author : null
    );
    if (!room) _hj_throw("NOT_FOUND", "花椒直播间信息缺失: " + roomId, { roomId: roomId });
    return room;
  },

  async getLiveState(payload) {
    var roomId = _hj_extractLiveId((payload && payload.roomId) || "");
    if (!roomId) _hj_throw("INVALID_ARGS", "roomId is required", { field: "roomId" });

    var data = await _hj_getFeedInfo(roomId);
    if (!data) return { liveState: "0" };

    var live = data.live || {};
    var feed = (data.feed || {}).feed || {};

    // live.errcode != 0 表示这一路取流被上游拒了，等同于当前不可播。
    if (Number(_hj_text(live.errcode) || "0") !== 0) return { liveState: "0" };

    var hasStream = !!_hj_text(live.main || live.h264_url || feed.pull_url);
    if (!hasStream) return { liveState: "0" };

    return { liveState: _hj_liveStateFromFeed(feed) };
  },

  async getPlayback(payload) {
    var roomId = _hj_extractLiveId((payload && payload.roomId) || "");
    if (!roomId) _hj_throw("INVALID_ARGS", "roomId is required", { field: "roomId" });

    var data = await _hj_getFeedInfo(roomId);
    if (!data) _hj_throw("NOT_FOUND", "花椒直播间不存在或已下播: " + roomId, { roomId: roomId });

    var qualities = _hj_playbackQualities(roomId, data);
    if (!qualities.length) {
      _hj_throw("NOT_FOUND", "花椒未返回可播地址: " + roomId, { roomId: roomId });
    }

    return [
      {
        cdn: "花椒直播",
        displayName: "默认线路",
        requestContext: { roomId: roomId },
        qualitys: qualities
      }
    ];
  },

  async refreshPlayback(payload) {
    var roomId = _hj_extractLiveId((payload && payload.roomId) || "");
    if (!roomId) _hj_throw("INVALID_ARGS", "roomId is required", { field: "roomId" });

    var wanted = _hj_text(
      (payload && payload.quality && payload.quality.requestContext && payload.quality.requestContext.kind) || ""
    );

    var data = await _hj_getFeedInfo(roomId);
    if (!data) _hj_throw("NOT_FOUND", "花椒直播间不存在或已下播: " + roomId, { roomId: roomId });

    var qualities = _hj_playbackQualities(roomId, data);
    if (!qualities.length) _hj_throw("NOT_FOUND", "花椒未返回可播地址: " + roomId, { roomId: roomId });

    for (var i = 0; i < qualities.length; i++) {
      if (!wanted || qualities[i].liveCodeType === wanted || qualities[i].title === wanted) {
        return qualities[i];
      }
    }
    return qualities[0];
  },

  async resolveShare(payload) {
    var shareCode = _hj_text((payload && payload.shareCode) || "");
    if (!shareCode) _hj_throw("INVALID_ARGS", "shareCode is required", { field: "shareCode" });

    var roomId = _hj_extractLiveId(shareCode);
    if (!roomId) {
      _hj_throw("NOT_FOUND", "无法从分享内容解析花椒房间号", { shareCode: shareCode });
    }
    return await this.getRoomDetail({ roomId: roomId });
  },

  // 花椒未开放公开搜索接口；返回空数组而不是抛错，避免拖垮宿主的多平台并发搜索。
  async search() {
    return [];
  },

  async getDanmaku(payload) {
    var roomId = _hj_extractLiveId((payload && payload.roomId) || "");
    if (!roomId) _hj_throw("INVALID_ARGS", "roomId is required", { field: "roomId" });

    var driver = globalThis.__lp_hj_danmaku;
    if (!driver) _hj_throw("UNSUPPORTED", "花椒弹幕驱动未加载", {});

    var room = null;
    try {
      room = await this.getRoomDetail({ roomId: roomId });
    } catch (error) {
      room = null;
    }

    return {
      args: { roomId: roomId, room_id: roomId, uid: room ? room.userId : "" },
      headers: { "user-agent": __lp_hj_playUserAgent, Referer: "https://h.huajiao.com/" },
      transport: {
        kind: "websocket",
        url: "wss://bridge.huajiao.com",
        frameType: "binary"
      },
      runtime: {
        driver: "plugin_js_v1",
        protocolId: "huajiao_ws",
        protocolVersion: "1"
      }
    };
  },

  async createDanmakuSession(payload) {
    return await globalThis.__lp_hj_danmaku.createDanmakuSession(payload);
  },

  async onDanmakuOpen(payload) {
    return await globalThis.__lp_hj_danmaku.onDanmakuOpen(payload);
  },

  async onDanmakuFrame(payload) {
    return await globalThis.__lp_hj_danmaku.onDanmakuFrame(payload);
  },

  async onDanmakuTick(payload) {
    return await globalThis.__lp_hj_danmaku.onDanmakuTick(payload);
  },

  async destroyDanmakuSession(payload) {
    return await globalThis.__lp_hj_danmaku.destroyDanmakuSession(payload);
  }
};
