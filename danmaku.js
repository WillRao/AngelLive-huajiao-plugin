// 花椒直播弹幕驱动（preload）——由 index.js 的 getDanmaku/createDanmakuSession/... 转发。
//
// 协议：wss://bridge.huajiao.com 上的 protobuf + RC4（proto2，见 wbt5/real-url 的 danmu/danmaku/huajiao.proto）。
// 这次是把参考实现(huajiao.py)按宿主 plugin_js_v1 驱动契约重写：宿主只管搬字节，
// 握手/登录/进房/心跳全部在这里的状态机里完成。
//
// 与参考实现一致的三处关键点（踩过坑，勿改）：
//   1. Message.Request 是外层字段 6，init_login_req=9 / login=2 / service_req=11 都在它里面；
//      漏掉外层会把 req 当成 Message 的一级字段，服务端直接 1006 断连。
//   2. 握手响应从第 6 字节开始解密（前 2 字节 flag + 4 字节 0）；登录响应从第 4 字节开始（4 字节长度前缀）。
//      登录之后的帧（进房响应、弹幕推送）都是明文。
//   3. 进房响应是 Response.service_resp(12) → Service_Resp.response(2) → ChatRoomPacket，共三层。

var __lp_hj_dmk_key = "3f190210cb1cf32a2378ee57900acf78";
var __lp_hj_dmk_appId = 2080;
var __lp_hj_dmk_verfSalt = "360tantan@1408$";
var __lp_hj_dmk_wsURL = "wss://bridge.huajiao.com";
var __lp_hj_dmk_heartbeatMs = 20000;

// ---------------------------------------------------------------- 显示开关
// 花椒一个房间在 70s 内能推 40+ 条 msgcontent，其中大部分是榜单/活动角标这类系统消息，
// 真正能上弹幕的只有下面三种。按需打开。
var __lp_hj_dmk_showJoin = true;  // type 10：进场提示（「xx 加入了直播间」）
var __lp_hj_dmk_showGift = false; // type 30/399/415：礼物播报。秀场房间会很吵，默认关。
var __lp_hj_dmk_showAvatar = false; // 是否在弹幕前插一张头像图（图文混排）。每条都要拉一次外链，默认关。
var __lp_hj_dmk_typeChat = "9";   // 文本聊天
var __lp_hj_dmk_typeJoin = "10";  // 进场
var __lp_hj_dmk_giftTypes = { "30": true, "399": true, "415": true };

// ---------------------------------------------------------------- 工具

function _dmk_throw(code, message, context) {
  if (globalThis.Host && typeof Host.raise === "function") {
    Host.raise(code, message, context || {});
  }
  throw new Error(
    "LP_PLUGIN_ERROR:" +
      JSON.stringify({ code: String(code || "UNKNOWN"), message: String(message || ""), context: context || {} })
  );
}

function _dmk_md5(text) {
  if (globalThis.Host && Host.crypto && typeof Host.crypto.md5 === "function") {
    return Host.crypto.md5(String(text));
  }
  _dmk_throw("UNSUPPORTED", "Host.crypto.md5 is required", {});
}

function _dmk_rand(n, digitsOnly) {
  var alphabet = digitsOnly
    ? "0123456789"
    : "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  var out = "";
  for (var i = 0; i < n; i++) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}

function _dmk_bytesFromBase64(base64) {
  var binary = globalThis.atob(String(base64 || ""));
  var bytes = new Uint8Array(binary.length);
  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
  return bytes;
}

function _dmk_base64FromBytes(bytes) {
  var chunks = [];
  for (var i = 0; i < bytes.length; i++) chunks.push(String.fromCharCode(bytes[i]));
  return globalThis.btoa(chunks.join(""));
}

function _dmk_utf8Encode(text) {
  var encoded = unescape(encodeURIComponent(String(text)));
  var bytes = new Uint8Array(encoded.length);
  for (var i = 0; i < encoded.length; i++) bytes[i] = encoded.charCodeAt(i) & 0xff;
  return bytes;
}

