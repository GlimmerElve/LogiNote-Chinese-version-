# LogiNote · 静默生长社区

阶段 1 的独立网站交互原型，按 `design/community-website-concepts` 的整页、交互细节和本人主页 demo 实现。使用合成数据，不提供真实账号、上传、发布、私信或管理权限。

阶段 2 已接入真实账号、资料、工单，以及用户选定的首条内容链路。显式配置 VITE_COMMUNITY_API_URL 后，全站进入服务模式：公共交流、资源市场、作者主页、关注流、评论、本人分享／收藏／学习清单与草稿读取真实服务；不再读取或写入 loginote.community.prototype.v1，未接入的群、消息和资讯显示准备状态。未配置服务地址时才使用独立交互原型。文件、图片／头像上传、资源打包及桌面导入仍待对应阶段接入。详见 [数据归属接入记录](../../docs/artifacts/community/phase-2/data-ownership/README.md) 与 [API 说明](../community-api/README.md)。
