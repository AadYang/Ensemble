# Subagent 推荐功能（W14 提案）

> **状态**：📝 设计落盘，未实施（v2 修订 2026-05-11：去掉切 Haiku，改 prompt 优化）
> **目标**：用户点「+ 子 Agent」时，基于父 agent 当前对话内容，推荐 3 个最合适的子 agent 模板（如 reviewer / tester / debugger），第 4 项永远是「自己创建」兜底。
> **触发动机**：降低多 agent 协作的冷启动成本；新用户面对空白「创建 agent」框时不知道叫什么、写什么 systemPrompt。
> **关键约束（v2）**：W16 之后系统支持任意 anthropic-compat / openai-compat 第三方供应商，**这些供应商不一定有 Haiku 等价的"更快档"模型**（MiniMax 单档、timicc 只暴露 gpt-5.2 系列等）。所以 v2 去掉「强制切 Haiku」假设，沿用父 agent 当前 model，通过**输入输出 prompt 双向瘦身**来压缩生成耗时；接受速度提升不明显的事实，把"推荐功能能用"看得比"推荐很快"重要。

---

## 1. 关键设计决策（与"先想到的方案"对比）

| 维度 | 否决方案 | 采纳方案 | 理由 |
|---|---|---|---|
| 触发路径 | 让父 agent 在 chat 里调 MCP 工具生成推荐 | UI 按钮 → server 端独立一次性 query | 推荐是 meta UI 操作，不该污染主对话历史；不该要求父 agent 在线 |
| 生成模式 | 自由生成（让模型从零写 name / systemPrompt） | 内置目录 + 模型挑选填充 | 自由生成稳定性差（中英混乱、角色泛化、JSON 格式失败），目录稳定 10 倍 |
| 模型选择 | 强制切到 Haiku 等价的"更快档" | **沿用父 agent 当前 model**（含 provider）；用 prompt 瘦身换速度 | W16 后第三方 provider 不一定有"更快档"（MiniMax 单档、timicc 只露 gpt-5.x 系列）；强切会破坏 provider 抽象。可接受推荐响应同 model 的常规生成时间（5-10s on Opus / sonnet），把可用性看得比延迟重要 |
| 历史范围 | 全部消息 | 最近 **N=10** 条且只取 user + assistant text、每条 head 截 200 字符 | 进一步压缩输入 token：v1 设计是 N=20 + 全文；v2 改 N=10 + truncate，~50% input 削减 |
| 输出 schema | 让模型生成完整 systemPrompt 段落（每个 ~500 token） | 只让模型给 `{key, hint<=80字}`，server 端把目录模板填回去 | 输出 token 是 wall-clock 主要变量；模型只给"挑哪 3 个 + 一句话定制化提示"，systemPrompt 模板由 server 字符串拼装。1500 token output → 100 token output |
| 输出格式 | 自由文本再 parse | SDK structured output / strict JSON schema | 避免 90% 格式失败 |
| 失败兜底 | 报错 toast 让用户重试 | 自动 fallback 到目录前 3 个静态默认项 | 用户不该因为推荐服务挂了就用不了「+ 子 agent」 |
| 缓存 | 无 | content-hash → 30s TTL | 避免重复点击重复扣费 |
| 触发位置 | 替换现有 `+ create_agent` | **新加按钮**（在 AgentSettings / AgentTree） | 直接新建是 0 延迟现有路径，别强迫所有人都先看推荐 |

## 2. 内置目录（初版）

每个 entry：`{ key, displayName, description, systemPromptTemplate }`（去掉 v1 的 `suggestedModel?` 字段——v2 不切 model）

| key | 适用场景 | systemPrompt 模板要点 |
|---|---|---|
| reviewer | 父 agent 在写代码 | 评审视角：可读性 / 正确性 / 边界；不要直接改，给清单 |
| tester | 父 agent 写完功能 | 写测试用例 + 边界 case；用项目现有测试框架 |
| debugger | 父 agent 在 debug | 复现 → 二分定位 → 最小修复，不要改无关代码 |
| planner | 父 agent 接到大任务 | 拆步骤 + 验收标准（CLAUDE.md 准则 4） |
| refactorer | 父 agent 抱怨结构差 | 行为不变；先列出风险点再动 |
| security-auditor | 父 agent 在写认证/加密/输入校验 | OWASP top 10 视角；列出威胁模型 |
| doc-writer | 父 agent 完成功能 | 写 README / API 文档；用项目现有风格 |
| api-designer | 父 agent 设计接口 | RESTful / 版本兼容 / 错误码规约 |

systemPromptTemplate 里允许 `${PARENT_CONTEXT_HINT}` 占位符——server 端把模型给的 ≤80 字 hint 塞进去（不是塞对话摘要，模型只产 hint 不产摘要）。

## 3. 协议 / API

### 新增 REST endpoint

