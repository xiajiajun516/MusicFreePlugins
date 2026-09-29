# MusicFree 聚合音源插件

一个 **非官方** 的 MusicFree 兼容插件，用于聚合多个公开音乐服务的歌曲、专辑、歌手和歌单检索结果，并支持歌词、歌单/单曲导入与播放地址获取。

> 本项目基于 [guoyue2010/lxmusic-](https://github.com/guoyue2010/lxmusic-) 改编并适配 MusicFree 插件接口，不是 MusicFree 或任何音乐服务的官方项目。

## 功能

- 多来源音乐检索与交叉展示（网易云、酷我、Audius），每个来源可单独开关
- 支持歌曲、专辑、歌手、歌单搜索
- 支持导入网易云音乐歌单或单曲链接/ID
- 支持歌词获取
- 支持在 MusicFree 中配置可选的自定义接口

### 当前各来源可用状态

| 来源 | 搜索 | 播放 | 歌单 |
|------|------|------|------|
| 网易云 | ✅ | ✅ | ✅ 全量加载 |
| 酷我 | ✅ | ✅ | ✅ |
| Audius | ✅ | ✅ 全长音频 | ✅ |

> QQ 音乐与酷狗音乐**已从本插件移除**（v3.0.0）。实测播放成功率：QQ 1/6、酷狗 3/12，属于「能搜到但基本播不了」的陷阱来源；移除后其余来源播放成功率均为 100%。相关接口的逆向记录保留在项目技能库中，接口恢复后可重新接入。
>
> Internet Archive 在 v3.1.0 接入过、于 **v4.0.0 移除**：它的音频确实匿名、无风控、为全长 MP3（实测 12/12），但官方检索是**条目级**（一个条目 = 一整场演出，索引不含单曲名），`周杰伦` / `晴天` / `告白气球` 均 0 条，`Shape of You` 召回的是 18 分钟 jam —— 属于「取流合格但检索不合格」的来源。完整实测数据见技能库 `platforms.md` 第 8 节。

**播放解析链（按顺序）**：自定义接口 → 酷我官方 CDN → Audius 官方流（302 → CDN）→ 第三方聚合接口 → **跨源回退**。

> **Audius**（[audius.co](https://audius.co)）是去中心化音乐平台，其公开 API 无需鉴权、无需登录，返回的是**全长音频流**而非试听片段，适合作为独立音乐/电子/嘻哈类曲目的补充来源。
> 搜索会过滤掉 `is_streamable === false` 的曲目；播放时直接返回 `/v1/tracks/{id}/stream` 端点，由播放器跟随 302 到 CDN，避免签名过期。
> 支持曲目 / 音乐人 / 歌单：音乐人走 `/v1/users/search`（官方头像 + 作品数），进艺人页按 user id 精确拉作品；歌单走 `/v1/playlists/search` 与 `/v1/playlists/{id}/tracks`。
> Audius 无歌词接口，该来源歌词为空（跨源回退命中其它平台时仍可取得歌词）。

> **跨源回退**：当某来源自身解析不到直链时，会用「歌名 + 歌手」在其它来源重新定位同一首再解析。
> 回退必须同时满足：归一化歌名完全一致、歌手互相包含、时长差 ≤ 8 秒；任一不满足立即失败，**宁可播不出来也不会串歌**。
> 跨源回退只在另外两个已启用来源里查找同一首；不存在严格匹配时宁可失败，也不会用翻唱/改编版顶替。
> 服务可用性取决于相关服务及其接口；本项目不保证任何来源持续可用。

## 使用

**从网络安装（推荐）：**

在 MusicFree 的插件管理界面选择「从 URL 安装插件」，粘贴以下地址：

```
https://raw.githubusercontent.com/xiajiajun516/MusicFreePlugins/master/musicfree-aggregate-plugin.js
```

安装后可在插件管理中一键更新。

**手动导入：**

1. 下载 `musicfree-aggregate-plugin.js`。
2. 在 MusicFree 的插件管理界面按其支持的方式导入该脚本。
3. 如需配置搜索来源或自定义接口，在 MusicFree 的插件配置中填写对应用户变量。

## 版本与发布

- 版本号写在该脚本的 `version` 字段，遵循语义化版本：**主版本** = 来源集合或用户变量的破坏性变更，**次版本** = 新增来源 / 新能力，**修订号** = 修复。
- 自 `v3.0.0` 起，每次发布都会在仓库打上对应的 `vX.Y.Z` 注解标签，完整变更见 [`CHANGELOG.md`](./CHANGELOG.md)。
- **安装地址永久固定**为仓库根目录的 `musicfree-aggregate-plugin.js`（`srcUrl` 指向 `master` 分支的该路径）。因此该文件不会被移入子目录或改名——否则所有已安装用户的自动更新都会失效。
- 发布前须跑通完整的离线 mock 矩阵与端到端验证。

## 发布内容

公开仓库仅包含插件脚本与相关文档：

- `musicfree-aggregate-plugin.js`
- `LICENSE`
- `NOTICE`
- `README.md`
- `CHANGELOG.md`
- `.gitattributes`
- `.gitignore`

本地验证脚本 `test-aggregate.js` 已通过 `.gitignore` 排除，不随仓库发布。

### 用户变量

| 变量 | 说明 |
| --- | --- |
| `searchSource` | 默认搜索来源：`all`（按下方开关并发聚合，默认）、`netease`、`kuwo` 或 `audius` |
| `enableNetease` | 是否启用网易云：`true`（默认）/ `false`；仅 `searchSource=all` 时生效 |
| `enableKuwo` | 是否启用酷我：`true`（默认）/ `false`；仅 `searchSource=all` 时生效 |
| `enableAudius` | 是否启用 Audius：`true`（默认）/ `false`；仅 `searchSource=all` 时生效 |
| `showBadge` | 是否在歌曲名称后显示来源标签：`true` / `false` |
| `customApiUrl` | 可选的自定义接口模板，支持 `{id}`、`{source}`、`{quality}`、`{keyword}` 占位符 |

> MusicFree 的插件变量**只有文本框**（协议里 `userVariables` 仅含 `key`/`name`/`hint`，界面渲染为 `input`），没有下拉或多选框，因此「启用来源」用 `true`/`false` 文本表示。
> 三个开关全部填 `false` 时会兜底为全部启用，避免插件变得完全搜不到内容。

## 许可证与署名

本项目采用 [Apache License 2.0](./LICENSE)。完整许可证见 [`LICENSE`](./LICENSE)，上游来源与改编声明见 [`NOTICE`](./NOTICE)。

改编来源：<https://github.com/guoyue2010/lxmusic->。

## 免责声明

- 本项目仅提供代码，不托管、存储或分发任何音频内容。
- 使用者应确保自己拥有访问、播放或使用相关内容的合法权利，并遵守所在地法律及相关服务条款。
- MusicFree 及第三方服务名称仅用于说明兼容性或数据来源，不代表官方关联、认可或授权。
- 如有权利人认为本项目内容侵权，请通过 GitHub Issue 联系维护者处理。
