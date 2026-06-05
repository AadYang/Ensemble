# 多 SDK 原生集成（W16 提案 · v2 修订版）

> **状态**：✅ 已实施（2026-05-11）— Slice 1–8 全部落盘，提交 `16780e8` `992a218` `33715e5` `6b1e5f6` `aa7bfea` `9b6bebc` `5f3810d` `d6e7225` + 本 Slice 8 文档收尾。实施期实际跨 ~半天（vs 原估时 5-6 周），因为 v2 设计已经把决议钉死，每个 Slice 只是落地，没有再做大设计抉择。详见 [`development-log.md`](development-log.md) 2026-05-11 一节按 Slice 倒序的实施意图与教训。
> **范围达成**：C 方案 v2 终态（一次性、含全功能、含 musistudio 删尽）。Slice 7 E2E 验收：Claude 本地 OAuth + MiniMax (anthropic-compat) + timicc (openai-compat gpt-5.2) 三套上游全跑通；cross-runtime peer_send 双向通；ExitPlanMode + plan-mode + interrupt-resume permission 全部 hit 预期分支。
> **修订**：v2（2026-05-11），根据 [`multi-sdk-integration-review.md`](multi-sdk-integration-review.md) 的审阅意见全面修订。修订前的 v1 设计存在 6 项事实错误（NormalizedEvent 两层模型混淆、OpenAI SDK 不自带 file/shell 工具、permission flow 语义差异、session resume 评估反了、musistudio 价值评估等），见 review 文档详细列举。
> **目标**：让 Ensemble **原生支持 Claude 与 OpenAI 两大体系**，每条体系各自支持「官方登录」与「第三方兼容（baseUrl + key）」两种入口；废弃 musistudio gateway（不再需要协议翻译）；删除 bedrock / vertex 两个低使用率 kind。
> **触发场景**：W15 收尾时用户接入 timicc 第三方 OpenAI-compat → 模型 `gpt-5.4` 被 claude CLI 本地预校验拦下。深挖发现 musistudio 翻译路径也救不了（model 名原样转发上游同样 404）。结论：要让 OpenAI 体系真正可用，必须用 OpenAI 自己的 agent SDK。

---

## 1. 范围澄清（修订版）

### 1.1 仅保留两条 runtime

| Runtime | SDK | 入口 1：官方 | 入口 2：第三方兼容 |
|---|---|---|---|
| **ClaudeAgentRuntime** | `@anthropic-ai/claude-agent-sdk` + `claude` CLI | `claude login` OAuth (`anthropic-local`) | `kind=anthropic` + baseUrl + key（DeepSeek / GLM / MiniMax 的 anthropic 端点） |
| **OpenAIAgentRuntime** | `@openai/agents`（in-process） | `kind=openai-compat` + 默认 baseUrl preset + 官方 key | `kind=openai-compat` + 自定义 baseUrl + key（DeepSeek / GLM / 自托管 / timicc 等） |

**关于"OpenAI 官方登录"的实质**：OpenAI 没有 `openai login` 这种 OAuth-for-API 的工具。"官方"在产品层只是一个 baseUrl preset（`https://api.openai.com/v1`）+ 让用户填 platform.openai.com 发的 API key。所以**不引入 `openai-local` kind**，"官方"和"第三方兼容"统一到同一个 `openai-compat` kind 下，区别仅在 UI preset 层。

### 1.2 退场的概念

- `bedrock` / `vertex` 两个 kind 删除。低使用率，要保留就得在 OpenAI/Claude 双 runtime 各支持一遍，不值得
- `autoManaged` + musistudio 整条路径退役（详见 §6 musistudio 命运）

---

## 2. 关键架构决策

