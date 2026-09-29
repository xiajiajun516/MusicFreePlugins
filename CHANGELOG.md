# 更新日志

记录 `musicfree-aggregate-plugin.js` 的对外行为变更。
版本号写在该脚本的 `version` 字段，遵循语义化版本：**主版本** = 来源集合或用户变量的破坏性变更，**次版本** = 新增来源 / 新能力，**修订号** = 修复。

## [4.0.0] - 2026-09-30

### 破坏性变更

- **移除 Internet Archive（`archive`）来源**。该来源只在 v3.1.0–v3.1.1 存在过。
  移除理由：它**取流合格但检索不合格** —— 官方检索是条目级（一个条目 = 一整场演出，索引不含单曲名），实测 `周杰伦` / `晴天` / `告白气球` 均 0 条，`Shape of You` 召回的是名为 "Strange Shape" 的乐队的 18 分钟 jam，`Taylor Swift` 召回的是描述里提到她的别人的录音；另有 "Tuning"（92 分钟）等非歌曲条目与音轨标题缺失（回落文件名）。完整数据见技能库 `platforms.md` 第 8 节。
- 用户变量 `enableArchive` 随之下线；`searchSource` 的 `archive` 取值一并移除。若此前把 `searchSource` 设为 `archive`，插件会自动回退到全部已启用来源，**不会报错**。
- 来源集合回到三个：`netease` / `kuwo` / `audius`，播放解析链与跨源回退行为与 v3.0.0 完全一致。

## [3.1.1] - 2026-09-30

### 修复

- **Internet Archive 由默认启用改为默认关闭（`enableArchive` 缺省 `false`，需手动填 `true`）。**
  v3.1.0 只验证了「匿名 + 全长 + 可播放」（12/12），但漏掉了「检索结果是否与用户要找的歌相关」这一条。
  补测显示该来源的官方检索是**条目级**（一个条目 = 一整场演出），索引不含单曲名：`周杰伦` / `晴天` / `告白气球` 均返回 **0 条**；`Shape of You` 返回的 5 条全是名为 "Strange Shape" 的乐队的 18 分钟 jam；`Taylor Swift` 返回的 11 条全是描述里提到她的别人的录音。默认开启会污染整页聚合结果。
- 「全部开关填 false」的兜底现在只回退到**默认启用**的来源，不会再顺带打开 `archive`。

> 该来源仍保留（可按现场乐队名检索、音频确为匿名全长），如需彻底移除见下一条建议。

## [3.1.0] - 2026-09-30

### 新增

- 新增 **Internet Archive**（Live Music Archive 馆藏，`archive`）来源：站内公开 JSON 接口、无需鉴权与登录，返回**全长 MP3**。检索走 `services/search/beta/page_production`（`filter_map` 限定 `collection:etree`），再按条目拉 `/metadata/{identifier}` 展开条目内的 MP3 音轨（每条目最多 5 首、每页最多 20 首）；播放直接返回无时效签名的 `https://archive.org/download/{identifier}/{fileName}`，封面走 `https://archive.org/services/img/{identifier}`。
- 新增来源开关 `enableArchive`（`true` / `false`，缺省启用）；`searchSource` 新增可选值 `archive`。
- 实测播放成功率：4 个查询 × 3 条 = **12/12**（`Range: bytes=0-2047` 全部返回 `206` + `audio/mpeg`，`content-range` 总长均为数 MB 级全长音频）。

### 未通过门槛的候选（未接入，实测证据见项目技能库 `platforms.md` 第 8 节）

- Jamendo、KKBOX、SoundCloud、ccMixter、Free Music Archive、StreetVoice、Joox 共 7 个候选未通过「匿名 + 全长 + 稳定」三条门槛。

## [3.0.0] - 2026-09-30

### 破坏性变更

- 移除 **QQ 音乐** 与 **酷狗音乐** 两个来源。实测播放成功率分别为 1/6 与 3/12，属于「能搜到但基本播不了」的来源；移除后其余来源播放成功率均为 100%。
- 若此前把 `searchSource` 设为 `tencent` 或 `kugou`，插件会自动回退到全部已启用来源，**不会报错**。

### 新增

- 按来源开关 `enableNetease` / `enableKuwo` / `enableAudius`，取值 `true` / `false`。MusicFree 的插件变量只有文本框（协议中 `userVariables` 仅含 `key`/`name`/`hint`），没有勾选框，故用文本表达。三个开关全部填 `false` 时兜底为全部启用。
- 跨源回退：某来源解析不到直链时，用「歌名 + 歌手」在其它已启用来源重新定位同一首；必须同时满足歌名完全一致、歌手互相包含、时长差 ≤ 8 秒，否则宁可失败也不串歌。

### 修复

- 酷我：请求强制 IPv4。此前在同时返回 A/AAAA 记录的网络下，Node 走 IPv6 会固定超时，导致酷我搜索返回 0 条且无法播放。

## [2.5.0] - 2026-09-30

### 新增

- Audius 来源补齐音乐人检索（`/v1/users/search`，含官方头像与作品数）、艺人作品（按 user id 精确拉取，避免同名艺人串数据）与歌单检索 / 歌单详情。

## [2.4.0] - 2026-09-30

### 新增

- 新增 **Audius** 来源：公开 API、无需鉴权、返回**全长音频流**而非试听片段，支持曲目 / 音乐人 / 歌单。

## [2.3.5] - 2026-09-30

### 修复

- 播放解析链加入跨源回退（初版）。
- 酷我搜索与播放恢复（搜索 0 → 10 条）。
- QQ 音乐搜索端点由已下线的 `c.y.qq.com/soso/fcgi-bin/client_search_cp` 切换为 `u.y.qq.com/cgi-bin/musicu.fcg`。

## [2.3.4] - 2026-07-31

### 新增

- 酷我直接播放（官方 CDN 接口）。
- 网易云歌单全量加载（200 首）。

## [2.3.3] - 2026-07-30

### 新增

- `srcUrl` 远程安装与一键更新。

### 修复

- 歌单详情分页 `isEnd` 精度。

## [2.3.2] - 2026-07-30

### 变更

- 删除听音（Yaohud）API。

### 新增

- 歌单 / 媒体请求韧性层：TTL 缓存、并发合并、有限重试、逐源失败隔离。

> 2.3.4 及更早条目依据仓库提交记录整理；2.3.5 起为本项目维护期间的实际变更。