function _dmk_utf8Decode(bytes) {
  var chunks = [];
  for (var i = 0; i < bytes.length; i++) chunks.push(String.fromCharCode(bytes[i]));
  try {
    return decodeURIComponent(escape(chunks.join("")));
  } catch (error) {
    return chunks.join("");
  }
}

function _dmk_concat(list) {
  var total = 0;
  for (var i = 0; i < list.length; i++) total += list[i].length;
  var out = new Uint8Array(total);
  var offset = 0;
  for (var j = 0; j < list.length; j++) {
    out.set(list[j], offset);
    offset += list[j].length;
  }
  return out;
}

/// RC4。注意密钥按字符码取字节，与参考实现的 ord(key[i]) 一致（盐是 ASCII）。
function _dmk_rc4(data, key) {
  var s = new Uint8Array(256);
  for (var i = 0; i < 256; i++) s[i] = i;
  var keyBytes = [];
  for (var k = 0; k < key.length; k++) keyBytes.push(key.charCodeAt(k) & 0xff);
  var j = 0;
  for (var a = 0; a < 256; a++) {
    j = (j + s[a] + keyBytes[a % keyBytes.length]) % 256;
    var tmp = s[a];
    s[a] = s[j];
    s[j] = tmp;
  }
  var out = new Uint8Array(data.length);
  var p = 0;
  var q = 0;
  for (var n = 0; n < data.length; n++) {
    p = (p + 1) % 256;
    q = (q + s[p]) % 256;
    var swap = s[p];
    s[p] = s[q];
    s[q] = swap;
    out[n] = data[n] ^ s[(s[p] + s[q]) % 256];
  }
  return out;
}

// ---------------------------------------------------------------- protobuf 最小实现

function _dmk_varint(value) {
  var out = [];
  var v = value;
  while (v > 127) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return out;
}

function _dmk_tag(field, wire) {
  return _dmk_varint(field * 8 + wire);
}

function _dmk_pbVarint(field, value) {
  return _dmk_tag(field, 0).concat(_dmk_varint(value));
}

function _dmk_pbBytes(field, bytes) {
  var body = Array.prototype.slice.call(bytes);
  return _dmk_tag(field, 2).concat(_dmk_varint(body.length), body);
}

function _dmk_pbString(field, text) {
  return _dmk_pbBytes(field, _dmk_utf8Encode(text));
}

function _dmk_pbBool(field, value) {
  return _dmk_pbVarint(field, value ? 1 : 0);
}