| 维度 | 否决 | 采纳 | 理由 |
|---|---|---|---|
| 跨体系翻译层 | musistudio 强化 / LiteLLM | **抛弃翻译路径，原生 SDK 直连** | 翻译层只能做 chat，做不了完整 agent 语义；维护一个翻译层等于自己写半个 SDK |
| OpenAI 体系用什么 | OpenAI HTTP 直连 + 自写 agent loop | **`@openai/agents`** 官方 SDK | 节省半年自研工作；和 OpenAI 后续模型同步更新 |
| Codex CLI 替代方案 | 装 Codex CLI 当 sidecar | 不采纳 | 又多一个二进制依赖；Codex CLI 用户群小、文档少、生态不如 SDK 库 |
| OpenAI "官方登录" | 引入新 kind `openai-local` | **不新增 kind，仅 UI preset** | OpenAI 没有真正的 OAuth-for-API；新 kind 等于增加无意义抽象 |
| SessionManager 改造 | for-each-kind if-else | **AgentRuntime 抽象 + 工厂模式** | 现在两个 runtime，未来可能加（Bedrock 真有需求时）；不能让 if-else 长到无法维护 |
| RuntimeEvent vs ServerMsg | 拍平到一个 union | **明确两层模型**（见 §3） | ServerMsg 是 WS 协议（前端可见），RuntimeEvent 是 runtime 内部产物；adapter 在 SessionManager 完成翻译 |
| 双 runtime 工具实现 | 期待各 SDK 自带 | **NormalizedTool 抽象层自实现 4 个核心工具** | OpenAI Agents SDK 不内置 Read/Edit/Write/Bash；Claude side 是 CLI 提供。两边对齐就只能自己写 |
| OpenAI session 持续性 | SDK 的 thread/resume 概念 | **自维护：读 messages 表 → 拼 history 到 input** | Ensemble 已有 messages 表，比 Claude side 的 CLI-session-file 路径还简洁可靠 |
| musistudio 命运 | deprecated 但保留进程启动 | **v1 拒绝新建；旧数据可读 + 一键迁移；不再启动 musistudio 进程** | OpenAI 原生 runtime 后 musistudio 唯一价值（协议翻译）消失 |
| feature 对齐 | 双侧 100% 对等 | **Claude side full feature；OpenAI side v1 仅 chat + 4 工具 + 基础 permission，peer_send/MCP/ExitPlanMode/Task 后续补** | 原生 SDK 接入本身已是 3 周工作量，feature 对齐再追加同等时间。先跑起来再补 |
| Schema 迁移 | 让 DB 自然适应 | **启动时 migration，老 kind 值 graceful 降级 + 提示用户重建** | 防止用户 db 里的 bedrock/vertex 数据让新版 boot 崩 |

---

## 3. 架构

### 3.1 现状

```
SessionManager.sendMessage
   └─ query() 单一入口
       └─ @anthropic-ai/claude-agent-sdk → claude CLI subprocess
           ├─ Claude 直连 (anthropic-local / 第三方 anthropic-compat)
           └─ musistudio gateway → OpenAI-compat 上游 (此路径有 CLI 白名单问题)
```

### 3.2 W16 之后

```
SessionManager.sendMessage
   ├─ runtime = chooseRuntime(provider.kind)
   │
   ├─ ClaudeAgentRuntime  (provider.kind in [anthropic, anthropic-local])
   │     └─ @anthropic-ai/claude-agent-sdk → claude CLI subprocess
   │
   └─ OpenAIAgentRuntime  (provider.kind = openai-compat)
         └─ @openai/agents (in-process)
              ├─ openai SDK → upstream OpenAI-compat URL
              └─ 自维护 history（读 messages 表拼 input 数组）

两个 runtime 都吐出 RuntimeEvent → SessionManager 翻译 → ServerMsg → WS broadcast
musistudio: v1 起拒绝新建，提供一键迁移；不再 bootstrap 进程
```

### 3.3 两层事件模型

**RuntimeEvent**（runtime 内部产物，不出 SessionManager）：

```ts
type RuntimeEvent =
  | { type: "sdk_message"; payload: SdkMessage }    // 流式 init / partial / assistant / tool_use / tool_result / result
  | { type: "permission_request"; reqId: string; toolName: string; input: unknown }
  | { type: "user_question"; reqId: string; question: string; options: string[] }
  | { type: "error"; message: string };
```

`SdkMessage` 沿用 `shared/src/protocol.ts` 现有定义（`init / status / assistant / user / stream_event / result` 等），两个 runtime 都把内部事件映射到这套结构。

**ServerMsg**（前端 WS 协议，**不变**，验收硬约束）：

```
hello / agent_created / agent_updated / agent_deleted / status / message / permission_request / user_question / error
```

由 SessionManager 自己产出（agent 生命周期、status 转移、message 持久化广播等）。**runtime 不发** `hello / agent_created / status` 这类元事件——避免实现者误以为 runtime 也要管这些。

