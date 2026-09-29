# MusicFree 聚合音源插件

一个 **非官方** 的 MusicFree 兼容插件，用于聚合多个公开音乐服务的歌曲、专辑、歌手和歌单检索结果，并支持歌词、歌单/单曲导入与播放地址获取。

> 本项目基于 [guoyue2010/lxmusic-](https://github.com/guoyue2010/lxmusic-) 改编并适配 MusicFree 插件接口，不是 MusicFree 或任何音乐服务的官方项目。

## 功能

- 多来源音乐检索与交叉展示（网易云、酷我、QQ、酷狗、Audius）
- 支持歌曲、专辑、歌手、歌单搜索
- 支持导入网易云音乐歌单或单曲链接/ID
- 支持歌词获取
- 支持在 MusicFree 中配置可选的自定义接口

### 当前各来源可用状态

| 来源 | 搜索 | 播放 | 歌单 |
|------|------|------|------|
| 网易云 | ✅ | ✅ | ✅ 全量加载 |
| 酷我 | ✅ | ✅ | ✅ |
| QQ | ✅ | ⚠️ 免费曲目可解析，付费曲目需回退 | ✅ |
| 酷狗 | ✅ | ⚠️ 本平台直链受风控限制，多数经由跨源回退 | ✅ |
| Audius | ✅ | ✅ 全长音频 | ❌（官方无歌单概念） |

**播放解析链（按顺序）**：自定义接口 → Audius 官方流（302 → CDN）→ 酷我官方 CDN → QQ vkey 直链 → 第三方聚合接口 → **跨源回退**。

> **Audius**（[audius.co](https://audius.co)）是去中心化音乐平台，其公开 API 无需鉴权、无需登录，返回的是**全长音频流**而非试听片段，适合作为独立音乐/电子/嘻哈类曲目的补充来源。
> 搜索会过滤掉 `is_streamable === false` 的曲目；播放时直接返回 `/v1/tracks/{id}/stream` 端点，由播放器跟随 302 到 CDN，避免签名过期。

> **跨源回退**：当某来源自身解析不到直链时，会用「歌名 + 歌手」在其它来源重新定位同一首再解析。
> 回退必须同时满足：归一化歌名完全一致、歌手互相包含、时长差 ≤ 8 秒；任一不满足立即失败，**宁可播不出来也不会串歌**。
> 酷狗与 QQ 的官方直链对匿名请求存在风控限制（酷狗实测会下发验证码挑战），因此这两源的部分曲目依赖跨源回退或 `customApiUrl`。
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

## 发布内容

公开仓库仅包含插件脚本与相关文档：

- `musicfree-aggregate-plugin.js`
- `LICENSE`
- `NOTICE`
- `README.md`
- `.gitignore`

本地验证脚本 `test-aggregate.js` 已通过 `.gitignore` 排除，不随仓库发布。

### 用户变量

| 变量 | 说明 |
| --- | --- |
| `searchSource` | 默认搜索来源：`all`、`netease`、`kuwo`、`tencent` 或 `kugou` |
| `showBadge` | 是否在歌曲名称后显示来源标签：`true` / `false` |
| `customApiUrl` | 可选的自定义接口模板，支持 `{id}`、`{source}`、`{quality}`、`{keyword}` 占位符 |

## 许可证与署名

本项目采用 [Apache License 2.0](./LICENSE)。完整许可证见 [`LICENSE`](./LICENSE)，上游来源与改编声明见 [`NOTICE`](./NOTICE)。

改编来源：<https://github.com/guoyue2010/lxmusic->。

## 免责声明

- 本项目仅提供代码，不托管、存储或分发任何音频内容。
- 使用者应确保自己拥有访问、播放或使用相关内容的合法权利，并遵守所在地法律及相关服务条款。
- MusicFree 及第三方服务名称仅用于说明兼容性或数据来源，不代表官方关联、认可或授权。
- 如有权利人认为本项目内容侵权，请通过 GitHub Issue 联系维护者处理。
