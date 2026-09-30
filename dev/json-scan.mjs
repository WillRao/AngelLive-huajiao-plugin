// 独立 JSON 扫描器 —— 刻意不复用插件的 protobuf 解析代码。
//
// 它用「花括号配对 + JSON.parse」从报文里把 msgcontent 抠出来，作为回放测试的
// 独立 oracle：如果插件的解析链退化了，这里仍能算出应有的文本弹幕，测试才会失败。
// 被 verify-parser.mjs 和抓包工具共用，避免两份实现漂移。

export function extractJsonObjects(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(text.slice(i, end + 1));
      if (parsed && typeof parsed === "object") out.push(parsed);
    } catch (e) { /* 不是完整 JSON，跳过 */ }
    i = end;
  }
  return out;
}

/// 从一条 base64 报文里找出所有 type=9 的文本弹幕。
export function chatTextsInFrame(base64) {
  let text;
  try {
    text = Buffer.from(String(base64), "base64").toString("utf8");
  } catch (e) {
    return [];
  }
  const found = [];
  for (const obj of extractJsonObjects(text)) {
    if (String(obj.type) === "9" && typeof obj.text === "string" && obj.text.trim()) {
      found.push(obj.text);
    }
  }
  return found;
}

/// 扫一批帧，返回去重后的文本弹幕集合。
export function collectChatTexts(frames) {
  const seen = new Set();
  for (const frame of frames) {
    const base64 = frame && frame.bytesBase64;
    if (!base64) continue;
    for (const text of chatTextsInFrame(base64)) seen.add(text);
  }
  return seen;
}

/// 找出所有「不该弹出来」的噪音类型（退场 / 榜单 / 活动角标等）。
export function collectNoiseTypes(frames) {
  const types = new Map(); // type -> 一条样本文本
  for (const frame of frames) {
    const base64 = frame && frame.bytesBase64;
    if (!base64) continue;
    let text;
    try { text = Buffer.from(String(base64), "base64").toString("utf8"); } catch (e) { continue; }
    for (const obj of extractJsonObjects(text)) {
      const t = String(obj.type);
      if (t === "16" && !types.has(t)) {
        types.set(t, typeof obj.text === "string" ? obj.text : "");
      }
    }
  }
  return types;
}