**翻译边界**：

```
RuntimeEvent              SessionManager                ServerMsg (WS out)
─────────────             ──────────────                ───────────────
sdk_message       ──→ persist + broadcast       ──→  message
permission_request ──→ track pending            ──→  permission_request
user_question     ──→ track pending            ──→  user_question
error             ──→ status: error            ──→  error  +  status

(无 RuntimeEvent)  ──→ status 转移（IDLE/RUNNING/DONE）  ──→  status
```

### 3.4 Schema 与迁移

**新枚举**（命名风格选择 B：单维度，沿用现有命名最小动静）：

```ts
const PROVIDER_KINDS = [
  "anthropic-local",   // Claude OAuth (现有)
  "anthropic",         // Claude API key + baseUrl，含官方 + 第三方 anthropic-compat (现有)
  "openai-compat",     // OpenAI 官方 + 第三方 openai-compat（含 default baseUrl preset）(现有名字，复用)
] as const;
```

**删除**：`bedrock` / `vertex`

**Migration 策略**：

1. **启动时** core/src/db.ts 加 `migrateKinds()`：扫所有 Provider 行，把 `kind in [bedrock, vertex]` 的 row 标记为 `disabled: true`（新加 boolean 列）+ 在 metadata 写一条 `{deprecated: "v0.0.2 dropped bedrock/vertex"}`
2. **API 层** GET `/providers` 返回 disabled provider 时附 `deprecated: true` 字段；前端在该行渲染灰色 + "已停用" 标签 + 「迁移到 anthropic / openai-compat」按钮（一键引导用户重建）
3. **API 层** POST `/providers` 拒绝 `kind in [bedrock, vertex]`（返回 400 explaining deprecation）
4. **autoManaged 旧数据**：同样的 disabled + deprecated + 迁移按钮模式。一键迁移会用旧 baseUrl/key/upstreamProvider 信息生成对应的 `openai-compat` 新 provider，旧的删除
5. SessionManager.sendMessage 拒绝 disabled provider（友好错误："这个 provider 类型已停用，请用迁移按钮升级"）

---

## 4. Feature 对齐矩阵（修订）

| Feature | Claude Runtime | OpenAI Runtime v1 | OpenAI Runtime v1.1 | 备注 |
|---|---|---|---|---|
| 基础对话 (流式) | ✅ | ✅ | — | |
| Read / Edit / Write / Bash 4 个核心工具 | ✅ (CLI 提供) | ✅ **(NormalizedTool 抽象层自实现)** | — | OpenAI Agents SDK 不内置；自实现且与 Claude side 行为对齐（路径校验 / 权限 / 错误格式） |
| Grep / Glob | ✅ (CLI 提供) | ⚠️ v1 跳过 | ✅ | 二级工具，v1 砍 |
| Task subagent (方案 A 透明嵌套) | ✅ (CLI 内部) | ❌ | 设计映射 | OpenAI Agents SDK 用 handoff 概念，语义不同 |
| ExitPlanMode | ✅ | ❌ | 用 ask_user 替代实现 | OpenAI 无对应概念 |
| permissionMode (default/plan/acceptEdits/...) | ✅ | ⚠️ 仅 default & acceptEdits | 全 5 种 | OpenAI Agents SDK 的 needsApproval 是 per-tool flag，没有"模式"语义 |
| canUseTool 回调 → permission_request 弹框 | ✅ (callback 模型) | ✅ **(interrupt-resume 模型，见 §5.3a)** | — | **两套语义完全不同**，需要适配层 |
| in-process MCP (peer_send / ask_user) | ✅ | ❌ v1 不支持 | OpenAI Agents SDK MCP 接入 | v1 OpenAI agent 用 prompt 引导用户做选择 |
| stdio/http MCP servers | ✅ | ❌ v1 跳过 | v1.1 | |
| session 持续性（resume） | ✅ (CLI ~/.claude session 文件) | ✅ **(自维护：读 messages 表 → 拼 history)** | — | OpenAI side 不依赖 SDK resume 概念，反而比 Claude side 更可靠 |
| customSystemPrompt | ✅ ¹ | ✅ ² | — | ¹ Claude SDK 与 CLI 内部 system 拼接，受 settingSources/CLAUDE.md 注入影响 ² OpenAI Agents instructions 直接当 system message，无二次拼装。**用户在 Claude side 调好的 prompt 切到 OpenAI side 行为会不一样** |
| Bedrock / Vertex | ❌ (kind 删除) | N/A | — | |
| **CLI 模型白名单** | 仅影响 Claude side（用 Claude 模型自然过） | **解决**（OpenAI SDK 不校验） | — | W16 要解决的核心问题 |

