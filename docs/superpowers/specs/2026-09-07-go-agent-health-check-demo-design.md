# Go Agent Health Check Demo Design

## Goal

用 Go 写一个可运行的 agent demo，把 agent 的工作原理讲清楚。主导任务是远程主机的日常维护诊断：检查机器健康状况并产出报告。

demo 的核心交付物不是"一个运维工具"，而是**让 agent loop 可见**。观众应该能在终端里看到「模型思考 → 决定调工具 → 世界回答 → 模型再思考」这个循环一轮轮转起来，并理解支撑它的机制其实只是一个 while 循环和一个不断长大的 messages 数组。

## Scope

- Agent 的三阶段编排：plan、execute、report。
- Agent loop 本体，含多轮工具调用、终止条件、步数上限。
- 两个工具：`run_shell`、`http_probe`。
- 只读命令策略（allowlist）作为唯一的安全强制点。
- 通过 SSH 在远程主机执行命令。
- 手写 OpenAI 兼容客户端，含 llama.cpp 的 `reasoning_content` 扩展字段。
- 终端实时 trace 与 markdown 报告两种输出。
- 两个离线测试文件，以及一份讲解原理的 README。

不在本次范围内：任何写操作或修复动作、Web UI、定时调度、多主机编排、与 `apps/electron` 或 `apps/tauri` 的集成。

## Decisions

四个决定在设计开始前已确认：

1. **目标机器是远程 `192.168.3.99`。** Go 程序在本机 macOS 运行，所有健康检查命令通过 SSH 打到 .99 执行。选远程而非本机，是因为 .99 上存在真实故障可供发现（swap 已用 7.3/8.0 GiB、两块 RTX 3090 显存接近满载、两个 llama-server 实例跑同一个模型文件），agent 能"真的查出问题"，demo 才有说服力。
2. **纯只读诊断。** agent 可以查、可以分析、可以给修复建议，但绝不执行任何修复。只读约束在 Go 代码层强制，不依赖模型自觉。
3. **两阶段驱动：LLM 先规划再执行。** 而非完全自由探索，也而非硬编码检查清单。前者容易查散、遗漏关键项，后者会让 agent 退化成"带 LLM 总结的监控脚本"。
4. **输出为终端 trace 加 markdown 报告。** trace 看过程，报告留结果。

一个值得记录的事实：agent 的大脑（qwen3.8）恰好运行在被检查的那台机器上，等于让模型诊断自己的宿主机。这不影响可行性，但报告中的服务存活检查会把 LLM 服务自身也列为检查对象。

## Verified Preconditions

设计依赖的两个技术前提已实测确认，不是假设：

- **单轮 tool calling 可用。** `POST /v1/chat/completions` 带 `tools` 时，qwen3.8 返回 `finish_reason:"tool_calls"`，`arguments` 为合法 JSON，带 `id`。
- **多轮 tool result 回灌可用。** 追加 `role:"assistant"`（含 `tool_calls`）与 `role:"tool"`（含 `tool_call_id`）后再次请求，模型正确消费工具结果，返回 `finish_reason:"stop"` 并给出有内容的分析。这是 agent loop 成立的关键，llama.cpp 配自定义 chat template 时此环节常出问题，已排除。

实测性能（从 macOS 跨网络直连 .99:2081）：

| 场景 | prompt 处理 | 生成 | 端到端 |
|---|---|---|---|
| 短问答，216 tokens | 287.7 tok/s | 73.3 tok/s | 2.29 s |
| 带 tools，609 tokens | 523.4 tok/s | 71.5 tok/s | 2.29 s |
| 工具结果回灌，853 tokens | 572.1 tok/s | 53.4 tok/s | 5.87 s |

生成速度随输出变长而下降，因为 MTP 投机解码的草稿接受率从 96% 掉到 51%——长散文比短答案更难预测。按此推算，20 步的完整 loop 约需 2 分钟。

## Architecture

系统是「一个大脑、一双手、一本账」：