function _dmk_readVarint(buf, pos) {
  var result = 0;
  var shift = 0;
  while (pos < buf.length) {
    var byte = buf[pos++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return [result, pos];
}

/// 解析一层 protobuf，返回 { fieldNumber: [value, ...] }，value 为数字或 Uint8Array。
function _dmk_parse(buf) {
  var out = {};
  var pos = 0;
  while (pos < buf.length) {
    var key;
    var pair = _dmk_readVarint(buf, pos);
    key = pair[0];
    pos = pair[1];
    var field = key >> 3;
    var wire = key & 7;
    var value;
    if (wire === 0) {
      var vr = _dmk_readVarint(buf, pos);
      value = vr[0];
      pos = vr[1];
    } else if (wire === 2) {
      var lr = _dmk_readVarint(buf, pos);
      var length = lr[0];
      pos = lr[1];
      value = buf.slice(pos, pos + length);
      pos += length;
    } else if (wire === 5) {
      value = buf.slice(pos, pos + 4);
      pos += 4;
    } else if (wire === 1) {
      value = buf.slice(pos, pos + 8);
      pos += 8;
    } else {
      throw new Error("unsupported wire type " + wire);
    }
    if (!out[field]) out[field] = [];
    out[field].push(value);
  }
  return out;
}

function _dmk_field(fields, number) {
  return fields && fields[number] ? fields[number][0] : undefined;
}

function _dmk_sub(fields, number) {
  var raw = _dmk_field(fields, number);
  if (!raw || typeof raw === "number") return null;
  try {
    return _dmk_parse(raw);
  } catch (error) {
    return null;
  }
}

function _dmk_text(fields, number) {
  var raw = _dmk_field(fields, number);
  if (!raw || typeof raw === "number") return "";
  return _dmk_utf8Decode(raw);
}

// ---------------------------------------------------------------- 帧构造

/// Message 信封。extra 必须已经带好外层字段号（Request 恒为 6）。
function _dmk_message(msgid, sn, sender, extra) {
  var body = _dmk_pbVarint(1, msgid)
    .concat(_dmk_pbVarint(2, sn), _dmk_pbString(3, sender), extra, _dmk_pbString(12, "jid"));
  return new Uint8Array(body);
}

function _dmk_withHandshakeHeader(payload) {
  var head = new Uint8Array(12);
  head[0] = 113; // 'q'
  head[1] = 104; // 'h'
  head[2] = 1 << 4; // protocolVersion = 1
  head[3] = 101; // clientVersion
  head[4] = 2080 >> 8;
  head[5] = 2080 & 0xff;
  var frame = new Uint8Array(12 + 4 + payload.length);
  frame.set(head, 0);
  var total = frame.length;
  frame[12] = (total >>> 24) & 0xff;
  frame[13] = (total >>> 16) & 0xff;
  frame[14] = (total >>> 8) & 0xff;
  frame[15] = total & 0xff;
  frame.set(payload, 16);
  return frame;
}

function _dmk_withLengthPrefix(payload) {
  var frame = new Uint8Array(4 + payload.length);
  frame[0] = (frame.length >>> 24) & 0xff;
  frame[1] = (frame.length >>> 16) & 0xff;
  frame[2] = (frame.length >>> 8) & 0xff;
  frame[3] = frame.length & 0xff;
  frame.set(payload, 4);
  return frame;
}

function _dmk_binaryWrite(bytes) {
  return { kind: "binary", bytesBase64: _dmk_base64FromBytes(bytes) };
}

// ---------------------------------------------------------------- 会话状态机

var __lp_hj_dmk_sessions = Object.create(null);

function _dmk_session(connectionId) {
  var id = String(connectionId || "");
  var session = __lp_hj_dmk_sessions[id];
  if (!session) _dmk_throw("INVALID_ARGS", "unknown danmaku connection: " + id, { connectionId: id });
  return session;
}

function _dmk_timer(active) {
  return active
    ? { mode: "heartbeat", intervalMs: __lp_hj_dmk_heartbeatMs }
    : { mode: "off" };
}

function _dmk_buildHandshake(session) {
  var clientRam = _dmk_rand(10);
  var initLoginReq = new Uint8Array(
    _dmk_pbString(1, clientRam).concat(_dmk_pbString(2, ""))
  );
  var request = _dmk_pbBytes(6, _dmk_pbBytes(9, initLoginReq));
  var plain = _dmk_message(100009, session.sn, session.secret, request);
  return _dmk_withHandshakeHeader(_dmk_rc4(plain, __lp_hj_dmk_key));
}

function _dmk_buildLogin(session, serverRam) {
  var secretRam = _dmk_rc4(_dmk_utf8Encode(serverRam + _dmk_rand(8)), session.secret);
  var verfCode = _dmk_md5(session.secret + __lp_hj_dmk_verfSalt).slice(24);

  var login = new Uint8Array(
    _dmk_pbString(1, "ios")
      .concat(
        _dmk_pbVarint(2, 4),
        _dmk_pbString(3, serverRam),
        _dmk_pbBytes(4, secretRam),
        _dmk_pbVarint(5, __lp_hj_dmk_appId),
        _dmk_pbString(8, "h5"),
        _dmk_pbString(9, verfCode),
        _dmk_pbBool(10, true)
      )
  );
  session.sn = Number(_dmk_rand(10, true));
  var plain = _dmk_message(100001, session.sn, session.secret, _dmk_pbBytes(6, _dmk_pbBytes(2, login)));
  return _dmk_withLengthPrefix(_dmk_rc4(plain, __lp_hj_dmk_key));
}

function _dmk_buildJoin(session) {
  var roomBytes = _dmk_utf8Encode(session.roomId);
  var room = new Uint8Array(_dmk_pbBytes(1, roomBytes));
  var joinRequest = new Uint8Array(
    _dmk_pbBytes(1, roomBytes).concat(_dmk_pbBytes(2, room), _dmk_pbVarint(3, 0))
  );
  var upToServer = new Uint8Array(_dmk_pbVarint(1, 102).concat(_dmk_pbBytes(4, joinRequest)));
  var uuid = _dmk_md5(_dmk_rand(10) + "0000000001" + String(Date.now()));

  var packet = new Uint8Array(
    _dmk_pbBytes(1, roomBytes)
      .concat(
        _dmk_pbBytes(2, upToServer),
        _dmk_pbString(4, uuid),
        _dmk_pbVarint(5, session.sn),
        _dmk_pbVarint(6, __lp_hj_dmk_appId)
      )
  );

  var serviceReq = new Uint8Array(_dmk_pbVarint(1, 10000006).concat(_dmk_pbBytes(2, packet)));
  session.sn = Number(_dmk_rand(10, true));
  var plain = _dmk_message(100011, session.sn, session.secret, _dmk_pbBytes(6, _dmk_pbBytes(11, serviceReq)));
  // 进房帧是明文（只有握手与登录用 RC4）。
  return _dmk_withLengthPrefix(plain);
}

/// payloadBytes 是 ChatRoomPacket 本体（Notify → NewMessageNotify.info_content）。
///
/// msgcontent 是一段 JSON，用 `type` 区分子类型。2026-09-30 实测样本：
///   type 9   → 文本聊天  {"type":9,"text":"IP按照每天第一次登的显示","extends":{"nickname":"@无情哥哥",...}}
///   type 10  → 进场      {"type":10,"text":"加入直播了","extends":{"nickname":"...","userid":...}}
///   type 16  → 退场      {"type":16,"text":"quit","extends":{"userid":129278458}}   ← 没有昵称，忽略
///   type 30 / 399 / 415 → 礼物（顶层 text 已是完整句子，昵称在 extends.sender.nickname）
///   type 104 / 235 / 270 / 282 / 290 / 159 → 榜单、活动角标、粉丝团等系统消息，忽略
/// 注意 `type` 有时是数字（9）有时是字符串（"399"），统一 String() 后再比。
function _dmk_parseChatMessage(payloadBytes) {
  var packet;
  try {
    packet = _dmk_parse(payloadBytes);
  } catch (error) {
    return [];
  }
  var down = _dmk_sub(packet, 3); // ChatRoomPacket.to_user_data
  if (!down) return [];
  if (_dmk_field(down, 2) !== 1000) return []; // 1001/1002 是进出房通知，不显示

  var newMsg = _dmk_sub(down, 13); // ChatRoomDownToUser.newmsgnotify
  if (!newMsg) return [];
  var contentBytes = _dmk_field(newMsg, 4);
  if (!contentBytes || typeof contentBytes === "number") return [];

  var text = _dmk_utf8Decode(contentBytes).trim();
  if (!text || text.charAt(0) !== "{") return [];

  var json;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return [];
  }

  var kind = _dmk_jsonText(json.type);
  var ext = json.extends && typeof json.extends === "object" ? json.extends : {};

  if (kind === __lp_hj_dmk_typeChat) {
    var body = _dmk_stringValue(json.text);
    if (!body) return [];
    return [_dmk_makeMessage(body, _dmk_nickname(ext), json, ext)];
  }

  if (__lp_hj_dmk_showJoin && kind === __lp_hj_dmk_typeJoin) {
    var who = _dmk_nickname(ext);
    if (!who) return [];
    return [_dmk_makeMessage("加入了直播间", who, json, ext)];
  }

  if (__lp_hj_dmk_showGift && __lp_hj_dmk_giftTypes[kind]) {
    var giftText = _dmk_stringValue(json.text);
    if (!giftText) return [];
    var sender = ext.sender && ext.sender.nickname ? _dmk_jsonText(ext.sender.nickname) : "";
    return [_dmk_makeMessage(giftText, sender || "花椒", json, ext)];
  }

  return [];
}

/// 只接受字符串/数字；花椒有些 type（如 104）的 text 是对象，必须挡掉。
function _dmk_stringValue(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
}

/// ⚠️ 这是给「JSON.parse 出来的对象」用的，不要和 _dmk_text 混用：
/// _dmk_text(fields, n) 取的是 protobuf 的 fields[n][0]，而 JSON 对象得直接读属性。
/// 混用会静默返回空串 —— 消息会一条都出不来，且不会报错。
function _dmk_jsonText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return "";
  return String(value);
}

