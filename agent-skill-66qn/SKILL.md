---
name: agent-skill-66qn
description: 66qn 我的世界服务器开放平台技能。可为本服务器的玩家执行每日签到、查询电力余额、查询账号信息、增加/扣减电力。适用于"帮我签到""查询电力""给某人加电力"等请求。
---

# 66qn 服务器开放平台

通过 66qn 网站的开放接口操作玩家账户。所有请求只需一个 UID（形如 `ok_xxxxxxxx...` 的 51 位字符串），由管理员在网站后台「开放平台」创建开放账号时生成。

## 调用方式

所有操作都调用同一个接口：

```
POST https://iywntwllhjbubmhtacdp.supabase.co/rest/v1/rpc/open_api
Content-Type: application/json
apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml5d250d2xsaGpidWJtaHRhY2RwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE2MzA5NjQsImV4cCI6MjEwNzIwNjk2NH0.JZqv3wA6RM3Tzz9Hli3TJZb1lxmmEqlBQMGJAdk1rQQ
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml5d250d2xsaGpidWJtaHRhY2RwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTE2MzA5NjQsImV4cCI6MjEwNzIwNjk2NH0.JZqv3wA6RM3Tzz9Hli3TJZb1lxmmEqlBQMGJAdk1rQQ

{"p_uid": "<UID>", "p_action": "<动作>", "p_username": "<玩家昵称，可选>", "p_amount": 100}
```

anon key 是公开的，真正的凭证是 `p_uid`。返回 JSON：成功 `{"ok": true, ...}`，失败 `{"ok": false, "error": "原因"}`。**必须检查 `ok` 字段。**

## UID 的存放约定

按顺序查找 UID，找到即用：
1. 环境变量 `QN66_UID`
2. 本技能同目录下的 `uid.txt`（只放 UID 一行）
3. 向用户索要（用户可从网站后台「开放平台 → 查看 UID」复制）

拿到新 UID 时写入 `uid.txt` 保存，下次直接使用。

## 动作一览

| p_action | 必填参数 | 说明 |
|---|---|---|
| `ping` | 无 | 连通性测试，返回账号名和绑定玩家 |
| `get_power` | `p_username`（若账号未绑定玩家） | 查询电力余额，返回 `{"ok":true,"username":"...","power":1234}` |
| `checkin` | `p_username`（若账号未绑定玩家） | 每日签到 +100 电力，同一天重复签到 `gained` 为 0，不算错误 |
| `get_info` | 同上 | 查询账号信息（昵称/游戏 ID/电力/状态等） |
| `add_power` | `p_username` + `p_amount`(1-100000) | 增加电力 |
| `deduct_power` | `p_username` + `p_amount`(1-100000) | 扣减电力，余额不足会失败 |

## 标准流程

### 每日签到（最常用）

```bash
curl -s -X POST "https://iywntwllhjbubmhtacdp.supabase.co/rest/v1/rpc/open_api" \
  -H "Content-Type: application/json" \
  -H "apikey: <ANON_KEY>" \
  -H "Authorization: Bearer <ANON_KEY>" \
  -d '{"p_uid":"<UID>","p_action":"checkin"}'
```

成功返回 `{"ok":true,"username":"...","gained":100,"power":<签到后电力>}`。`gained:0` 表示今天已签过，直接告知用户即可。

若开放账号绑定了玩家，可省略 `p_username`；未绑定则必须传 `p_username`。

### 查询电力

```bash
curl -s -X POST "https://iywntwllhjbubmhtacdp.supabase.co/rest/v1/rpc/open_api" \
  -H "Content-Type: application/json" \
  -H "apikey: <ANON_KEY>" \
  -H "Authorization: Bearer <ANON_KEY>" \
  -d '{"p_uid":"<UID>","p_action":"get_power","p_username":"玩家昵称"}'
```

## 注意事项

- 限频：每个 UID 每小时最多 120 次调用，不要循环重试，失败时把 `error` 原文告诉用户。
- 修改类操作（加/减电力）请先向用户确认数值再执行，不要自作主张。
- 未知动作、权限未开通、UID 停用等都会返回中文错误信息，照实转述即可。
