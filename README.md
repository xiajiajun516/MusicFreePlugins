# MusicFree 聚合音源插件

把多个公开音乐服务的检索结果聚合成一份统一列表，并统一提供**播放直链、歌词、歌单**能力。

|  |  |
| --- | --- |
| 当前版本 | `v4.1.1`（以插件 `version` 字段为准） |
| 插件形态 | 单文件 CommonJS，固定位于仓库根目录 `musicfree-aggregate-plugin.js` |
| 运行时依赖 | 仅 `axios`（B 站 wbi 签名所需的 MD5 为插件内置的纯 JS 实现，无额外依赖） |
| 语法约束 | ES8 及以下，兼容 MusicFree 桌面端与手机端的原生 JS 引擎 |
| 音乐来源 | 网易云 · 酷我 · Audius · Bilibili（每个来源可单独开关） |

---

## 安装

### 从 URL 安装（推荐）

在 MusicFree 的「插件管理」中选择 **从 URL 安装插件**，粘贴：

```
https://raw.githubusercontent.com/xiajiajun516/MusicFreePlugins/master/musicfree-aggregate-plugin.js
```

安装后可在插件管理中一键更新（插件内置 `srcUrl`，指向本仓库 `master` 分支的该路径）。

### 手动导入

1. 下载 [musicfree-aggregate-plugin.js](./musicfree-aggregate-plugin.js)；
2. 在 MusicFree 的「插件管理」中按其支持的方式导入该脚本；
3. 如需调整搜索来源或自定义解析接口，在插件配置中填写对应用户变量（见下）。

---

## 功能

- **多来源聚合检索**：歌曲 / 专辑 / 歌手 / 歌单四类搜索，多来源并发拉取后交叉混排，并按「歌名 + 歌手 + 时长分桶」去重
- **播放直链解析**：按来源逐级回退，并附跨源回退（严格同曲匹配）
- **歌词**：网易云歌词，失败时回退第三方聚合接口
- **歌单**：网易云歌单支持全量加载（200 首以上），酷我 / Audius 歌单可直接展开
- **导入**：支持粘贴网易云歌单 ID / 链接、单曲 ID / 链接
- **可配置**：每个来源一个开关；可选自定义解析接口模板

## 支持的来源

| 来源 | 搜索 | 播放 | 歌单 | 歌词 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 网易云 | ✅ | ✅ | ✅ 全量加载 | ✅ | |
| 酷我 | ✅ | ✅ | ✅ | ✅ | 请求强制 IPv4（见「故障排查」） |
| Audius | ✅ | ✅ 全长音频 | ✅ | — | 公开 API，无需鉴权 |
| Bilibili（视频区） | ✅ | ✅ 全长音频（AAC / MP4） | — | — | 需匿名设备 cookie + wbi 签名 |

<details>
<summary><b>各来源实现要点</b></summary>

**网易云** —— 检索走未加密的 `/api/v1/search/get`，歌单详情走 `/api/v6/playlist/detail`，曲目不全时用 `/api/v3/song/detail` 分批补齐（单次最多 500 首）。

**酷我** —— 检索走 `search.kuwo.cn/r.s`，播放走 `antiserver.kuwo.cn/anti.s`。
> ⚠️ Node 在同时返回 A / AAAA 记录的网络下会优先走 IPv6，导致酷我请求固定超时（表现为「搜索 0 条 + 播放失败」）。插件已对酷我请求强制 `family: 4`。

**Audius** —— 去中心化音乐平台，公开 API 无需鉴权与登录，返回**全长音频流**而非试听片段。
> 搜索过滤 `is_streamable === false` 的曲目；播放直接返回 `/v1/tracks/{id}/stream` 端点，由播放器跟随 302 到 CDN，避免签名过期。
> 音乐人走 `/v1/users/search`（官方头像 + 作品数），歌单走 `/v1/playlists/search` 与 `/v1/playlists/{id}/tracks`。该来源无歌词接口。