v1 OpenAI side feature 故意降级；多 agent 协作 / Task / ExitPlanMode / 完整 permission mode / MCP 暂留在 Claude side。后续 v1.1 / v1.2 逐步补齐。

---

## 5. 实施切片（W16-S0..S8）

> 编号统一为 `W16-S*`，避免与 §6 风险章节同号歧义。

### W16-S0 · UI 表单四态改造 + 旧 provider 迁移 banner

新表单决策树：

```
[runtime 单选] Claude / OpenAI
   ↓
[接入方式 单选] 官方 / 第三方兼容
   ↓
官方 → Claude 走 OAuth 引导 / OpenAI 走 default baseUrl + 输入官方 key
兼容 → 填 baseUrl + apiKey
   ↓
[refresh 模型列表 → 用户必选 default model]
```

旧 provider 页面顶部加迁移 banner：「检测到 X 个 deprecated provider（bedrock / vertex / autoManaged），点这里一键迁移」。

**估时**：1 天
**产出**：`desktop-ui/components/ProviderForm.tsx` 重构、`/providers` GET 增 `deprecated`/`disabled` 字段、迁移 API endpoint

### W16-S1 · AgentRuntime 接口抽象

`core/src/sessions/runtimes/types.ts` 定义：

```ts
interface RuntimeOptions {
  provider: Provider;
  model: string;
  systemPrompt?: string;
  tools: NormalizedToolName[];
  permissionMode: PermissionMode;
  abortController: AbortController;
  canUseTool: (name: string, input: unknown) => Promise<PermissionResult>;
  // 历史消息（OpenAI runtime 用于自维护 history）
  history: SdkMessage[];
}

interface AgentRuntime {
  query(opts: RuntimeOptions): AsyncIterable<RuntimeEvent>;
}

function chooseRuntime(kind: ProviderKind): AgentRuntime { ... }
```

**估时**：半天
**产出**：types.ts + index.ts 工厂

### W16-S2 · ClaudeAgentRuntime 包装 + 回归 baseline 录制

把现有 SessionManager.sendMessage 里调 query() 那段代码搬出来包成 ClaudeAgentRuntime。**关键**：先**录制回归 baseline**（保存几条标准 case 的预期事件序列），再开始重构。

特别注意 **peer-mcp.ts / ask-user-mcp.ts 的闭包绑定**（`createSdkMcpServer` 闭包绑定 `fromAgentId`），重构时若构造时机挪错位置，会导致 fromAgentId 串号——**必须单测覆盖**。

**估时**：2 天（其中 1 天写 ClaudeAgentRuntime，1 天写 baseline 录制 + peer/ask MCP 闭包单测）
**产出**：`runtimes/claude.ts`；`runtimes/__tests__/claude-baseline.test.ts`

### W16-S3 · OpenAIAgentRuntime 最小 chat

装 `@openai/agents` 依赖；写最小 OpenAIAgentRuntime（仅 chat，无 tool）：openai-compat provider 走这条；可发消息收响应；history 从 messages 表读出来拼 input。

**估时**：1 天
**产出**：`runtimes/openai.ts`

### W16-S3.5 · SEA 打包验证

`make-exe.mjs` / `bundle.mjs` 必须把 `@openai/agents` 及传递依赖打进 sidecar exe。dev 跑通 ≠ SEA 跑通（依赖动态 import / 运行时 require 等都可能在 SEA 失效）。这个 stage 要验证：

- `pnpm desktop:build` 后的 `ensemble-core.exe` 启动 + 创建 OpenAI provider + 发消息全流程跑通
- 包体积 delta（预期 ~5 MB；超过 15 MB 触发审视）

**估时**：半天

### W16-S4 · 4 个 file/shell 工具自实现 + NormalizedTool 抽象

新增 `core/src/sessions/tools/` 目录。每个工具一个文件（read.ts / edit.ts / write.ts / bash.ts），定义 NormalizedTool（schema + execute），两个 runtime 适配各自的 tool 绑定方式。

