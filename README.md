# pi WeChat Agent 扩展

在**微信里查看 pi agent 的执行结果（只推最终结果，不含中间过程）**，直接**回复消息下发命令**。
使用微信给 OpenClaw 开放的官方 bot 接口（腾讯 iLink），**扫码即可绑定**，无需注册公众号/开放平台。

## 功能

- **扫码绑定**：终端执行 `/wx`，用手机微信扫描终端中的二维码并确认，即完成绑定；凭据持久化到本地，重启自动恢复连接
- **结果推送**：pi 每次任务结束后，自动把最终 assistant 回复推送到微信（不含工具调用、思考等中间过程；长文本自动分段）
- **远程下发命令**：微信里直接发文本，作为任务下发给 pi（agent 忙时自动排队）；任务结束推送结果
- **内置微信命令**：
  | 发送 | 作用 |
  |------|------|
  | `帮助` | 查看命令列表 |
  | `状态` | 查看 pi 忙碌状态 / 模型 / 会话 |
  | `停止` | 中断 pi 当前任务 |
  | `静默` | 切换推送模式（开启后仅微信下发的任务回结果） |
  | `解绑` | 解除绑定并清除本地凭据 |

## 终端命令

| 命令 | 作用 |
|------|------|
| `/wx` | 扫码绑定（已绑定时提示） |
| `/wx status` | 查看通道状态 |
| `/wx stop` | 停止通道 |
| `/wx reconnect` | 接管连接（从其他 pi 实例抢过来，原实例自动退出） |
| `/wx unbind` | 解绑并清除本地凭据 |
| `/wx widget [on\|off]` | 开关输入框上方的微信状态提示 |
| `/wx help` | 显示子命令帮助（输入 `/wx ` 也有自动补全） |

## 安装

方式一（推荐）：放入全局扩展目录：

```bash
mkdir -p ~/.pi/agent/extensions
cp -r weixin-agent ~/.pi/agent/extensions/
# 或使用软链接： ln -sfn $(pwd)/weixin-agent ~/.pi/agent/extensions/weixin-agent
```

方式二：项目本地 `.pi/extensions/`，或 `pi -e ./weixin-agent` 快速测试。

安装后在扩展目录执行 `npm install`（依赖 `qrcode` 用于终端渲染二维码），重启 pi 或执行 `/reload`。

## 使用流程

1. 启动 pi，执行 `/wx`
2. 终端显示二维码（下方附备用链接），用微信扫码
3. 首次绑定时按提示输入手机微信上显示的验证码
4. 绑定成功后微信收到欢迎消息，之后即可：
   - 微信发「跑一下测试并总结失败原因」→ pi 执行 → 微信收到最终结果
   - 在电脑前让 pi 干活，人在微信里收到完成通知与结果

## 多实例说明

同一台电脑跑多个 pi 实例时，微信连接**同一时间只属于一个实例**（锁文件 `~/.pi/agent/weixin/owner.json`）：

- 后启动的实例不会重复连接，终端会提示当前持有者
- 想把连接切到某个实例：在该实例里执行 `/wx reconnect` 接管，原实例下次轮询时自动退出
- 每条结果推送都带 `[会话名]` 前缀，可区分来自哪个实例/项目
- 微信下发的任务只会被持有连接的实例执行，不会重复跑

## 文件位置

- 凭据与状态：`~/.pi/agent/weixin/`
  - `credentials.json` — bot 凭据（token，权限 0600，**请勿外泄**）
  - `syncbuf.txt` — 消息同步游标（避免重启后重复拉取）
  - `context.json` — 会话上下文令牌（用于主动推送）
  - `settings.json` — 静默开关 / 状态提示开关（`silent` / `widget`）
  - `owner.json` — 连接所有权锁（多实例协调）

## 协议说明

扩展直接实现了微信官方 iLink bot 协议（与腾讯 `@tencent-weixin/openclaw-weixin` 插件同源）：

- 扫码：`POST /ilink/bot/get_bot_qrcode` + `GET /ilink/bot/get_qrcode_status`（固定服务 `ilinkai.weixin.qq.com`）
- 收发：`POST /ilink/bot/getupdates`（长轮询）、`/ilink/bot/sendmessage`、`/ilink/bot/msg/notifystart|notifystop`

## 注意事项

- 结果推送依赖微信侧窗口机制：绑定后请保持与 bot 有过交互；长时间未交互后主动推送可能被微信限制（重新发一条消息即可恢复）
- 暂仅支持文本消息（图片/语音/文件收发可基于 `ilink.ts` 中的 CDN 协议扩展）
- bot token 是敏感凭据，`credentials.json` 不要提交到代码仓库
