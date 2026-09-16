# 解放模型能力：Capability Registry 与 ResolvedRunPlan 总方案

> 2026-09-16 复审、已修回归与剩余实施项见
> [`model-capability-audit-2026-09-16.md`](./model-capability-audit-2026-09-16.md)。

> 状态：已拍板，待分阶段实施（2026-09-15）  
> 主线优先级：本方案高于 context-window 展示与 provenance 精修。后者只能作为本方案的输入或后续 UI 消费者，不得阻塞阶段 0～2。  
> 当前工作树：E开发 的 context-window 改动保持未提交并冻结边界；本文件只记录新主线，不代表那些改动已验收。

## 1. 目标与根因

目标不是逐个调大上下文、回合数或字符常量，而是解除 Ensemble 对模型、Runtime 和 SDK 能力的错误限制，让每个模型按其真实能力运行。

当前根因是 Provider、Runtime、SessionManager、SDK adapter 和 UI 各自猜测能力。同一模型因此可能在设置页、`/status`、历史重建和实际 SDK 请求中得到不同结论。修复方式是建立唯一的能力解析层，并在每轮开始前生成一份不可变执行快照。

```text
用户覆盖 / Runtime 实测 / Provider 发现 / 已确认目录
                         │
                         ▼
                Capability Registry
                         │
                         ▼
                 ResolvedRunPlan
            ┌────────────┼────────────┐
            ▼            ▼            ▼
         Runtime        SDK        UI /status
```

能力事实优先级：

```text
用户明确覆盖
> 当前会话或 Runtime 实测
> Provider 动态发现
> 已确认模型目录
> unknown
```

`unknown` 必须保持未知。禁止静默回落到另一种 transport、另一模型家族或保守硬编码常量；所有 fallback、降级和未验证值必须进入诊断并对用户可见。

## 2. 核心不变量

1. 每轮只解析一次 `ResolvedRunPlan`；Runtime、SDK、工具、UI 和 `/status` 只能消费该快照，不能二次推断。
2. 官方 OpenAI 端点使用 Responses，不再进入 `/chat/completions`。
3. 模型回合不设全局 10 回合硬上限；安全由取消、预算提示、循环检测和活性状态机负责。
4. 历史预算按 token 和模型能力计算，不再按消息数或字符数截断。
5. 所有 Runtime 共用通用 `projectRoot`；文件工具、Shell、技能、项目指令和子智能体 cwd 一致。
6. reasoning 是模型能力，不是 Provider 名称能力；UI 选项和实际 SDK 参数来自同一 RunPlan。
7. Skill 只能完整加载或明确 deferred，绝不截取半份 `SKILL.md` 注入。
8. compact 不删除原始 transcript；压缩结果必须可追溯覆盖范围和哈希。
9. 单纯长时间没有文本不等于进程死亡。
10. 大型 peer/subagent 结果必须以可分页、可搜索、可校验的 Artifact 保存，不能不可恢复地截断。

## 3. 数据模型

```ts
interface ResolvedRunPlan {
  identity: {
    providerId: string;
    providerScope: string;
    runtime: string;
    transport: "responses" | "chat-completions" | "native-cli";
    modelId: string;
    runtimeVersion?: string;
  };

  capabilities: {
    advertisedContextWindow?: number;
    runtimeEffectiveWindow?: number;
    maxOutputTokens?: number;
    reasoningLevels?: string[];
    defaultReasoningLevel?: string;
    supportsResponses: boolean;
    supportsServerConversation: boolean;
    supportsNativeCompaction: boolean;
    source: string;
    confidence: "observed" | "confirmed" | "unverified";
  };

  execution: {
    reasoningEffort?: string;
    maxModelTurns: number | null;
    projectRoot?: string;
  };

  context: ContextBudgetPlan;
  history: HistoryPlan;
  skills: SkillLoadPlan;
  liveness: LivenessPlan;
  diagnostics: ResolutionDiagnostic[];
}
```

能力注册表至少区分以下来源与作用域：

- `vendor/model`：厂商确认的模型能力。
- `runtime/vendor/model/version`：特定 Runtime 版本的已验证有效能力。
- `provider/transport/model`：Provider 动态发现或兼容端点声明。
- `session observation`：本会话真实返回的数据。
- `user override`：用户显式覆盖，但不得伪装成 Runtime confirmed policy。

旧 `models.*.maxInputTokens` 仅作为 advertised 显示覆盖，标记 `legacy/unverified` 并提示迁移；它不能声明 Runtime 能力，也不能取消独立存在的 confirmed runtime policy。

## 4. 主线实施阶段

### 阶段 0：Capability Registry + RunPlan 骨架（最高优先级）

- 建立 `ModelCapabilities`、来源/置信度、结构化诊断和 resolver。
- 建立 immutable `ResolvedRunPlan`，在每轮开始时解析并贯穿调用链。
- SDK adapter、Runtime 和 `/status` 先接入同一快照，即使部分字段仍为 unknown。
- 锁定关键 SDK 版本，并用 contract test 固定实际发出的参数。
- 禁止在消费者中新增任何模型名、Provider kind 或常量猜测。

阶段门禁：能证明 UI/`/status` 所见 transport、reasoning、context 与 SDK 实际参数来自同一 RunPlan。

### 阶段 1：首先释放执行能力

- `openai-local`（官方 OpenAI）强制 Responses。
- `openai-compat` 增加显式 `auto | responses | chat` transport；`auto` 的探测结果缓存到 provider + base URL 作用域。
- 自动降级必须产生可见诊断；认证、配额、参数和业务错误不得误判为 transport 不支持。
- 移除 SDK 的 10 回合硬上限，使用 `maxTurns: null` 或等价无限配置。
- reasoning 按当前模型能力解析和校验，协议允许开放字符串；`inherit` 永远存在。

