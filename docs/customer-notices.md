# 客户端用户通告

用户通告独立于仅管理员可见的运维告警。无需新增中间件，Worker 提供接口，D1 保存通告和按账号共享的已读记录。网页入口：https://accounts.hilex.me/#notices 。管理员在“通知 → 发布与管理用户通告”保存草稿，再明确点击发布；支持全体账号和最多 100 个指定账号。全体范围包含发布后注册的新账号，通告持续有效时均可见。

## 生命周期与权限

- 草稿不可被普通账号读取；可编辑，使用 version 防止并发覆盖。
- 发布后内容、接收范围和时间固定。修订需撤回后新建，获得新的 ID 和未读状态。
- starts_at 到达后才可见；expires_at 到达或撤回后不再返回。不需要定时任务激活，接口按服务器时间判断。
- 撤回无法收回客户端已经下载、截图或离线缓存的内容。客户端每次刷新必须替换当前有效列表，不能只追加。
- 读状态按账号同步到全部设备。标记已读不会改变其他账号状态；禁用账号、过期会话沿用现有鉴权规则。
- 正文为纯文本，禁止客户端把正文当 HTML 渲染。标题最多 160 字符，正文最多 8000 字符，JSON 请求体最多 64 KiB；不提供附件或脚本。
- 通告与已读记录持久保存，没有自动删除历史通告的任务；当前后台每页 30 条。用户删除时其已读记录级联删除。

## 客户端接口

基础地址为 **https://accounts.hilex.me**，不是 api.hilex.me。使用登录返回的 `Authorization: Bearer <access_token>`，不要使用模型 API Key；这些账号接口不需要 X-Client-ID。网页 Cookie 调用写接口仍须 X-CSRF-Token。首次强制改密的账号应先改密。

### 获取当前有效列表

`GET /account/notices?page=1&state=all`；state 可为 all 或 unread，page 为 1..1000，每页固定 30 条。

```json
{
  "page": 1,
  "page_size": 30,
  "total": 1,
  "unread": 1,
  "items": [{
    "id": "48位十六进制通告ID",
    "title": "服务更新",
    "body": "新功能已上线。\n请更新客户端。",
    "priority": "important",
    "starts_at": 1794780000,
    "expires_at": null,
    "published_at": 1794780000,
    "version": 2,
    "read_at": null
  }]
}
```

total 和 unread 始终是账号当前有效通告的总数和未读数，不因 state 筛选变化。items 按发布时间降序、ID 降序排列；翻页期间若出现新通告，从第一页刷新并按 ID 去重。时间均为 Unix 秒；null expires_at 表示长期有效，null read_at 表示未读。priority 为 normal 或 important。用户响应不包含接收账号名单或管理审计信息。

`GET /account/notices/unread-count` 返回 `{"unread":1}`，适合角标轮询。

### 标记已读

`POST /account/notices/read`，JSON 为 `{"ids":["通告ID"]}`，一次 1..100 个不重复 ID。重复提交同一已读记录是幂等的，保留第一次阅读时间。成功返回 `{"ok":true,"unread":0}`。

提交中若包含不存在、未生效、已过期、已撤回或不属于此账号的 ID，返回 404，不透露通告是否属于其他账号；客户端重新获取有效列表。参数错误 422；会话无效 401；权限或强制改密限制 403。接口响应 Cache-Control: no-store。

## 管理接口

仅已完成改密的管理员可访问，操作写入 audit，审计不复制正文。

- `GET /admin/notices?page=1`：分页查看全部状态及接收名单。
- `POST /admin/notices`：创建草稿，返回 id、state、version。
- `PATCH /admin/notices/{id}`：完整替换草稿内容，必须提交当前 version。
- `POST /admin/notices/{id}/publish`：提交 `{"version":1}` 发布；未来 starts_at 自动延后可见，过期草稿不能发布。
- `POST /admin/notices/{id}/withdraw`：提交当前 version 撤回已发布通告。

创建/修改内容：

```json
{
  "title": "服务更新",
  "body": "公告正文",
  "priority": "normal",
  "audience": "users",
  "user_ids": [12, 34],
  "starts_at": 1794780000,
  "expires_at": null
}
```

all 范围要求 user_ids 为空；users 范围必须提交 1..100 个存在且不重复的账号 ID。未提供 starts_at 时立即生效；expires_at 必须晚于 starts_at。编辑、发布、撤回成功后 version 递增；409 表示版本冲突或状态不允许，刷新后再操作。已撤回通告不能重新发布。

## 客户端接入建议

登录后、恢复前台时查询未读数量，运行期间约每三分钟检查一次并加入少量随机抖动；进入通知列表时刷新列表。网络失败保持退避，401 沿用账号令牌刷新流程，避免每条通告分别轮询。真正打开详情或用户明确点击时才上报已读，不在收到通告时自动标记。按账号隔离本地缓存，退出登录清除，正文以文本渲染。

当前网页已实现通知列表、角标、已读和管理入口，页面可见时三分钟检查角标，恢复可见时立即检查。外部原生客户端仍需实现自己的 UI 和调用；此版本没有长连接、短信、邮件或应用关闭后的系统推送。