工具行为必须与 Claude side（CLI 提供的同名工具）对齐：路径校验、相对/绝对路径、错误格式、权限检查时机。这是**与 Claude side 行为兼容**的关键。

**估时**：3-4 天（原估 2 天严重低估）
**产出**：`tools/{read,edit,write,bash,types}.ts`

### W16-S5 · permission 适配（callback 端）

ClaudeAgentRuntime 这边按现有 callback 逻辑接入 SessionManager.canUseTool。

**估时**：1 天

### W16-S5a · permission 协议跨 runtime 标准化（含 interrupt-resume 设计）

OpenAI Agents SDK 的 permission 是 interrupt-resume 模型：

```
run agent
   ↓
某个 tool 需要 approval (needsApproval) → run 返回 interruptions
   ↓
持久化 interruption state (在哪一步、call_id、context)
   ↓
SessionManager 发 permission_request ServerMsg → 前端弹框
   ↓
前端响应 permission_response → SessionManager
   ↓
load saved state + run resume，approvals.confirm/cancel(call_id)
```

这套 state 必须能跨 ServerMsg 一来一回保留（不能丢在内存里），还要处理 abort 时清理。需要画状态机图、定义存储位置（建议在 `runtimes/openai.ts` 模块级 Map<runId, InterruptState>）。

**估时**：3 天
**产出**：`runtimes/openai-permission.ts` + 状态机文档段

### W16-S6 · musistudio 退役 + 迁移工具

不再是"标 deprecated"，而是：

- POST `/providers` 拒绝 `autoManaged: true` 的请求
- 启动时 `litellm.bootstrap()` 改为 no-op（如果还有旧 autoManaged 数据则只 warn 不启动）
- 提供 POST `/providers/:id/migrate-from-automanaged` endpoint：基于旧 row 的 baseUrl/key/upstreamProvider 信息生成对应的 `openai-compat` 新 provider，标记旧的 disabled
- 前端 banner 引导一键迁移（W16-S0 已含 UI）

**估时**：1 天

### W16-S7 · 端到端 4 组合测试

收敛后的测试矩阵：

| # | runtime | 入口 | 上游 | 工具用 |
|---|---|---|---|---|
| 1 | Claude | 官方 OAuth (`anthropic-local`) | Anthropic 官方 | Read + Edit |
| 2 | Claude | 第三方兼容 (`anthropic`) | DeepSeek anthropic 端点（或任一 anthropic-compat） | Read + Edit |
| 3 | OpenAI | 官方 (`openai-compat` + default preset) | OpenAI 官方 | Read + Edit |
| 4 | OpenAI | 第三方兼容 (`openai-compat` + 自填) | DeepSeek openai 端点（或 GLM 任选一家） | Read + Edit |

**+ 一组回归**：装上 v1 之后启动，DB 里有遗留 `bedrock` / `vertex` / `autoManaged` provider 都不能让 boot 崩；UI 显示迁移 banner。

**估时**：2-3 天

### W16-S8 · 文档 + W14 影响评估

- 更新 architecture.md / development-log.md / CLAUDE.md
- 标 musistudio 在 architecture.md 的描述为历史
- W14（subagent 推荐）的设计文档加一条："runtime-aware：不同 runtime 显示不同推荐集"

**估时**：半天

### 总估时

| Stage | 估时 |
|---|---|
| W16-S0 UI 表单四态 + 迁移 banner | 1d |
| W16-S1 AgentRuntime 抽象 | 0.5d |
| W16-S2 ClaudeAgentRuntime + 回归 baseline + 闭包单测 | 2d |
| W16-S3 OpenAIAgentRuntime 最小 chat | 1d |
| W16-S3.5 SEA 打包验证 | 0.5d |
| W16-S4 4 个工具自实现 | 3-4d |
| W16-S5 permission callback 端 | 1d |
| W16-S5a permission interrupt-resume 跨 runtime | 3d |
| W16-S6 musistudio 退役 + 迁移 | 1d |
| W16-S7 端到端 4 组合测试 + 回归 | 2-3d |
| W16-S8 文档 + W14 影响 | 0.5d |
| Schema migration（删 bedrock/vertex） | 0.5d |
| **合计** | **~16-18 工作日 ≈ 3 周** |