阶段门禁：官方 OpenAI 请求不进入 Chat Completions；15 个以上连续工具回合可完成；不支持的 reasoning 返回结构化错误且不被静默清空。

### 阶段 2：通用项目工作区

- 新增 `Agent.projectRoot`，迁移现有 `codexWorkspace`，不复用语义含混的旧字段。
- Claude、Codex、OpenAI、文件工具和 Shell 全部从 RunPlan 获取 cwd。
- 子智能体默认继承 `projectRoot`，仅允许创建时显式覆盖。
- 项目技能扫描 `.agents/skills`、`.codex/skills`、`.claude/skills`。
- API Runtime 由 Ensemble 注入项目指令；原生 CLI 设置 cwd，避免重复注入。
- 未绑定项目时使用 per-agent scratch 目录，并在 UI 明示“未绑定项目”；禁止默认使用用户主目录。

阶段门禁：三种 Runtime 的相对路径、Shell cwd、项目指令和技能发现目录一致。

### 阶段 3：历史、Skills 与 Compact

- 删除关键上下文路径上的 28 条、18K/60K 字符等硬截断，以 token budget 取代。
- Responses 优先使用服务端会话延续；兼容端点才由本地重建历史。
- 预算显式预留输出、工具结果和安全余量，超限时才触发无损压缩策略。
- Skill 状态明确为 `discovered → selected → loaded | deferred`；显式调用无法完整加载时直接报错。
- 中文技能路由采用 Unicode NFKC、`Intl.Segmenter`、CJK n-gram、多语言 triggers/examples；低置信零命中时才使用语义路由。
- Responses 可用时优先原生 compact；其他 Runtime 使用按 token 分块的层级总结。
- 原始消息永久保留；每个总结记录消息范围、哈希、版本和结构化关键事实。

阶段门禁：超过 28 条/18K 字符的关键事实仍可用；第 4,000 字符后的 Skill 标记能到达模型；200K 历史 compact 覆盖率 100% 且原文可恢复。

### 阶段 4：活性状态机与 Artifact

```text
running
→ suspected-stall（只警告）
→ health-check
→ confirmed-dead | user-cancelled | completed
```

- 分别记录模型流事件、网络连接、工具进度、子进程存活、权限等待和用户输入等待。
- 默认不因单纯静默终止；硬 wall-clock 上限由用户配置。
- peer/subagent 大结果写入 Artifact，聊天消息只携带摘要与句柄。
- 提供 `artifact_read`、`artifact_search`、cursor、`endReached` 和 SHA-256 校验。
- 删除或绕开不可恢复的 1.6K/4K/5K/8K/12K 多层截断，并纠正“可完整读取”的虚假提示。

阶段门禁：fake clock 下静默 7 分钟但进程存活时不终止；100KB 结果可按哈希完整读回。

### 阶段 5：UI 能力检查器与展示收口（低于上述主线）

- 设置页的 Transport、Reasoning、Project、Context、History、Turn/Liveness 全部渲染 RunPlan。
- 无效项禁用并解释原因；切换模型导致原值失效时要求确认，不得静默删除。
- Context bar 展示 effective 使用量、advertised 上限、输出预留、compact 状态和 degraded/unknown。
- `/status` 输出 RunPlan identity、来源、置信度和全部诊断。

context-window 的颜色、tooltip、legacy badge、百分比样式等展示精修全部属于本阶段。它们不能先于阶段 0～2，也不能决定 Runtime policy。

## 5. 明确禁止

- 禁止继续通过“调大一个常量”掩盖模型能力解析缺失。
- 禁止根据模型名前缀在 UI、SessionManager 或 adapter 中各自推断能力。
- 禁止官方 OpenAI 因 Responses 请求失败而对任意错误静默切到 Chat。
- 禁止用 advertised context window 充当已验证的 runtime effective window。
- 禁止用 legacy override 获得 runtime 声明权限。
- 禁止以字符数或消息数删除关键历史、Skill 正文或子智能体结果。
- 禁止让展示层完善阻塞 Capability/RunPlan、Responses、回合限制和 projectRoot 主线。
- 禁止把当前 context-window 未提交 diff 与阶段 0 混成一个不可审计的大 diff。

## 6. 全局验收

- 官方 OpenAI 请求不再进入 `/chat/completions`。
- 15 个以上模型工具回合正常完成。
- 超过 28 条、18K 字符的关键历史仍可被模型使用。
- Claude、Codex、OpenAI 的相对路径与 Shell cwd 一致。
- Skill 第 4,000 字符后的测试标记仍能到达模型。
- 200K 文本中间的关键约束经过 compact 后仍存在，覆盖率 100%，原文未删。
- 后台静默 7 分钟但进程存活时不被终止。
- 100KB 子智能体结果能够按 SHA-256 完整读回。
- 所有 unknown、fallback、transport 降级在 UI 和 `/status` 可见。
- UI 展示值与真正发送给 SDK 的参数来自同一份 RunPlan。

## 7. 交付纪律与下一步

- 每阶段独立 diff、独立测试、独立复核，默认保持未提交直到验收。
- 阶段 0 不顺手实现阶段 1，也不回头精修 context-window UI。
- 当前 context-window 工作只保留其中可复用的 Registry 输入、观测数据和测试；展示细节冻结。
- 下一项实施工作是阶段 0：先交 `ModelCapabilities + ResolvedRunPlan` 骨架、解析优先级、诊断与 contract tests。
