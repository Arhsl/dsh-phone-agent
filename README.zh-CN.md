# dsh-phone-agent

**让你的 AI Agent 真正能用你的安卓手机。**

多数"手机自动化"要么依赖 ADB 数据线，要么依赖 root。这个插件换了一条路：
手机上跑一个无障碍服务，Agent 通过局域网和它对话。Agent 拿到的是**节点树**——
文字、控件类型、是否可点、中心坐标——和人看到的界面结构一致，然后按同样的
方式点按、滑动、输入、启动应用。

```
   ┌─────────────┐   一个 JSON 请求     ┌──────────────────┐
   │  DSH Agent  │ ────────────────────► │  DSH-phone 应用  │
   │   （电脑）  │ ◄──────────────────── │  无障碍服务      │
   └─────────────┘   一个 JSON 响应      │  TCP 8790        │
          ▲                              └──────────────────┘
          │  工具：phone_screen、        ┘
          │  phone_click、phone_task …
          └─────────────────────────────
                          读屏 → 决策 → 动作 → 确认
```

## 为什么做这个

Agent 的天然循环是 **读屏 → 决策 → 动作 → 再读屏 → 确认**。走命令行的话，
每一轮都是 `adb shell input tap 540 1200`，再解析一次 `uiautomator dump`——
一次进程启动、一个文本格式解析器、一堆容易碎的正则。做成工具调用之后，一轮
就是一次结构化请求。

让它真正能用、而不只是"理论上可行"的，是三个细节：

**可读的节点树。** `phone_screen` 每个节点一行：`#编号`、文字、控件类型、
可点/可输入/可滚动标记、中心坐标。模型挑编号，不猜像素。

**等待而不是睡眠。** `phone_wait` 轮询条件（`text` 出现、`gone` 消失、
`pkg` 变成前台），条件一满足立刻返回。截图之后 sleep 猜时间，是自动化变得
不稳的常见原因，这里直接去掉。

**失败要留下现场。** `phone_task` 在一个进程里跑完整串步骤，传输抖动自动
重试，失败时先把截图和界面树落盘再停。结束还会把手机切回 DSH 界面，不会把
设备丢在半路。

## 手机端

没有 APK，工具是空的。APK 单独发布（见 Releases），源码在作者工作区的
`dsh-phone-app` 目录。

1. 装上 APK，授予无障碍权限
2. 打开应用，点 **开始保活**——不开的话系统会回收进程，Agent 直接掉线
3. 从 返回键菜单 → 「手机 Agent」面板复制**配对令牌**
4. 把手机地址和令牌写进 `$DSH_HOME/.phone-agent.json`：

```json
{ "host": "192.168.1.20", "token": "<令牌>", "port": 8790 }
```

手机和电脑要在同一个网络。手机开热点、电脑连上去就行，普通 Wi-Fi 也可以。

> **截图需要 Android 11 以上。** `takeScreenshot` 需要 API 30。其他工具在
> 更老的版本上都能用。

## 安装

```bash
# 在 DSH 的 profile 目录里
npm install dsh-phone-agent
```