---

## 6. 风险与开放问题

### 6.1 风险

| 风险 | 缓解 |
|---|---|
| `@openai/agents` 还年轻（2025），API 可能变 | pin 版本；单独 runtime 文件隔离更新冲击 |
| OpenAI Agents SDK 的 tool / permission / MCP 接口和 Claude SDK 不同 | 接受。NormalizedTool / RuntimeEvent 抽象层吸收差异；具体实现各自写 |
| OpenAI Agents SDK 没有 ExitPlanMode / Task | OpenAI side v1 砍掉这些功能，UI 隐藏；不影响 Claude side |
| OpenAI Agents SDK 的 MCP API 与 Claude side 显著不同 | v1 不在 OpenAI side 接 MCP；W16-S0 / W16-S5a 之外的 stage 不依赖 MCP |
| musistudio 用户的迁移路径不顺畅 | W16-S0 + W16-S6 提供一键迁移 + banner；保留旧数据可读 |
| OpenAI runtime 自维护 history → 长对话内存膨胀 | history 截断策略：保留最近 N 条 + 旧 N+ 条压缩成 summary（v1 直接截断，v1.1 加 summary） |
| OpenAI runtime abort 不一定能中断底层 fetch streaming | W16-S7 测试：sidecar 强退时必须 1s 内放掉所有 socket；如不达标，加超时 fallback 强 kill |
| node:sqlite + @openai/agents 兼容性 | W16-S3.5 SEA 打包验证就在测这个 |
| 包体积膨胀 | W16-S3.5 量；超 15 MB 审视；预期 ~5 MB |
| **peer-mcp / ask-user-mcp 闭包绑定 fromAgentId 重构时挪错位置** | W16-S2 必须有单测覆盖；测试用例：两个不同 agent 同时各自调 peer_send，断言 fromAgentId 各对各 |
| Claude side 与 OpenAI side systemPrompt 行为不一致 | architecture.md / HANDBOOK.md 显式说明；切换 runtime 时 UI 提示 |

### 6.2 开放问题

1. **OpenAI Agents SDK 版本 pin 策略**：v1 锁哪个版本？建议 latest minor 启动，每次手动升级前 review changelog
2. **agent 跨 runtime 切换语义**：用户把一个已有对话历史的 agent 的 provider 从 Claude 换成 OpenAI（或反之），现有 messages 表能不能给 OpenAI runtime 用？建议 v1 允许（历史已经是 SdkMessage 形态，OpenAI runtime 可以反向解析），但 UI 加警告"切换 runtime 后 tool 行为可能不同"
3. **跨 runtime peer_send**：Claude agent 想 peer_send 给 OpenAI agent，OpenAI runtime 怎么"接收消息"？v1 不做（不同 runtime 之间 peer_send 报错），v1.2 设计跨 runtime 协议
4. **Codex CLI 是否后续支持**：v2 看用户反馈，v1 不接
5. **Bedrock / Vertex 真有需求时**：未来某天若有用户强需求，加新 runtime 类（不是恢复老 kind 路径）
6. **AgentSettings 0-model 防线**：openai-compat provider 创建后 `models[]` 必须非空（refresh 后再保存 agent 才允许选；models 空时 AgentSettings 显示"刷新模型列表"占位禁止保存 agent）—— 防止重蹈 W15 已知坑

---

## 7. 显式不做

- **不做**自研 agent loop（OpenAI 也好 Anthropic 也好用官方 SDK）
- **不做** v1 双 runtime feature 100% 对齐（已分到 v1.1+）
- **不做** musistudio 重写或修复（直接退役，不再启动进程）
- **不做** Codex CLI 二进制集成（库 SDK 优先）
- **不做** v1 OpenAI side 的 ask_user MCP（用 prompt 引导接受简陋 UX）
- **不做**跨 runtime peer_send（v1 限制在同 runtime 内）
- **不做**新 kind `openai-local`（OpenAI 没真正的 OAuth-for-API；用 preset 即可）
- **不做** bedrock / vertex 保留（删除 + migration）

---

## 8. 验收标准（v1）—— 展开为可勾选 checklist

### 抽象层

