# 与 sglang-gateway 的关系

对照 [dollarser/sglang-gateway](https://github.com/dollarser/sglang-gateway) 的 README、app.py 和 store.py：ai-gateway 已替代旧项目的主要在线服务职责，但不是所有 CLI 和可选功能的逐项兼容实现。

## 已承接的能力

| 旧项目能力 | 当前实现 |
|---|---|
| API Key 验证、过期、撤销 | Worker/D1 账号和密钥管理 |
| 频率、额度与并发控制 | 以账号为主，D1 原子检查请求占用；保留迁移 Key 的 token 基线 |
| OpenAI HTTP / SSE 转发 | gateway/router.py、gateway/openai.py |
| developer 角色、思考强度兼容、上下文重试 | gateway/llm.py |
| 上下文窗口、余量和 token 统计 | 模型发现、请求预算限制及用量结算 |
| 公网 Tunnel 入口 | 当前 API 隧道连接统一网关 |

ai-gateway 另外提供账号注册登录、管理网页、登录令牌、Worker/D1、多模型服务路由、ASR/TTS、WebSocket 和合并模型发现。

生产网关不依赖旧的 2233 进程或旧仓库目录，LLM 上游直接配置为模型服务。

## 没有逐项复刻的部分

- 旧项目每把 Key 独立配置 RPM、并发、每日 token 的 CLI；当前主要按账号管理权限、请求次数与并发。迁移 Key 的旧 token 额度继续有效，新 Key 不自动拥有所有旧 CLI 参数。
- 旧项目按拒绝原因、IP、Key 查询的细粒度请求审计 CLI；当前有账号操作审计、已接纳请求用量、认证失败计数和服务日志，数据模型不同。
- 旧的 run.sh 进程管理与部分配置开关。
- 旧项目的 SGLANG_API_KEY 上游凭据注入和 CORS 配置项。
- 旧白名单中的 rerank/score 通用转发；当前只开放已登记和实际接入的服务路径。

这些差异不影响当前已部署模型入口的替代关系，但不能把“主要在线职责已承接”写成“全部功能完全等价”。如果未来业务需要其中某项，应按当前 Worker/网关边界增加能力和测试，不重新启动第二套鉴权网关。

旧仓库可作为历史参考，不需要作为当前生产依赖。是否归档旧 GitHub 仓库是独立操作；本次没有修改或删除该远端仓库。

## 代码对照

- [旧网关职责与配置](https://github.com/dollarser/sglang-gateway/blob/main/README.md)
- [旧 HTTP/鉴权实现](https://github.com/dollarser/sglang-gateway/blob/main/app.py)
- [旧配额与审计存储](https://github.com/dollarser/sglang-gateway/blob/main/store.py)
- [当前统一网关](unified-gateway.md)
- [当前账号部署](cloudflare.md)
