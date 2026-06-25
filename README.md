# CNproxypool

通过采集互联网公开代理、去重、检测可用性，并通过页面与 HTTP API 输出结果的项目。
Created by vibe coding

## 功能

- 内置来源：`ip3366_free`、`qiyun_free`、`66daili_free`、`89ip_free`、`zdaye_free`
- D1 持久化，适合 Cloudflare Pages Functions 部署
- 按 `host:port` 去重
- 记录健康状态、检测延迟和上次测试时间


项目结构：

- `public/`：前端页面
- `public/_worker.js`：Pages Functions Advanced Mode API
- `schema.sql`：D1 表结构
- `wrangler.toml`：Pages + D1 配置

创建 D1 数据库：

```bash
npx wrangler d1 create proxy_pool_hub
```

把返回的 `database_id` 填入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "proxy_pool_hub"
database_id = "你的 D1 database_id"
```

初始化远程 D1：

```bash
npm install
npm run d1:init:remote
```

部署到 Pages：

```bash
npm run deploy
```

本地预览：

```bash
npm install
npm run d1:init
npm run dev
```

访问：

- 前台页面：`http://localhost:18080/`
- 健康检查：`http://localhost:18080/api/v1/health`

## API 示例

刷新全部启用来源并健康检查：

```bash
curl -X POST https://你的域名/api/v1/refresh \
  -H "Content-Type: application/json" ^
  -d "{\"check\":true,\"max_checks\":500}"
```

查询健康代理：

```bash
curl "https://你的域名/api/v1/proxies?healthy_only=true&province=广东省&scheme=http&limit=50"
```

按策略选择一个代理：

```bash
curl "https://你的域名/api/v1/proxies/select?province=广东省&strategy=fastest&healthy_only=true"
```

返回中的 `item.url` 可直接作为上游系统的 requests/aiohttp/Node 代理 URL。

## 后续集成示例

其它项目只需要保留 HTTP 客户端，通过以下接口获取处理好的代理：

```http
GET {PROXY_POOL_BASE_URL}/api/v1/proxies/select?province=广东省&strategy=fastest&healthy_only=true
```

示例响应：

```json
{
  "item": {
    "host": "1.2.3.4",
    "port": 8080,
    "scheme": "http",
    "url": "http://1.2.3.4:8080",
    "province": "广东省",
    "city": "深圳市",
    "health_status": "ok",
    "check_latency_seconds": 0.83
  }
}
```

调用方使用 `item.url` 配置请求代理即可。

## 测试

```bash
node --check public/_worker.js
npm run dev
```