```text
main.go ──装配──> Agent ──┬──> LLMClient  (接缝 1: 大脑)
                          │      └─ 手写 OpenAI 兼容客户端 → qwen3.8:2081
                          │
                          ├──> Executor   (接缝 2: 手)
                          │      ├─ SSHExecutor  → miz@192.168.3.99
                          │      └─ Allowlist    → 只读策略强制点
                          │
                          └──> Trace / Report (账本)
                                 ├─ 终端实时渲染
                                 └─ markdown 落盘
```

`LLMClient` 和 `Executor` 都是接口。这两条接缝是设计的关键：测试时替换成脚本化的假实现，agent loop 的全部行为——多轮收敛、触顶收尾、工具被拒后改口——都能离线、确定性、毫秒级地验证，不碰 .99 也不烧 GPU。

`agent.go` 是唯一有状态的部分，其余文件基本是纯函数或薄 IO 封装。

## File Layout

落点 `tooling/agent-health/`，独立 Go module，跟随现有 `tooling/{modbus,serial,tcp,udp}-test` 的目录约定。不进 npm workspaces。

扁平单包，每个文件一个明确职责，没有超过 200 行的文件：

| 文件 | 职责 | 大致行数 |
|---|---|---|
| `main.go` | flag/env 解析、配置结构体、装配依赖、启动 | ~140 |
| `agent.go` | 三阶段编排与 agent loop，重注释 | ~200 |
| `tools.go` | 两个工具的 schema 定义、分发、参数校验 | ~120 |
| `allowlist.go` | 只读命令策略 | ~130 |
| `exec.go` | `Executor` 接口与 `SSHExecutor` 实现 | ~110 |
| `llm.go` | `LLMClient` 接口、HTTP 实现、请求响应类型 | ~180 |
| `trace.go` | Trace 事件模型与终端渲染 | ~100 |
| `report.go` | markdown 报告渲染 | ~90 |
| `allowlist_test.go` | 命令策略表驱动测试 | ~120 |
| `agent_test.go` | 假 LLM 加假 Executor 驱动的 loop 测试 | ~280 |
| `README.md` | 原理讲解、带注释的真实 trace、运行方式 | — |
| `.gitignore` | 忽略 `reports/` | — |

配置不设独立文件，直接放在 `main.go` 中——配置本身没有教学价值，少一个文件就少一次跳转。

## Configuration

默认值烧进代码，因此除两个凭据外 `go run .` 即可运行：

| flag | 默认值 | env |
|---|---|---|
| `--host` | `192.168.3.99` | `INEED_AGENT_HOST` |
| `--user` | `miz` | `INEED_AGENT_USER` |
| `--password` | 无，必填 | `INEED_SSH_PASSWORD` |
| `--llm-url` | `http://192.168.3.99:2081/v1` | `INEED_LLM_URL` |
| `--llm-key` | 无，必填 | `INEED_LLM_KEY` |
| `--model` | `qwen3.8` | `INEED_LLM_MODEL` |
| `--task` | `检查这台机器的整体健康状况` | — |
| `--max-steps` | `20` | — |
| `--timeout` | `30s` | — |
| `--out` | `reports/` | — |

优先级为 flag 高于 env，env 高于默认值。

SSH 密码与 LLM API key 都**没有代码内默认值**，必须从 env 提供，因此不会有任何凭据被提交进 git。两者虽也接受 flag 覆盖，但走 flag 时会出现在 `ps` 输出中，因此 README 一律推荐 env 方式，两个 flag 的帮助文本中也注明这一点。

这是有意的设计约束：探测阶段已发现 .99 上的 llama-server 把 `--api-key` 明文写在进程参数里，任何本机用户 `ps aux` 都能看到。demo 不应重复这个错误，也不应把凭据固化进版本库。

## The Agent Loop

一句话原理：**agent 就是一个 while 循环，反复把「模型说的话」和「话执行后的结果」追加到同一个 messages 数组里，直到模型不再要求调工具。**

### Phase 1: Plan

