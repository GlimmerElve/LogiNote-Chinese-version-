# Community contracts · 阶段 0

这里是网站、桌面、手机和社区服务拟共用的纯 TypeScript 接口边界，不依赖 React、Electron、DOM 存储或身份服务商。当前不是独立发布的 npm 包，不安装新依赖，也不修改根工程的 workspace 配置。

- index.ts：身份状态和账号接入端口、资源摘要与范围、正文即可提交的求助、权限预检、安静偏好。
- authenticated 仅是 UI 会话快照，不能作为后端授权凭据；本地 UserProfile、设备 ID、昵称或角色字段都不能充当真实账号。
- 权限预检不代替操作时的服务端校验。请求不接受客户端指定的操作者；未来服务从验证过的会话解析操作者。
- 资源摘要不携带本地 NoteItem、UserProfile、登录容器或附件原始路径。资源正文包及运行时校验在阶段 3 实现。
- group 和 direct 的非空标识、内容大小、路由安全及版本等必须在后续服务入口运行时验证，TypeScript 类型本身不验证外部 JSON。
- 当前的未接入适配器位于 src/services/community/unavailableIdentity.ts，所有账号动作明确返回 not_configured，权限预检默认拒绝。不注册到现有 App、不产生网络或存储副作用。
- 阶段 1 如需演示合成身份，必须独立标注为合成数据，不能把演示适配器绑定到真实发布或管理服务。

独立检查：node node_modules/typescript/bin/tsc --project tsconfig.community-phase0.json；行为检查：node scripts/run-tsx-safe.cjs scripts/check-community-phase-zero.ts。