- [ ] `core/src/sessions/runtimes/` 目录建立，`AgentRuntime` 接口 + `RuntimeEvent` 类型定义
- [ ] `chooseRuntime(provider.kind)` 工厂返回正确 runtime
- [ ] SessionManager.sendMessage 内只调 `runtime.query()`，不再有 SDK 直接引用

### Claude side 回归（必须 zero 退化）

- [ ] anthropic-local provider 发消息 → 流式 partial_text → assistant → result success
- [ ] 第三方 anthropic-compat (DeepSeek anthropic 端点 + key) 发消息成功
- [ ] permissionMode = default → 调 Bash 触发 permission_request 弹框 → allow/deny 路由正确
- [ ] permissionMode = plan → ExitPlanMode 工具可调用
- [ ] permissionMode = acceptEdits → Edit/Write 不弹框
- [ ] permissionMode = bypassPermissions → 全部 tool 不弹框
- [ ] permissionMode = dontAsk → 同上
- [ ] peer_send 在两个 anthropic agent 间发消息，fromAgentName 正确（**不串号**）
- [ ] ask_user 弹出 user_question 对话框，用户选项后 agent 收到
- [ ] Task subagent（方案 A 透明嵌套）在父 agent 视图渲染为 ToolCard
- [ ] hooks / settingSources / customSystemPrompt 行为不变
- [ ] mergedEnv 注入（ANTHROPIC_BASE_URL/API_KEY、CLAUDE_CODE_USE_BEDROCK 等）行为不变（bedrock/vertex env 仍可注，但 kind 已删）
- [ ] abortController 取消跑到一半的 query，sidecar 端 claude CLI 子进程被杀
- [ ] 流式 partial assistant_text 在前端逐字渲染（W12 修复行为不退化）

### OpenAI side 新功能

- [ ] openai-compat provider（默认 baseUrl preset = `https://api.openai.com/v1`）发消息成功
- [ ] openai-compat provider（自填 baseUrl = DeepSeek 或 GLM 的 OpenAI 端点）发消息成功
- [ ] gpt-5.4 / GLM-4.5 / DeepSeek 等非 Claude 模型名直接可用，不再撞 CLI 白名单
- [ ] OpenAI side 的 Read/Edit/Write/Bash 工具能调用，行为与 Claude side 一致（路径校验、错误格式）
- [ ] OpenAI side permission_request 弹框正常工作（interrupt-resume 路径）；用户拒绝后 agent 收到 deny + 优雅继续
- [ ] OpenAI side 多轮对话 history 正确传递（session 假象）
- [ ] OpenAI side abortController 取消运行中的 query，sidecar 1s 内放掉 socket

### Schema / 迁移

- [ ] `kind in [bedrock, vertex]` 的旧 provider row 启动后被自动 disable + 标 deprecated
- [ ] 旧 autoManaged provider row 启动后被自动 disable + 标 deprecated
- [ ] POST `/providers` 拒绝创建 `kind in [bedrock, vertex]` 或 `autoManaged: true`（400）
- [ ] 前端 ProviderPanel 顶部 banner 显示"X 个已停用 provider 待迁移"
- [ ] 一键迁移按钮把 deprecated provider 重建为 `openai-compat`，旧 row 删除

### 包装 / 部署

- [ ] `pnpm typecheck` 全 workspace 通过
- [ ] `pnpm desktop:build` 全通过
- [ ] SEA exe 包含 `@openai/agents` 及依赖，OpenAI provider 在装好的 NSIS 包里能跑
- [ ] sidecar SEA 包体积膨胀 ≤ 15 MB（预期 ~5 MB）

### 协议

- [ ] **`shared/src/protocol.ts` ServerMsg union 不变**（验收硬约束；前端 zero 改动）
- [ ] WS 协议 一来一回行为不变

### 文档

- [ ] architecture.md §musistudio 更新为「v0.0.2 起退役」
- [ ] HANDBOOK.md 添加 OpenAI runtime 用法段
- [ ] development-log.md 写 W16 各 commit 记录
- [ ] W14 设计文档加 runtime-aware 说明

---

## 9. 阶段性 rollout