**Bilibili（视频区）** —— 无需登录。
> 搜索走 `x/web-interface/search/type`，需要一份**匿名设备 cookie**（`buvid3` / `buvid4`，由 `x/frontend/finger/spi` 匿名下发，与登录态无关）。
> 播放：`x/player/pagelist` 取 `cid`（免签名）→ `x/player/wbi/playurl`（**wbi 签名**）取 `dash.audio` 中码率最高的音轨。
> **CDN 直链必须带 `Referer: https://www.bilibili.com/`，否则一律 403** —— 这是本插件唯一需要向播放器下发自定义请求头的来源。
> 音频是 MP4 容器里的 AAC 音轨（`mimeType: audio/mp4`，HTTP 响应头显示 `video/mp4`，URL 无扩展名）。
> 结果里的教程 / 鼓谱 / 伴奏 / KTV / 讲解 / 合集等非歌曲内容会被自动过滤（标题关键词 + 时长 < 30 秒或 > 15 分钟），但 cover、现场版、混剪仍可能排在前面 —— 这是视频站检索的固有噪声。

<details>
<summary>已移除 / 已否决的来源</summary>

| 来源 | 结论 | 原因 |
| --- | --- | --- |
| QQ 音乐 | v3.0.0 移除 | 匿名 vkey 实测 8 首仅 1 首返回 purl，付费曲无直链 |
| 酷狗音乐 | v3.0.0 移除 | 签名已还原，但匿名一律下发验证码（err_code 30020） |
| Internet Archive | v3.1.0 接入 → v4.0.0 移除 | 取流合格（12/12），但官方检索是条目级，主流歌名 0 命中 |
| YouTube / YouTube Music | 否决 | ANDROID_VR 对搜索结果 0/20 返回 `LOGIN_REQUIRED` |
| Jamendo | 否决 | 站内 API 需 `x-jam-call` 签名，缺签名一律 403 |
| KKBOX | 否决 | AWS WAF 人机挑战 |
| SoundCloud | 未接入 | 需从页面 JS 抠 `client_id`（随部署轮换）+ DataDome 风控 |
| ccMixter | 否决 | 响应头 `X-JSON` 超过 Node 16KB `maxHeaderSize`；直链需 Referer |
| Free Music Archive | 否决 | 页面只渲染 consent + 广告，观察不到搜索入口 |
| 5sing / 咪咕 / 9ku / 猫耳FM / Bandcamp / Deezer / iTunes | 否决 | 见下方「来源可用性判定」 |

</details>
</details>

---

## 用户变量

| 变量 | 说明 |
| --- | --- |
| `searchSource` | 默认搜索来源：`all`（按下方开关并发聚合，默认）、`netease`、`kuwo`、`audius` 或 `bilibili` |
| `enableNetease` | 是否启用网易云：`true`（默认）/ `false`；仅 `searchSource=all` 时生效 |
| `enableKuwo` | 是否启用酷我：`true`（默认）/ `false`；仅 `searchSource=all` 时生效 |
| `enableAudius` | 是否启用 Audius：`true`（默认）/ `false`；仅 `searchSource=all` 时生效 |
| `enableBilibili` | 是否启用 Bilibili：`true`（默认）/ `false`；仅 `searchSource=all` 时生效 |
| `showBadge` | 是否在歌曲名后显示来源标签：`false`（默认）/ `true`（附加 [网易] [酷我] [Audius] [B站]） |
| `customApiUrl` | 可选的自定义解析接口模板，支持 `{id}`、`{source}`、`{quality}`、`{keyword}` 占位符 |

> MusicFree 的插件变量**只有文本框**（协议中 `userVariables` 仅含 `key` / `name` / `hint`，界面渲染为 `input`），没有下拉或多选框，因此「启用来源」用 `true` / `false` 文本表示。
> 四个开关全部填 `false` 时会兜底为全部启用，避免插件变得完全搜不到内容。

---

## 播放解析链

解析按以下顺序逐级尝试，任一步成功即返回：