一次 LLM 调用，不带 tools。要求模型返回 JSON 数组：

```json
[
  {"id": 1, "title": "内存与 swap 压力", "why": "swap 打满会导致 OOM"},
  {"id": 2, "title": "GPU 显存与利用率", "why": "3090 显存接近满载需确认"},
  {"id": 3, "title": "关键服务存活", "why": "llama-server/vLLM/RAGFlow 是否在跑"}
]
```

不给 tools 是刻意的：逼模型先想清楚要查什么，而不是边想边乱查。

解析容错：容忍 ```` ```json ```` 代码围栏；解析失败则附「你上次的输出不是合法 JSON」重试一次；再失败退化为单个自由探索子任务。一次格式问题不应毁掉整场 demo。

### Phase 2: Execute

对每个计划出的子任务运行一个内层循环。messages 数组的真实演化：

```text
起点:
  [0] system    你是 Linux 只读诊断 agent...
  [1] user      子任务: 检查内存与 swap 压力

── 第 1 轮 ────────────────────────────────
  → 发给 LLM (带 tools)
  ← finish_reason="tool_calls", reasoning="先看整体内存分布"
  [2] assistant  tool_calls:[run_shell{"command":"free -h"}]      ← 模型的"决定"
  [3] tool       "内存: 61Gi used 32Gi... 交换: 8.0Gi used 7.3Gi"  ← 世界的"回答"

── 第 2 轮 ────────────────────────────────
  → 发给 LLM (数组已含上一轮)
  ← reasoning="swap 用了 91%，得找出是谁占的"
  [4] assistant  tool_calls:[run_shell{"command":"ps aux --sort=-%mem | head"}]
  [5] tool       "tom 1156436 21.9% llama-server..."

── 第 3 轮 ────────────────────────────────
  → 发给 LLM
  ← finish_reason="stop", content="swap 91% 已用，主因是两个 llama-server 的
     --kv-offload 各占 14GB/9.5GB RSS..."
  [6] assistant  (纯文本结论，无 tool_calls)   ← 循环终止信号