然后加进 profile 的 bundle 列表（`package.json`）：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["dsh-phone-agent"]
    }
  }
}
```

重启 DSH，工具会以 `phone_*` 出现在 Agent 的工具集里。

## 工具

| 工具 | 作用 |
|---|---|
| `phone_ping` | Agent 在不在线？型号、屏幕尺寸、构建、pid、存活时长 |
| `phone_screen` | 读节点树（编号、文字、类型、标记、中心坐标） |
| `phone_screenshot` | 截图为 PNG 存档 |
| `phone_wait` | 等文字出现/消失，或等某个包变前台 |
| `phone_click` | 按编号、按文字、按坐标点按；支持长按 |
| `phone_text` | 往输入框写字 |
| `phone_swipe` | 滑动，可带路径形状 |
| `phone_key` | back / home / recents / notifications |
| `phone_apps` | 列出可启动应用 |
| `phone_open` | 按包名或应用名启动 |
| `phone_task` | 一次跑完整串步骤，一个进程，出一份报告 |

### `phone_screen` 和 `phone_screenshot` 的区别

| | 拿到什么 | 用来干什么 |
|---|---|---|
| `phone_screen` | 控件树：文字、编号、可点性 | 找东西来点 |
| `phone_screenshot` | PNG 像素 | 图片、颜色、游戏、验证码 |

编号只在**一次**读屏内有效。界面变了要重新读——拿旧编号点，就会点到别的地方。

### `phone_task`

给"说完就走开、回来收报告"这种场景：

```json
{
  "name": "发消息",
  "steps": [
    { "op": "open", "name": "微信" },
    { "op": "wait", "pkg": "com.tencent.mm" },
    { "op": "click", "text": "搜索" },
    { "op": "text", "value": "妈妈" },
    { "op": "wait", "text": "妈妈" },
    { "op": "click", "text": "妈妈" },
    { "op": "text", "value": "到家了" },
    { "op": "click", "text": "发送" },
    { "op": "shot", "path": "done.png" }
  ]
}
```

支持的操作：`open`、`click`、`longclick`、`text`、`swipe`、`key`、`wait`、
`assertText`、`screen`、`shot`、`sleep`；任意一步加 `optional: true` 可在
失败后继续。

相邻的、**目标已经确定**的步骤会合并成一次请求——实测每步固定开销约
270ms，十步的任务因此省下 2~3 秒。"要先读屏再决定"的步骤永远不合并：
那正是模型推理发生的地方。

## 配置

任一项都支持四个来源，逐字段取第一个命中的：

| 顺序 | 来源 |
|---|---|
| 1 | `cordis.patch.yml` 里的插件 config |
| 2 | `DSH_PHONE_HOST` / `DSH_PHONE_TOKEN` / `DSH_PHONE_PORT` |
| 3 | `$DSH_HOME/.phone-agent.json` |
| 4 | `./.phone-agent.json` |

推荐用凭据文件，不要把令牌写进可能被提交的 YAML。

**令牌等于手机的控制权。** 它在调用时从磁盘读取，不写日志、不进错误信息，
请求也只会发往配置的地址——任何工具参数都无法改变目标。

## 不用 Agent，直接用命令行

调试时很有用，工具都有对应的命令行形态：

```bash
node vendor/phone-task.mjs task.json
node vendor/phone-task.mjs --inline '{"steps":[{"op":"screen"}]}'
```

任务产物（截图、失败现场、日志）落在**当前目录**下的
`./phone-tasks/<时间戳>/`，不会写进包里。

## 开发

```bash
npm test          # 27 个离线测试，不需要手机
npm run smoke     # 连真机跑（需要凭据）
```

测试刻意做成离线的。需要真机的测试等于没人跑的测试，所以这里覆盖的是真正
会坏的部分：请求最后落在哪个 URL、失败怎么措辞、渲染器有没有丢掉编号、
转义能不能原样回来。

## 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 连不上手机 | 息屏、保活停了、无障碍被系统关掉 | 亮屏、重开保活 |
| 令牌被拒 | 应用重置过令牌 | 重新复制一个 |
| `phone_screen` 没有节点 | WebView 未暴露内容，或透明界面 | 改用 `phone_screenshot` |
| 截图返回空 | Android 低于 11，或权限被拒 | API 30 以下不支持 |
| `phone_task` 找不到执行器 | 安装不完整 | 重装；`vendor/phone-task.mjs` 必须在 |

## 兼容性

| DSH 版本 | 状态 |
|---|---|
| `0.2.1-rc.2` | 兼容 |

APK 和插件之间是固定的 JSON 协议；插件里只有 `lib/transport.js` 知道这套协议。

## 许可

MIT，见 [LICENSE](LICENSE)。