1. **自定义接口**（配置了 `customApiUrl` 时）
2. **来源自身直链**：酷我官方 CDN → Audius 官方流（302 → CDN）→ Bilibili DASH 音轨
3. **第三方聚合接口**（gdstudio / meting）
4. **跨源回退**

**跨源回退**：当某来源自身解析不到直链时，用「歌名 + 歌手」在其它来源重新定位同一首再解析。必须**同时**满足：

- 归一化歌名完全一致
- 歌手互相包含
- 时长差 ≤ 8 秒

任一不满足立即放弃 —— **宁可播不出来，也不会用翻唱 / 改编版顶替**。回退只在**网易云 / 酷我**两个来源里进行，Audius 与 Bilibili 的条目不参与回退匹配。

---

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 某个来源完全搜不到 | 检查 `searchSource` 是否为 `all`，以及对应的 `enableXxx` 是否被填成了 `false` |
| 酷我搜索 0 条、播放失败 | 多为 IPv6 超时；插件已强制 IPv4，若仍复现请反馈网络环境 |
| B 站结果里出现 cover / 现场版 | 视频站检索的固有噪声；插件已过滤教程 / 鼓谱 / 伴奏等，也可把 `enableBilibili` 设为 `false` 关闭该来源 |
| 某来源整体不可用 | 各来源可用性取决于其自身接口；把对应开关设为 `false` 即可隔离，不影响其它来源 |
| 播放失败但搜索正常 | 播放直链有时效性，请重新点击播放（插件不会缓存播放地址） |

### 来源可用性判定

本项目只接纳**同时满足以下四条**的来源，缺一即否决：

1. **匿名可取流** —— 不登录、无用户 cookie，纯 HTTP 请求即可拿到可播放音频
2. **全长而非试听** —— 排除只给 30 秒片段的平台
3. **稳定** —— 接口公开，无风控挑战、无签名（或签名可稳定复算）、无防盗链
4. **检索相关** —— 用主流歌名 / 主流歌手实测 Top-5 召回是否真的是那首歌

> 第 4 条是踩坑后补上的：Internet Archive 曾以「匿名 + 全长 + 稳定」三条全绿接入，但检索是**条目级**（一个条目 = 一整场演出，索引不含单曲名），主流歌名 0 命中，最终于 v4.0.0 移除。**「流能取到」不等于「取到的是用户要找的那首歌」。**

---

## 版本与发布

- 版本号写在插件的 `version` 字段，遵循语义化版本：
  **主版本** = 来源集合或用户变量的破坏性变更 ｜ **次版本** = 新增来源 / 新能力 ｜ **修订号** = 修复
- 每次发布都会在仓库打上对应的 `vX.Y.Z` **注解标签**，并创建对应的 **GitHub Release**（附变更说明）。
  完整变更见 [CHANGELOG.md](./CHANGELOG.md)，历史版本见 [Releases](../../releases)。
- **安装地址永久固定**为仓库根目录的 `musicfree-aggregate-plugin.js`（`srcUrl` 指向 `master` 分支的该路径）。
  该文件不会被移入子目录或改名 —— 否则所有已安装用户的自动更新都会失效。
- 发布前须跑通完整的离线 mock 矩阵与端到端验证。

## 发布内容

公开仓库仅包含插件脚本与相关文档：

- `musicfree-aggregate-plugin.js`
- `LICENSE`
- `README.md`
- `CHANGELOG.md`
- `.gitattributes`
- `.gitignore`

本地验证脚本 `test-aggregate.js` 已通过 `.gitignore` 排除，不随仓库发布。

---

## 许可证与声明

本项目采用 [MIT License](./LICENSE)，可自由使用、修改与再分发（需保留版权声明）。

- 本项目**仅提供代码**，不托管、存储或分发任何音频内容。
- 使用者应确保自己拥有访问、播放或使用相关内容的合法权利，并遵守所在地法律及相关服务条款。
- 如需处理版权或其它问题，请通过 [Issues](../../issues) 联系维护者。