```
POST /agents/:id/suggest-children
  → 200 { suggestions: [{ key, name, displayName, systemPrompt, model }, x3] }
  → 503 { error: "suggestion_unavailable" }（内部失败时返回，前端 fallback 到静态目录前 3 个）
```

为什么 REST 不走 WS：一次性请求-响应，不需要流式；REST 拦截器层（错误处理 / 限流）更成熟。

### 不动现有协议

`create_agent` ClientMsg 完全不变。前端用户点确认后还是走老路径，suggestions 只是把 name/systemPrompt 字段预填好。

## 4. 实施切片

| 阶段 | 工作量 | 产出 |
|---|---|---|
| 4.1 后端目录 + endpoint | 半天 | `core/src/subagent-catalog.ts` 静态目录（runtime-agnostic）；`POST /agents/:id/suggest-children` 路由；带 `Map<sessionHash, suggestions>` 30s TTL 缓存 |
| 4.2 推荐 prompt | 半天 | 调父 agent 自己的 runtime（chooseRuntime + 父 providerId/model），strict JSON schema 输出 ≤100 token；server 端用目录模板拼回 systemPrompt |
| 4.3 前端弹窗 | 半天 | `<SuggestSubagentDialog>`，4 张卡：3 推荐占位骨架（loading）+ 「自己创建」永驻；点击卡 → 预填 create_agent 表单 → 保留用户编辑机会再确认 |
| 4.4 触发入口 | 0.5h | AgentSettings 加 "建议子 agent" 按钮（独立于现有 `+ child`） |
| 4.5 失败兜底 | 0.5h | 接口 503 / 超时 **15s** → 前端直接展示目录前 3 个，不弹错误（超时阈值从 v1 的 5s 拉到 15s，因为不切 Haiku 后第一响应时间可达 10s+） |

总约 **1.5–2 个工作日**。

## 5. 数据流细节

```
点击建议按钮
  ├─ 前端立即弹 dialog，3 张骨架卡 + 「自己创建」按钮
  ├─ 前端 POST /agents/:id/suggest-children
  │
  └─ server:
      1. 读 prisma.message.findMany({ agentId, take 10, orderBy createdAt desc })
         - 比 v1 减半，进一步压输入 token
      2. 过滤 type in ['user','assistant']，提取 text；丢掉 tool_use / tool_result
         - 每条 text 截 head(200) 字符，避免长贴码 / 大 stack trace
      3. hash(messages) → 查缓存 → 命中直接返回
      4. 未命中 → 通过 chooseRuntime(parent.provider.kind) 调父 agent 自己的 runtime：
         - prompt 模板（极简，~150 token system instruction）:
             """
             最近父 agent 对话:
             ${HISTORY_10_CHUNKS_OF_200_CHARS}

             从以下角色 keys 选 3 个 (按相关性降序):
             ${CATALOG_KEYS_AND_ONE_LINE_DESCS}

             仅输出 JSON，无解释:
             {"picks":[{"key":"<key>","hint":"<≤80字定制化提示，可空>"},{...},{...}]}
             """
         - options: { model: parent.model, mcpServers: {}, tools: [], maxTurns: 1, history: [] }
         - 期望模型输出 ≤100 token: 3 个 keys + 3 段 ≤80 字 hint
         - strict JSON parse + 一次重试
      5. server 端拼装 systemPrompt:
         - 每个 pick: catalog[pick.key].systemPromptTemplate.replace("${PARENT_CONTEXT_HINT}", pick.hint || "")
         - 模型不再生成完整 systemPrompt，避免 1000+ token 输出延迟
      6. 写缓存（key = sessionHash, ttl 30s）
      7. 返回 3 项
```

**速度预期（v2 诚实告知）**：
- v1 估的 1-2s 基于 Haiku 出口。v2 沿用父 model，第一字 wall-clock 可能 5-10s（Opus 级），完成可能 8-15s
- prompt 瘦身（input -50% token + output -90% token）能挤出约 20-40% 的相对速度提升，但绝对值仍取决于父 model
- 前端有骨架 + "自己创建"永驻可点，体感不算糟。如果未来要进一步降延迟，**改 streaming**（picks 按字段流式收）比切 model 更通用

## 6. UX 细节

- **骨架卡**：不要让用户盯空白看 5 秒；骨架占位 + shimmer 动画
- **预填后允许编辑**：点卡后不直接 create，而是预填到现有 create_agent 表单（name + systemPrompt），用户可改完再点确认
- **「自己创建」永驻第 4 位**：永远可点，不被推荐流程阻塞
- **超时阈值**：前端 setTimeout 5s，超时直接 fallback 到静态目录前 3 个；不弹错误 toast
- **再生成按钮**：右上角小图标"🎲 换一批"，触发 `?force=true` 跳过缓存

## 7. 与现有架构的兼容点

