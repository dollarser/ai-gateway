# 2026-11-17 新机器恢复

从 S3 project-backups/20261116T181200Z 完整校验、解密恢复。项目位于 /mnt/nvme7/lingzhang/ai-platform/ai-gateway 和 /mnt/nvme7/lingzhang/ai-platform/model-serving。

ai-gateway 已重建 Python 环境、Node 22 工具依赖及网页资源。model-serving 已建立本项目 Python 环境，复用已下载模型；恢复初期原 asr-tts 用作历史目录，后续已删除，见下文。VibeVoice/FunASR 可编辑安装已迁移到新项目 vendor。Qwen 运行环境使用本机已验证的 vllm/.venv，通过 .venv-llm 链接引用；模型位于 nvme7/models/Qwen/Qwen3.8-27B。

物理 GPU 为 0，Qwen TP=1、上下文32768；其它服务 GPU 亦为0。所有模型同时驻留的显存容量未验证，启动时用 --services 选择需要的子集。

迁移验收结论及恢复来源已汇总到[工作区迁移恢复文档](/home/lingzhang/workspace/MIGRATION_RECOVERY_SUMMARY.md)。本机历史临时资料于2026-11-17整理清除。

Node22 工具：/mnt/nvme7/lingzhang/runtime-tools/node-v22.23.5-linux-x64/bin。执行 npm 维护命令前将该目录放到 PATH 首位。FFmpeg环境：source /mnt/nvme7/lingzhang/runtime-tools/env.sh。

2026-11-17：项目移入 ai-platform 时曾保留兼容软链接，随后按用户要求删除，见下文。

## 新机器服务启动验证

2026-11-17 已启用用户 linger，以及 ai-gateway.service、ai-gateway-tunnel.service 和 ai-gateway-auth-check.timer。用户确认旧机器隧道已停止，切换前查询也确认无活动连接器。切换后隧道仅显示新机器 18.224.54.97 的连接器。

本机 systemd 用户管理器 PATH 缺少 /usr/bin 和 /bin，导致启动脚本无法调用 bash 与 dirname。三个服务模板已显式设置 PATH，重新执行 scripts/ops/install-user-services.sh 后生效。

本机 18900 健康检查成功。公网 https://api.hilex.me/healthz 返回 ready=true、openai_transport=local。部署检查通过 accounts、gateway、authentication、internal_authentication 四项，定时鉴权检查手动执行成功。model-serving 按本次要求保持停用。

当前部署环境未提供 AI_API_KEY 或 AI_ACCESS_TOKEN，聊天、ASR、TTS 的认证业务请求尚未验证。运行环境未安装 pytest，本次未重跑 Python 测试套件；上文176项是恢复阶段的测试记录。本次服务模板通过 systemd-analyze --user verify。

## 删除旧项目及兼容路径

2026-11-17 按用户要求删除 /mnt/nvme7/lingzhang/asr-tts，以及顶层 ai-gateway、model-serving 两个兼容软链接。项目统一使用 /mnt/nvme7/lingzhang/ai-platform 下的子项目路径。systemd 服务模板和已安装单元、虚拟环境入口及可编辑安装路径已同步修复。新项目权重通过硬链接保留，检查确认无指向旧 asr-tts 的软链接依赖。

模型启动入口加载 runtime-tools/env.sh，LLM 启动器将解释器所在 bin 加入 PATH，使动态库和 ninja 可用。Qwen 使用现有 SGLang 环境，GPU 0、TP=1、32768 上下文、MTP、mem-fraction-static=0.90。尝试0.65时缓存预算不足，已恢复0.90。

## 当前功能与验证（2026-11-17）

以上停用和未验证描述为恢复阶段记录。后续已开放本地Qwen及Embedding的公网模型发现，并完成真实公网调用；新增OpenAI text-embedding-3-small，仍经本机中继。邮箱找回密码、原用户名和旧密码改密、Turnstile及安卓接入说明已上线。

最近资源优化发布完成177项Python测试、98项Worker测试及浏览器回归；全站费用和个人月token汇总与明细核对一致。服务参数及完整启动记录以model-serving项目和运行时接口为准；客户端协议见[交接文档](client-handoff.md)，资源优化见[资源策略](resource-efficiency.md)。