```

终止条件是「模型这轮没要求调工具」。三个出口：

- 模型自行返回 `stop`，正常收敛。
- 步数触顶（单个子任务上限 8 步，全局 `--max-steps` 20）：追发一条不带 tools 的 user 消息「请基于已获得的信息给出结论」，强制收尾。
- LLM 连续失败：标记该子任务「未完成」，如实写进报告，继续下一个子任务。

每个子任务使用独立的 messages 数组，只把 system prompt、计划全文和当前子任务目标作为起点。子任务之间不共享工具调用历史，避免 context 无限膨胀。已完成子任务的最终结论（即那条不带 `tool_calls` 的 assistant content）原文注入下一子任务的 system 上下文，单条截断到 2000 字节；不做二次总结，以免引入额外 LLM 调用和信息损失。

### Phase 3: Report

一次 LLM 调用，把所有子任务的结论喂进去，要求产出 markdown 报告：按严重度分级（紧急 / 关注 / 正常）、写明根因、给出建议动作但不执行。

Go 侧再拼上元信息：主机、时间戳、总步数、token 用量、各阶段耗时。报告由模型撰写、由代码补全事实性头部，避免模型编造运行统计。

## Tools

| 工具 | 参数 | 能力 |
|---|---|---|
| `run_shell` | `command` | 在 .99 上执行白名单命令，返回 stdout、stderr、exit code |
| `http_probe` | `url`, `timeout_ms` | 从本机 macOS 侧发 HTTP GET，返回状态码、耗时、body 前 2000 字节 |

只保留两个工具是刻意的。工具多样性不是教学重点，loop 才是；两个足以展示模型自主选工具，第三个纯属噪音。

`http_probe` 保留的理由是它提供了真正不同的观察视角：验证服务对外是否可达（例如探测 `:2081/health`），这是从 .99 内部执行 shell 命令无法得到的信息。

## Read-Only Policy

`allowlist.go` 是整个 demo 里唯一不讲情面的部分，也是唯一有安全含义的代码。

规则：

- 按 `|`、`&&`、`||`、`;` 拆分命令，**每个子命令的首个 token 都必须在白名单内**。完整白名单在 `allowlist.go` 中以字面量枚举，初始集合为：`df`、`du`、`free`、`ps`、`pgrep`、`pidof`、`top`、`uptime`、`uname`、`hostnamectl`、`timedatectl`、`nproc`、`lscpu`、`lsblk`、`swapon`、`vmstat`、`iostat`、`ss`、`netstat`、`ip`、`ping`、`nvidia-smi`、`systemctl status`、`systemctl list-units`、`systemctl show`、`journalctl`、`dmesg`、`docker ps`、`docker images`、`ls`、`find`、`grep`、`head`、`tail`、`wc`、`awk`、`sort`、`uniq`、`cut`、`cat`、`echo`、`date`、`which`、`w`、`who`、`last`。
- **绝对黑名单**，出现在命令任何位置都拒绝：`rm`、`mv`、`cp`、`dd`、`kill`、`pkill`、`killall`、`shutdown`、`reboot`、`apt`、`dpkg`、`snap`、`chmod`、`chown`、`sudo`、`tee`、`truncate`、`mount`、`umount`、`iptables`、`useradd`、`passwd`，以及 `systemctl` 后跟 `start`、`stop`、`restart`、`enable`、`disable`。
- **拒绝重定向与命令替换**：`>`、`>>`、反引号、`$( )`。
- 输出截断到 8000 字节，并标注 `[已截断，原始 N 字节]`。
- 单命令超时 30 秒，超时后关闭 session。

黑名单优先于白名单。`mount` 同时出现在两侧时，以黑名单为准——只允许通过 `mount -l` 或读取 `/proc/mounts` 获取挂载信息。

### 拒绝要回灌，不要崩溃

命令被拒时不抛异常终止，而是把拒绝理由当成 tool result 回灌给模型：

```text
[7] tool  "命令被只读策略拒绝：包含黑名单词 'kill'。请改用只读命令。"
```

于是 trace 里会出现 agent 自己改口的过程：它想 `kill` 掉冗余进程，被拒，然后改用 `systemctl status` 去查那个进程的状态。这个「撞墙—调整」的过程是 agent 区别于脚本的最本质特征，也是本 demo 最值得看的一幕。

同样的哲学适用于 `tool_call.arguments` 非法 JSON 的情况：把解析错误回灌给模型让它自行修正，最多一次。

## Concurrency Constraint

qwen3.8 服务以 `--parallel 1` 启动，**单并发**。因此 loop 必须严格串行，绝不并发发送请求，HTTP 客户端超时设为 180 秒以容纳长 context 的 prompt 处理。这条约束写在代码注释里，因为它解释了"为什么这里不用 goroutine"。

## Error Handling

原则：**启动期 fail fast，运行期永不崩**。demo 要跑两分钟，中途崩掉就白跑了，而且崩溃会掩盖 agent 的工作原理——观众只看到 stack trace。进入 loop 之后，一切故障都转成喂给模型的一条消息。

| 故障点 | 策略 |
|---|---|
| SSH 连不上或认证失败 | 启动即退出，码 1，提示检查 env |
| LLM 首次调用失败 | 启动即退出，打印 URL、model、状态码 |
| LLM 中途失败（网络、5xx、超时） | 指数退避重试 2 次（1s、3s）；仍失败则标记该子任务未完成，继续下一个 |
| `tool_call.arguments` 非法 JSON | 回灌解析错误让模型修正，最多 1 次；再失败跳过该 call |
| plan JSON 解析失败 | 带纠正提示重试 1 次；再失败退化为单个自由探索子任务 |
| 单命令超时 | 关闭 session，回灌超时信息，模型可自行换命令 |
| 命令输出过大 | 截断 8000 字节并标注 |
| `max_steps` 触顶 | 追发不带 tools 的收尾指令 |
| 报告写盘失败 | 降级打到 stdout，不丢结果 |

## Testing

两个测试文件，全离线，跑完全程小于 100 ms，不联网、不碰 SSH、不烧 GPU。

`allowlist_test.go` 采用表驱动，重点全在绕过尝试上：

- 放行：`df -h /`、`free -h`、`ps aux | head -8`、`nvidia-smi`、`systemctl status nginx`、`journalctl -u x --no-pager`
- 拦截：`rm -rf /`、`df; rm x`、`df && reboot`、`sudo df`、`cat $(rm x)`、`echo hi > /tmp/x`、`systemctl stop nginx`、`kill 1234`、`ps aux | tee /tmp/o`

`agent_test.go` 用脚本化假 LLM（一个响应队列）加假 Executor，覆盖四条路径：

1. 两轮工具调用后正常收敛，断言最终 messages 数组的长度与角色顺序为 `system, user, assistant, tool, assistant, tool, assistant`。
2. `max_steps` 触顶走强制收尾分支。
3. 工具被拒后，断言拒绝文本出现在下一条 `role:tool` 消息中。
4. 坏 JSON arguments 走重试路径。

这个测试文件本身即教材：它把完整的消息序列写死在那里供人阅读。

Go 测试不进根 `package.json` 的 `test` 链（那条链是 `node --test`）。另加一行独立脚本以便发现：`"test:go": "cd tooling/agent-health && go test ./..."`。不改动现有 `test`、`lint`、`build` 或任何 `verify:phase-NN` 脚本。

## Deliverable: README

README 是「讲清楚 agent 工作原理」真正落地之处，包含四部分：

1. **原理讲解**——agent 就是 while 循环加一个不断长大的 messages 数组。
2. **一份带注释的真实 trace**——对 .99 跑一次的真实输出，逐行标注对应 ReAct 循环的哪个环节。
3. **messages 数组演化图**——即 Phase 2 那张图，画得更完整。
4. **运行方式、测试方式、已知限制**——限制包括 `parallel=1` 单并发、IQ3_S 量化对推理质量的影响、长文本时 MTP 接受率下降导致生成变慢。

运行方式：

```bash
cd tooling/agent-health
export INEED_SSH_PASSWORD='...'
go run .
```

## Dependencies

唯一外部依赖 `golang.org/x/crypto/ssh`。LLM 客户端用 `net/http` 加 `encoding/json` 手写，约 180 行。

手写而非使用第三方 OpenAI SDK 的理由：`reasoning_content` 是 llama.cpp 与 DeepSeek 的非标准扩展字段，qwen3.8 每次响应都会返回它（实测确认），而第三方 SDK 经常直接丢弃该字段。它是 trace 里信息量最大的部分，不能丢。

不通过 `os/exec` 调用 `sshpass` 的理由：那会把密码摆进 `ps aux`；且每条命令重新握手 SSH，15 步的 loop 会多花数秒；还依赖机器上装了 `sshpass`（Homebrew 默认不提供）。

`SSHExecutor` 复用一个 `ssh.Client`，每条命令开一个新 `ssh.Session`——session 是一次性的，client 可复用，这是 `x/crypto/ssh` 的正确用法。

## Known Limitations

- 被检查的主机 .99 同时是 LLM 服务宿主。若 .99 资源耗尽导致 llama-server 异常，agent 会失去大脑，demo 无法完成。这是选择该目标的固有代价。
- swap 已用 7.3/8.0 GiB、物理可用内存仅 1.7 GiB，.99 存在 OOM 风险。demo 全程只读，不加剧该状况，但运行期间 .99 可能因自身压力出现命令超时。
- 模型为 IQ3_S 量化（3.4375 bpw），复杂推理能力弱于全精度。诊断结论应视为参考而非权威。
- 两个 llama-server 实例的 alias 分别为 `qwen3.6`（端口 2080）和 `qwen3.8`（端口 2081），指向同一模型文件。demo 默认连 2081。
