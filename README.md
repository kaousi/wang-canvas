# Wang Local

Wang Local 是一个本地 Node.js 适配项目，用来运行已经打包好的 Wang 无限画布前端。它会在本地提供静态资源服务、补齐部分本地 API、模拟或代理后端接口，并在配置完成后把图片生成请求发送到 OpenAI 兼容的图片生成接口。

这个项目主要用于本地开发、界面恢复、工作流测试，以及保存当前可运行版本的干净备份。

![Wang Local 工作台截图](docs/screenshot.png)

## 功能概览

- 从 `wang-local/` 启动并运行打包后的 Wang 画布前端。
- 通过 `auth-mock.js` 和 `settings-ui.js` 提供本地登录、鉴权和服务设置补丁。
- 支持 OpenAI 兼容图片生成配置，包括多个 API 配置、独立 key、模型选择和流式开关。
- 支持姿势参考、相机角度调整等图生图类本地流程。
- 支持本地生成历史、画布会话、素材库和生成媒体文件存储。
- 自动忽略本地密钥、生成文件、依赖目录和浏览器另存网页产生的冗余文件。

## 项目结构

```text
.
|-- README.md
|-- PROJECT_AUDIT.md
|-- docs/
|   `-- screenshot.png
`-- wang-local/
    |-- assets/
    |-- auth-mock.js
    |-- config.example.json
    |-- index.html
    |-- package.json
    |-- server.js
    `-- settings-ui.js
```

## 环境要求

- Node.js 18 或更高版本
- npm
- 如需真实生成图片，需要一个 OpenAI 兼容的图片生成 API

## 快速启动

```bash
cd wang-local
npm install
npm run dev
```

启动后打开：

```text
http://localhost:3456/workflow?workspaceId=demo
```

默认端口是 `3456`，可以在 `wang-local/config.json` 里修改。

## 配置说明

先复制配置模板：

```bash
cp wang-local/config.example.json wang-local/config.json
```

常用字段：

- `port`：本地服务端口。
- `apiBaseUrl`：OpenAI 兼容接口地址。
- `apiKey`：默认接口 key。
- `openaiProfiles`：多个独立的 OpenAI 兼容 API 配置。
- `activeOpenaiProfileId`：当前启用的 API 配置。
- `openaiStreamingEnabled`：是否默认使用流式请求。
- `outputFormat`：默认图片输出格式。

`wang-local/config.json` 可能包含 API key，所以不会提交到 GitHub。

如果没有 `config.json`，服务也可以用安全的 mock 默认配置启动，方便本地查看界面。

## 本地数据

运行时数据会写入：

```text
wang-local/generated/
wang-local/tmp/
```

这些目录只保留在本地，不会备份到 GitHub。

## 当前完成度

目前本地画布、服务设置、图片生成路由、姿势参考、相机角度调整、素材库、生成历史等功能已经做了本地适配，可以用于基础测试。

仍然没有完整实现或仍是 mock 的部分包括：会员支付、社区展示、比赛活动、通知、邀请码、操作日志、积分体系、世界模型、音频/音乐/歌词、口型同步、视频渲染、剪映导出、模板市场等。

详细审计见 `PROJECT_AUDIT.md`。

## 常用命令

```bash
cd wang-local
npm run dev
node --check server.js
```

## 备份策略

GitHub 备份只包含可运行项目和必要文档，不包含本地临时数据。

已忽略内容包括：

- API key 和本地配置文件
- 生成图片、上传文件和会话数据
- `node_modules`
- Playwright 调试记录和截图
- 浏览器另存网页产生的 `Wang - ...html` 和 `Wang - ..._files/`

这样可以保证 GitHub 仓库干净，同时保留重新安装和运行项目所需的文件。