function _dmk_nickname(ext) {
  var name = _dmk_jsonText(ext.nickname);
  if (name) return name;
  if (ext.sender && typeof ext.sender === "object") {
    var senderName = _dmk_jsonText(ext.sender.nickname);
    if (senderName) return senderName;
    if (ext.sender.receiver && typeof ext.sender.receiver === "object") {
      var receiverName = _dmk_jsonText(ext.sender.receiver.nickname);
      if (receiverName) return receiverName;
    }
  }
  return "花椒用户";
}

/// 花椒的颜色是 "#RRGGBB"（也有十进制写法），归一化成宿主要的整数。
function _dmk_parseColor(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "object") return null;
  var raw = String(value).trim();
  if (!raw) return null;
  if (raw.charAt(0) === "#") raw = raw.slice(1);
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return parseInt(raw, 16);
  if (/^\d+$/.test(raw)) {
    var parsed = parseInt(raw, 10);
    return parsed >= 0 ? parsed : null;
  }
  return null;
}

function _dmk_makeMessage(text, nickname, json, ext) {
  var message = { text: text, nickname: nickname };

  var color = _dmk_parseColor(ext.text_color);
  if (color === null) color = _dmk_parseColor(ext.color);
  if (color === null) color = _dmk_parseColor(json.font_color);
  if (color !== null) message.color = color;

  // 头像用图文混排协议带上（默认关）。注意 text 字段始终保留，即使宿主忽略 segments 也不会丢内容。
  var avatar = __lp_hj_dmk_showAvatar ? _dmk_jsonText(ext.avatar) : "";
  if (avatar) {
    message.segments = [
      { type: "image", url: avatar, width: 20, height: 20, alt: nickname },
      { type: "text", text: " " + text }
    ];
  }
  return message;
}