| 阶段 | 范围 | 期望耗时 |
|---|---|---|
| **Phase 1 (v1)** | W16-S0 .. S8 = 抽象层 + 双 runtime + 4 工具 + permission interrupt-resume + musistudio 退役 + 测试 | ~3 周 |
| Phase 2 (v1.1) | OpenAI side ask_user / 完整 permission mode / Grep+Glob 工具 / OpenAI MCP 接入草案 | ~2 周 |
| Phase 3 (v1.2) | 跨 runtime peer_send / Task 在 OpenAI side 用 handoff 实现 | ~1.5 周 |
| Phase 4 (v2) | musistudio 代码移除 / Codex CLI 选项（如有反馈） | 后置 |

---

## 10. 启动前需要确认

1. **是否启动**：v1 ~3 周专注开发，是否值得？相对收益：解锁 OpenAI / 国产模型完整生态，从此不再受 Claude CLI 模型白名单约束
2. **优先级**：相对 W14 (subagent 推荐) 谁先上？建议 **W16 优先**
3. **musistudio 命运确认**：v1 起拒绝新建，旧数据迁移按钮搞定。同意吗？
4. **bedrock / vertex 删除确认**：v1 起 kind 枚举不再含这两个；旧 row disable + migration 按钮（不是删数据）。同意吗？
5. **`openai-local` kind 不引入**：OpenAI 没真正的 OAuth-for-API；用 preset 替代。同意吗？
6. **OpenAI Agents SDK 版本 pin 策略**：建议 latest minor pin
7. **跨平台范围**：v1 是否同时跑通 macOS / Linux？v1 仅 Windows？

---

## 附：参考资料

- OpenAI Agents SDK：<https://github.com/openai/openai-agents-js>
- Claude Agent SDK 现行调用：`core/src/sessions/SessionManager.ts:sendMessage`
- musistudio 现有用法：`core/src/llm-gateway.ts`
- shared 协议：`shared/src/protocol.ts`
- peer-mcp 闭包绑定示例：`core/src/peer-mcp.ts:makePeerMcpServer(sessions, fromAgentId)`
- 触发 W16 的实测：用户 `gpt-5.4` 报错 `There's an issue with the selected model. It may not exist or you may not have access to it.`
- 本文 v1 设计的审阅意见：[`multi-sdk-integration-review.md`](multi-sdk-integration-review.md)

---

## v1 → v2 修订摘要（给后续审阅参考）

| 修订点 | v1 错误/盲区 | v2 修订 |
|---|---|---|
| OpenAI 官方登录形态 | 套用 anthropic-local 概念引入 `openai-local` kind | OpenAI 没 OAuth-for-API；不新增 kind，仅 UI preset |
| RuntimeEvent vs ServerMsg | 拍平到一个 union，两层混淆 | 明确两层：RuntimeEvent (内部) vs ServerMsg (协议)；adapter 在 SessionManager 完成 |
| Schema migration | 完全没提 | §3.4 新增「Schema 与迁移」段 |
| OpenAI SDK 自带工具 | 错以为 SDK 内置 file/shell tools | NormalizedTool 抽象层自实现 4 工具，跨 runtime 复用 |
| permission 跨 runtime | 只说"approval callback，但 mode 定义不同" | 拆出 W16-S5a 独立 stage 处理 interrupt-resume 状态机 |
| musistudio 命运 | "deprecated 但保留" | "v1 拒绝新建 + 一键迁移 + 不再 bootstrap 进程" |
| OpenAI session resume | 评估为劣势（SDK 不支持就砍） | 自维护 history 比 Claude CLI session 更可靠，v1 就实现 |
| systemPrompt 双侧差异 | 表里 ✅✅ 掩盖差异 | 表脚注 + 风险表 + 文档显式说明 |
| §8 验收 | 太空泛"现有功能不退化" | 展开为 30+ 项可勾选 checklist |
| UI 表单 | "改一下文案" | 四态决策树重构（W16-S0 独立 stage） |
| Stage 编号 | 6.x 与 §6 风险章节冲突 | 全改 W16-S* |
| SEA 打包验证 | 未列 | W16-S3.5 独立 stage |
| 估时 | 2 周 | 3 周（含上述新增 stage 与 estimate up） |
| W14 × W16 交互 | 未提 | §6 风险 + W16-S8 文档跟进 |
| 0-model 防线 | 未提 | §6.2 开放问题 6 + §8 验收明确 |
| peer-mcp 闭包风险 | 未提 | §6 风险 + §W16-S2 单测要求 |
| OpenAI runtime abort | 未提 | §6 风险 + §W16-S7 验收 |
