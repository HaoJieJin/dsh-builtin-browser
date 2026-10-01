# DSH 内置浏览器

> 由 AI 完全操控、运行在 DSH 虚拟屏后台、功能等同普通浏览器的内置浏览器。
> 实现日期：2026-10-01

**🌐 [English](README.md) | [简体中文](README.zh-CN.md)**

## 架构
```
AI（本助手）
  └─ bash 调用 browser.sh（自带桥接自愈）
       └─ browser.js（Node + ws，CDP 协议）
            └─ cdp-bridge.js（adb 协议桥：tcp:9222 ↔ localabstract:chrome_devtools_remote）
                 └─ Chrome（运行在 DSH 虚拟屏，不占主屏）
```
- 浏览器本体：设备上的 **Chrome**（com.android.chrome）
- 后台运行：DSH 虚拟屏（`android_vscreen_create` + `android_vscreen_launch`）
- 控制通道：CDP（Chrome DevTools Protocol），DOM 级精确控制

## 快速启动
1. 创建虚拟屏并启动 Chrome（AI 操作）：
   - `android_vscreen_create`（portrait）
   - `android_vscreen_launch com.android.chrome`
2. 启动桥接（AI 操作）：
   - `sh browser-control/start-bridge.sh`
3. 验证：
   - `curl http://127.0.0.1:9222/json/version` 应返回 Chrome 版本信息

## 命令参考（AI 通过 bash 调用）
入口：`sh browser-control/browser.sh <命令> [参数] [--tab <id>]`

| 命令 | 说明 | 示例 |
|---|---|---|
| `list` | 列出所有标签页 | `sh browser.sh list` |
| `open <url>` | 新建标签页打开网址 | `sh browser.sh open 'https://example.com'` |
| `navigate <url> [--tab id]` | 在指定/当前标签页导航 | `sh browser.sh navigate 'https://...' --tab 14` |
| `click <selector> [--tab id]` | 真实鼠标事件点击元素 | `sh browser.sh click '#su' --tab 14` |
| `type <selector> <text> [--tab id]` | 聚焦输入框并输入文字 | `sh browser.sh type '#index-kw' '关键词' --tab 14` |
| `screenshot [path] [--tab id]` | 截图保存 PNG | `sh browser.sh screenshot /sdcard/xxx.png --tab 14` |
| `text [--tab id]` | 读取页面标题与可见文本 | `sh browser.sh text --tab 14` |
| `eval <js> [--tab id]` | 执行任意 JS | `sh browser.sh eval 'return document.title;'` |
| `back / forward / reload [--tab id]` | 后退 / 前进 / 刷新 | `sh browser.sh back --tab 14` |
| `new_tab <url>` | 新建标签页 | `sh browser.sh new_tab 'https://...'` |
| `close_tab <id>` | 关闭标签页 | `sh browser.sh close_tab 14` |

输出均为 JSON（`{"ok":true,...}` 或 `{"ok":false,"error":"..."}`）。

## 自愈机制
`browser.sh` 每次调用前自动检查桥接健康（`/json/version`），不健康则自动重启 `cdp-bridge.js`。
Chrome 若被强制停止或系统回收，需要重新 `android_vscreen_launch com.android.chrome` 再调用 `start-bridge.sh`。

## 关键文件
```
browser-control/
├── cdp-bridge.js     # adb 协议桥（tcp:9222 ↔ Chrome abstract socket）【核心】
├── browser.js        # CDP 控制层（ws 直连，无需第三方 CDP 库）
├── browser.sh     # 控制入口（带自愈）
├── start-bridge.sh  # 桥接启动脚本
├── adb-forward.js    # 实验性：直连 adbd 的 host:forward（已被 cdp-bridge 取代，保留参考）
└── package.json    # 依赖：chrome-remote-interface
```

说明：`browser.js` 使用 `chrome-remote-interface` npm 包，首次使用请在 `browser-control/` 下执行 `npm install`（或直接使用 DSH 内自带副本）。

## 已验证功能（2026-10-01 实测）
- ✅ 打开网页（example.com / baidu.com）
- ✅ 输入文字（百度搜索框）
- ✅ 提交表单/点击（百度搜索）
- ✅ 前进/后退（百度结果页 ↔ 首页）
- ✅ 截图（CDP 截图保存 PNG，渲染正常）
- ✅ 读取页面文本/DOM
- ✅ 多标签（list / new_tab / close_tab）
- ✅ 后台运行（虚拟屏，不占主屏）

## 注意事项
- Chrome 的 devtools 服务器对异常连接较敏感：**避免并发/频繁连接**，命令间隔 1-2 秒。
- 若 Chrome 卡死（`/json` 无响应）：`am force-stop com.android.chrome` → 重新 `android_vscreen_launch com.android.chrome` → `start-bridge.sh`。
- 当前 Chrome 会恢复用户之前的浏览会话（标签页），不要随意关闭用户原有的标签页。

## License
MIT © 2026 HaoJieJin