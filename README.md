# 花椒直播 · AngelLive 插件

给 [AngelLive](https://github.com/pcccccc/AngelLive) 用的花椒直播（huajiao.com）插件。
纯 JS 实现，跑在宿主的 JavaScriptCore 里，**不改一行原生代码**。

## 订阅（推荐）

App 里进「插件管理 → 添加订阅源」，填：

```
https://willrao.github.io/AngelLive-huajiao-plugin/index.json
```

然后安装「花椒直播」平台即可。

> **网络不通 `github.io` 时**，可以换成同一份索引的 CDN 镜像：
> ```
> https://cdn.jsdelivr.net/gh/WillRao/AngelLive-huajiao-plugin@main/docs/index.json
> ```
> 插件包本身已经配了 Pages + jsDelivr 三条下载线路（`zipURLs`），
> 客户端会按顺序逐个尝试、逐个校验 sha256，哪条通用哪条。

### ⚠️ 不要手动拷贝文件进插件目录

App 会拿 `Application Support/LiveParse/plugins/` 和已配置的订阅源做比对，
**不在任何订阅源里的目录会被当成「孤儿插件」自动卸载**
（见 `PluginSourceManager.installedSandboxPluginIds`）。
安装后确实会落到 `<Application Support>/LiveParse/plugins/huajiao/1.0.0/`，
但请让 App 自己去写。

## 能力

| 能力 | 状态 | 说明 |
|---|---|---|
| 分类 | ✅ | 取自花椒官方 H5 配置，实测返回 6 个分类 |
| 房间列表 | ✅ | 含 `guid` 签名与 JSONP 解包，支持分页 |
| 房间详情 | ✅ | |
| 开播状态 | ✅ | 下播/不存在 → `0`，在播 → `1`，回放 → `2` |
| 取流 | ✅ | HLS(`m3u8`) 优先 + FLV 兜底，两条线路均实测 HTTP 200 |
| 分享链接解析 | ✅ | 支持 `liveid=` 链接、`h.huajiao.com/l/...`、纯房间号 |
| 弹幕 | ✅ | `Host.ws` 上自建 protobuf + RC4 状态机，文本聊天 + 进场提示 |
| 搜索 | ❌ | 花椒没有公开搜索接口（`search` 返回空数组而非报错） |

## 仓库结构

```
AngelLive-huajiao-plugin/
├── manifest.json              插件清单（宿主入口）
├── index.js                   主入口：分类/列表/详情/取流/分享
├── danmaku.js                 弹幕驱动（preload，含 protobuf 与 RC4 实现）
├── docs/                      发布产物 —— GitHub Pages 直接服务这个目录
│   ├── index.json             订阅源索引
│   ├── huajiao-<version>.zip  插件包
│   └── .nojekyll              关掉 Pages 的 Jekyll 处理
├── .github/workflows/pack.yml 改了源码就自动重打包并提交 docs/
└── dev/                       开发与验证工具（不参与打包）
    ├── host-shim.mjs          在 Node 里仿真 Host.* 与 Host.ws
    ├── json-scan.mjs          独立 JSON 扫描器（回放测试的 oracle）
    ├── verify.mjs             HTTP 能力在线验证
    ├── verify-danmaku.mjs     弹幕在线端到端验证
    ├── verify-parser.mjs      弹幕解析离线回放验证
    ├── capture-fixture.mjs    录制新的弹幕夹具
    ├── pack.mjs               打包 + 生成订阅源索引
    └── fixtures/              真实抓包夹具
```

## 发新版本

1. 改 `manifest.json` 里的 `version`（和 `changelog`），改源码。
2. 提交推送。**CI 会自动重打包并提交 `docs/`**，Pages 随即更新，不用管别的。

想本地先看效果：

```bash
node dev/pack.mjs          # 产出到 docs/，索引里直接是本仓库的 Pages 地址
```

打包是**可复现**的（mtime 固定成 2020-01-01 + 文件名排序），同一份源码每次产出同一个
sha256，所以文档里写的哈希不会因为重打包而失效——CI 和本地跑出来也是一致的。

> 如果你 fork 了这个仓库，记得把 `dev/pack.mjs` 顶部的 `PAGES_BASE` 和
> `MIRROR_TEMPLATES` 里的 `WillRao/AngelLive-huajiao-plugin` 换成你自己的。
> 换成别的托管地址时用 `HJ_BASE_URL`：
> ```bash
> HJ_BASE_URL=https://你的域名/路径/ node dev/pack.mjs
> ```
> `zipURL` 必须是**绝对地址**：宿主用 `URL(string:)` 把它直接丢给 URLSession 下载
> （`LiveParsePluginUpdater`），不会按 `index.json` 的地址去补全相对路径。

## 本地验证

三个脚本，都不需要把插件装进 App：

```bash
# 1) HTTP 能力：分类 / 列表 / 详情 / 状态 / 取流 / 分享
node dev/verify.mjs
node dev/verify.mjs rooms 唱歌 --page2      # 指定分类并验证翻页
HJ_ROOM_ID=350413328 node dev/verify.mjs    # 指定房间

# 2) 弹幕端到端（要联网，真连花椒 WS）
HJ_DURATION=70 node dev/verify-danmaku.mjs 350413328
HJ_VERBOSE=1 node dev/verify-danmaku.mjs    # 打印每次 WS 收发

# 3) 弹幕解析离线回归（不联网，用夹具回放）
node dev/verify-parser.mjs
```

`verify-parser.mjs` 是**最重要**的一个。弹幕解析的 bug 是静默的——比如把 JSON 取值
误用成 protobuf 字段读取器时不会抛错，只会一条消息都不产出。夹具回放能在断网、
或者手头没有活跃直播间的时候守住这条线。

### 重新录制夹具

花椒的 msgcontent 结构会变，夹具也可能过期。换一个**说话人多**的房间重新录：

```bash
node dev/capture-fixture.mjs 350413328 90    # 房间号 秒数
```

抓包脚本会记录从握手响应开始的全部入站帧，回放给驱动状态机即可复现整个会话。
注意它同时保存了抓包那一刻的**会话密钥**（登录响应按它做 RC4），
`verify-parser.mjs` 会把密钥注入回去——否则登录帧解不开。

## 花椒协议速查

### HTTP

| 用途 | 请求 |
|---|---|
| 分类 | `GET https://setting.huajiao.com/config/multi?platform=web&version=1.0&module=h5_web_tab_setting` |
| 房间列表 | `GET https://live.huajiao.com/feed/getLives?...`（JSONP） |
| 详情/取流 | `GET https://h.huajiao.com/api/getFeedInfo?sid=<ms>&liveid=<relateid>` |

列表接口有三个坑：

1. **必须带 `guid` 签名**，否则返回 `{"errno":1004,"errmsg":"不能重复请求"}`：
   `guid = md5("platform=ios" + "rand=" + rand + "time=" + time + "userid=" + "version=7.0.0" + "eac63e66d8c4a6f0303f00bc76d0217c")`
2. **响应是 JSONP 包裹**（`cb({...})`），需要剥壳；错误时可能是裸 JSON。
3. **`tag_` 前缀不是装饰**。`name=tag_唱歌` 返回 30 条，`name=唱歌` 返回 0 条
   （但 `颜值` 不带前缀也能用，别一概而论）。

分类配置接口是 `form-urlencoded` / GET，用 JSON body POST 会返回空 `data:{}`。

### 房间号语义

真实房间号是 `feed.relateid`，对应 `https://h.huajiao.com/l/index?liveid=<relateid>`。

### 开播状态（这里踩过一个大坑）

花椒**所有在播房间**的 `feed.mode` 都是 `"video"`，它表示「视频形态直播」而非录播。
早期版本把它当成录播判据，导致在线房间全被标成「录播」。抽样 120 个在播房间
（6 个分类）验证：`type=1`、`replay_status=0`、`mode="video"` 三项**完全一致**。

结论：只用 `feed.replay_status === "1"` 判回放。`dev/verify.mjs` 里为此加了
回归断言「热门榜房间判为直播中(1)」。

### 取流

`live.pull_m3u8` 与 `live.main` 是同一个 HLS 地址；`live.h264_url` 与 `feed.pull_url`
是同一个 FLV 地址。两条都实测可用。

花椒当前推的是 **H.265**，HLS 是标准 MPEG-TS 分片。插件把 HLS 排在第一位：
AVPlayer/KSPlayer 原生解封装最稳，FLV(H.265) 需要 FFmpeg 兜底。

m3u8 里的分片是**裸文件名**（没有 scheme），标准 HLS 客户端会按播放列表所在目录解析，
实测能正常取到分片（HTTP 200, `video/MP2T`）。

### 弹幕

`wss://bridge.huajiao.com`，protobuf(proto2) + RC4。三个必须对齐的点：

1. `Message.Request` 是**外层字段 6**，`init_login_req=9` / `login=2` / `service_req=11`
   都在它里面。漏掉外层会把 req 当成 Message 一级字段，服务端直接 `1006` 断连。
2. 握手响应从**第 6 字节**开始 RC4（前 2 字节 flag + 4 字节 0）；登录响应从**第 4 字节**
   开始（4 字节长度前缀）。登录之后的帧（进房响应、弹幕推送）都是**明文**。
3. 进房响应是 `Response.service_resp(12)` → `Service_Resp.response(2)` → `ChatRoomPacket`
   三层。

会话密钥 `secret = "999" + 毫秒时间戳 + 6 位随机数字`；`verf_code = md5(secret + "360tantan@1408$")[24:]`。

参考实现见 [wbt5/real-url](https://github.com/wbt5/real-url) 的 `danmu/danmaku/huajiao.proto` 与 `huajiao.py`
（本插件的字段层级与它一致，只是按宿主 `plugin_js_v1` 驱动契约重写）。

#### 弹幕消息类型

msgcontent 是一段 JSON，用 `type` 区分子类型：

| type | 含义 | 处理 |
|---|---|---|
| `9` | 文本聊天 | 显示 |
| `10` | 进场 | 显示为「加入了直播间」 |
| `16` | 退场 | 忽略（消息里没有昵称） |
| `30` / `399` / `415` | 礼物 | 默认关，秀场房间会很吵 |
| `104` / `235` / `270` / `282` / `290` / `159` | 榜单、活动角标、粉丝团 | 忽略 |

注意 `type` 有时是**数字**（`9`）有时是**字符串**（`"399"`），统一 `String()` 再比。
另外有些类型的 `text` 是**对象**而不是字符串（如 `104`），取值前必须挡掉。

## 调参

弹幕的显示开关都在 `danmaku.js` 顶部：

```js
var __lp_hj_dmk_showJoin   = true;  // 进场提示
var __lp_hj_dmk_showGift   = false; // 礼物播报
var __lp_hj_dmk_showAvatar = false; // 弹幕前插头像图（图文混排，每条都要拉外链）
```

## 已知限制

- **没有搜索。** 花椒未开放公开搜索接口，`search` 固定返回空数组（不抛错，避免拖垮
  宿主的多平台并发搜索）。进房只能靠分类列表、房间号或分享链接。
- **「推荐」分类当前是空的。** 这是花椒服务端的行为，不是插件问题：`tag_jingxuan`
  被归一化成 `jingxuan` 后 `total: 0`。分类列表取自官方配置，所以仍保留该项。
- **弹幕的 `partial → available` 依据**：握手/登录/进房/收消息全流程已对着真实服务验证
  通过，离线夹具也能稳定复现。但尚未在真机上跑过，首次上机建议用
  `HJ_DURATION=70 node dev/verify-danmaku.mjs <房间号>` 先确认你所在网络能连通
  `wss://bridge.huajiao.com`。
- 花椒房间的弹幕密度差异很大。热门秀场房可能 70 秒内一条文本聊天都没有
  （全是进场和礼物），这时「收到弹幕消息」的验证会失败，换个房间即可——不是插件的问题。

## 致谢

- [AngelLive](https://github.com/pcccccc/AngelLive) —— 宿主，插件系统的契约来自它的
  `Shared/AngelLiveCore/Sources/AngelLiveCore/LiveParse/Plugin/`。
- [wbt5/real-url](https://github.com/wbt5/real-url) —— 花椒弹幕的 proto 定义与参考实现。
