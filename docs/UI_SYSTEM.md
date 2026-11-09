# RemoteOps 管理后台 UI System v3

## 设计定位

面向运维工程师的专业管理控制台。参考 Linear / Vercel 一类开发者工具的**信息密度与克制层级**，不复制其品牌或视觉资产，不使用装饰性渐变、炫光、大号伪图标或无意义营销文案。

本项目保留原生 HTML、CSS、JavaScript 与现有 Node.js Gateway API；不引入 React、Tailwind、远程图标服务和外部字体依赖。可在受限 VPS 与严格 CSP 下运行。

## 视觉规范

- **布局**：62px 顶部工具栏、225px 左导航、内容区域最大 1210px；窄屏变成横向导航。
- **底色**：默认浅色 #f9fafb，卡片 #fff，文本 #20242c；深色 #11151a 可在设置中切换。
- **主按钮**：深灰 #202a38，文字为白色；不使用品牌渐变。
- **线条**：#e5e7eb / #d5d9e0；面板 9px 圆角、轻量阴影。
- **层级**：页面标题 24px，面板标题 15px，正文 12–13px；指标数字 29px。
- **图标**：本地 SVG symbol 图标，线宽 1.65；避免随意使用 Unicode 符号作导航图标。
- **动效**：仅按钮颜色短过渡；尊重 prefers-reduced-motion。
- **适配**：740px 以下紧凑导航，480px 以下优化统计栅格；不产生横向滚动。
- **可访问性**：表单使用明确标签，关键图标具有 aria-hidden，错误信息 role=alert，键盘焦点可见。

## 登录与首次初始化

生产网关尚未设置 TOTP 时，控制台会隐藏不可用的验证码表单，显示明确的“配置管理员验证”操作，导航到既有 /admin/setup。

管理员初始化页面使用相同的设计规范，并分为 Owner Token 核验、扫描二维码/输入动态验证码两步。新设计**仅更换页面展示**，不改变原有 Owner Token 校验、锁定阈值、TOTP 防重放、CSRF、OAuth、session cookie 等安全逻辑。

不要尝试用 Agent 权限绕过初始化或将 Owner Token 写进公开仓库。

## 动态数据与安全

后台的审计、设备名称、使用统计等数据仍由原有 /admin/api 接口提供，通过 DOM textContent 写入，不拼接不可信 HTML。

严格 CSP 禁止内联 style 属性。统计柱图及百分比进度条只允许 height / width / opacity 三种数字化 CSSOM 修改，避免出现图表不可见或引入 CSS 注入。

## 本地视觉回归

1. 在隔离的测试 Gateway 上打开 /admin/ 和 /admin/setup，检查首次使用流程。
2. 使用模拟 API 设备和审计数据检查总览、设备管理与全部导航。
3. 桌面 1440×900、移动端 390×844 做截图校验；检查浏览器 JS 错误与横向溢出。
4. 通过 npm test 和 python3 scripts/secret_scan.py 后提交 PR。
5. VPS 只更换 Gateway 版本目录，保留 SQLite 和 OAuth，独立 SSH 管理通道备份/回滚。