- **不动 SessionManager.sendMessage**：suggest 走独立 REST 路径，不进 SessionManager
- **不动 WS 协议**：纯 REST + 复用现有 `create_agent` WS
- **复用现有 Provider / Runtime 路由**：suggest 走 `chooseRuntime(parent.provider.kind)` + 父 agent 的 model；不引入"特殊模型选择"逻辑。Claude side 是 ClaudeAgentRuntime → claude CLI；OpenAI side 是 OpenAIAgentRuntime → @openai/agents。两边输出 JSON 解析逻辑一致
- **i18n 现有 key 复用**：`agent.create` `agent.namePlaceholder` 等

## 8. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| 推荐过度泛化（3 个全是 helper） | 内置目录约束角色；让模型只能从目录挑，不能自创 |
| 隐私：对话内容送给推荐模型 | 与父 agent 用的是同 provider，跟它本身的对话同信任域；可加全局开关 `ensemble.suggestSubagents.enabled`，默认开 |
| 每次点都是钱 | content-hash 缓存（30s TTL）+ input/output prompt 双向瘦身让单次成本接近忽略；可加用量计数 |
| 父 agent 是新建的（无对话历史）→ 推荐什么 | 检测到 history.length === 0 → 直接走静态目录前 3 个，不调模型 |
| 父 model 是慢的 Opus 级，10s+ 才回 | 前端骨架 + 15s 超时 fallback 静态目录；用户可"自己创建"永驻按钮立即跳过等待 |
| 第三方 provider 不支持 JSON-only 输出（吐解释 / markdown 包裹） | strict parse + 一次重试；都失败则 fallback 静态目录前 3 个。**不做 model 切换**——和 v2 设计原则一致 |

## 9. 显式不做（避免范围蔓延）

- 不做「推荐子 agent 的子 agent」（递归推荐）
- 不做基于历史使用习惯的个性化推荐（无 metric pipeline）
- 不做团队/组织级别的目录共享（单机产品）
- 不做 fine-tune 的角色推荐（成本不匹配）
- 推荐结果**不持久化**到 DB（只是 UI 临时态）

## 10. 验收标准

- [ ] AgentSettings 出现「建议子 agent」按钮；点击后 ≤ 200ms 弹出 4 张卡（含 3 骨架 + 1 永驻）
- [ ] 15s 内 3 张骨架被替换为推荐内容（typical: 父 model 的常规一次往返时间——Sonnet/Opus 约 5-10s，第三方供应商可能更慢，都可接受）
- [ ] 超时（>15s）或网络/模型失败时无 error toast，自动 fallback 到目录前 3 个
- [ ] 点推荐卡 → 预填 create_agent 表单可编辑 → 确认后正常创建子 agent（继承 parentId）
- [ ] 同一 agent 30s 内重复点击命中缓存（看 server 日志只有 1 次模型调用）
- [ ] 父 agent 历史为空时直接静态目录，不发模型请求
- [ ] AgentTree 自动嵌套渲染新子 agent
- [ ] Claude side（anthropic-local）与 OpenAI side（openai-compat）两个 runtime 都能产生可解析的推荐 JSON

---

## 附：实施前需要再讨论的点

1. systemPromptTemplate 用 `${PARENT_CONTEXT_HINT}` 占位（v2 确定）还是让模型整段重写？已确定**前者**——v2 的 prompt 瘦身就靠这个决策。
2. 「建议子 agent」按钮放 AgentSettings 弹窗里还是 AgentTree 行内（齿轮按钮旁边）？倾向**齿轮旁边**，发现性更好。
3. 是否给目录加权重（基于父 agent 文件类型 / cwd 推断领域）？v1 不做，v2 看用户反馈。
4. JSON 输出严格性：strict_schema 还是 string parse 加重试？倾向**字符串 parse + 一次重试**，跨 runtime 一致；strict_schema 只在 OpenAI side 才有原生支持，Claude side 要走 prompt 工程实现等价行为，不如统一字符串 parse 简单。

## 附 2：v1 → v2 修订差异

| v1 决策 | v2 决策 | 原因 |
|---|---|---|
| 强制切到 Haiku | 沿用父 agent 当前 model | 第三方 provider 不一定有 "更快档"；保持 provider/runtime 抽象一致 |
| `suggestedModel?` field in catalog | 删除该字段 | 不再切 model 就不需要 |
| history N=20 全文 | N=10 + 每条截 200 字符 | 输入 token 减半 |
| 输出整段 customizedSystemPrompt（~500 token/项） | 输出 `{key, hint<=80字}`（共 ~100 token） | 输出 token 是 wall-clock 主要变量；server 拼模板 |
| 超时 5s | 超时 15s | 不切 Haiku 后第一字延迟变长，5s 太严 |
| 速度预期 1-2s | 5-15s | 诚实告知；可用性 > 延迟 |
| `agentorch.suggestSubagents.enabled` | `ensemble.suggestSubagents.enabled` | 命名跟项目重命名 |