globalThis.__lp_hj_danmaku = {
  wsURL: __lp_hj_dmk_wsURL,

  async createDanmakuSession(payload) {
    var connectionId = String((payload && payload.connectionId) || "");
    var args = (payload && payload.args) || {};
    var roomId = String(args.roomId || (payload && payload.roomId) || "").trim();
    if (!connectionId) _dmk_throw("INVALID_ARGS", "connectionId is required", { field: "connectionId" });
    if (!/^\d+$/.test(roomId)) _dmk_throw("INVALID_ARGS", "roomId must be numeric", { roomId: roomId });

    var secret = "999" + String(Date.now()) + _dmk_rand(6, true);
    __lp_hj_dmk_sessions[connectionId] = {
      connectionId: connectionId,
      roomId: roomId,
      secret: secret,
      sn: Number(_dmk_rand(10, true)),
      stage: "handshake",
      serverRam: "",
      messages: 0
    };
    return { ok: true, timer: _dmk_timer(false) };
  },

  async onDanmakuOpen(payload) {
    var session = _dmk_session(payload && payload.connectionId);
    session.stage = "handshake";
    return {
      writes: [_dmk_binaryWrite(_dmk_buildHandshake(session))],
      timer: _dmk_timer(false)
    };
  },

  async onDanmakuFrame(payload) {
    var session = _dmk_session(payload && payload.connectionId);
    var frameType = String((payload && payload.frameType) || "");
    var writes = [];
    var messages = [];

    if (frameType !== "binary") {
      return { writes: writes, messages: messages, timer: _dmk_timer(session.stage === "live") };
    }

    var frame = _dmk_bytesFromBase64(payload && payload.bytesBase64);
    if (!frame.length) {
      return { writes: writes, messages: messages, timer: _dmk_timer(session.stage === "live") };
    }

    if (session.stage === "handshake") {
      var handshake = _dmk_parse(_dmk_rc4(frame.slice(6), __lp_hj_dmk_key));
      var response = _dmk_sub(handshake, 7);
      var initResp = response ? _dmk_sub(response, 10) : null;
      session.serverRam = initResp ? _dmk_text(initResp, 2) : "";
      if (!session.serverRam) {
        _dmk_throw("UPSTREAM", "花椒握手未返回 server_ram", { roomId: session.roomId });
      }
      session.stage = "login";
      writes.push(_dmk_binaryWrite(_dmk_buildLogin(session, session.serverRam)));
      return { writes: writes, messages: messages, timer: _dmk_timer(false) };
    }

    if (session.stage === "login") {
      var loginMsg = null;
      try {
        loginMsg = _dmk_parse(_dmk_rc4(frame.slice(4), session.secret));
      } catch (error) {
        loginMsg = null;
      }
      if (!loginMsg || _dmk_field(loginMsg, 1) !== 200001) {
        try {
          loginMsg = _dmk_parse(_dmk_rc4(frame.slice(4), __lp_hj_dmk_key));
        } catch (error) {
          loginMsg = null;
        }
      }
      if (!loginMsg || _dmk_field(loginMsg, 1) !== 200001) {
        _dmk_throw("UPSTREAM", "花椒登录失败", { roomId: session.roomId });
      }
      session.stage = "join";
      writes.push(_dmk_binaryWrite(_dmk_buildJoin(session)));
      return { writes: writes, messages: messages, timer: _dmk_timer(false) };
    }

    // 进房之后全部是明文帧，前 4 字节为长度前缀。
    if (frame.length === 4) {
      return { writes: writes, messages: messages, timer: _dmk_timer(session.stage === "live") };
    }

    var message;
    try {
      message = _dmk_parse(frame.slice(4));
    } catch (error) {
      return { writes: writes, messages: messages, timer: _dmk_timer(session.stage === "live") };
    }
    var msgid = _dmk_field(message, 1);

    if (session.stage === "join" && msgid === 200011) {
      session.stage = "live";
      return { writes: writes, messages: messages, timer: _dmk_timer(true) };
    }

    if (msgid === 300000) {
      var notify = _dmk_sub(message, 8);
      var info = notify ? _dmk_sub(notify, 1) : null;
      var content = info ? _dmk_field(info, 2) : null;
      if (content && typeof content !== "number") {
        messages = _dmk_parseChatMessage(content);
        session.messages += messages.length;
      }
    }

    return { writes: writes, messages: messages, timer: _dmk_timer(session.stage === "live") };
  },

  async onDanmakuTick() {
    // 花椒用 4 字节全 0 保活；进房前不发心跳。
    return { writes: [{ kind: "binary", bytesBase64: "AAAAAA==" }], timer: _dmk_timer(true) };
  },

  async destroyDanmakuSession(payload) {
    var id = String((payload && payload.connectionId) || "");
    delete __lp_hj_dmk_sessions[id];
    return { ok: true, timer: _dmk_timer(false) };
  }
};
