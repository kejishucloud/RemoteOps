/**
 * RemoteOps 国际化（i18n）管理器。
 * 仅本地资源：支持中文、英文、浏览器语言检测和持久化语言选择。
 * 不使用 innerHTML、远端翻译或第三方脚本；保持所有用户输入和设备数据原样。
 * 通过 WeakMap 记住原始文案，支持无需刷新即时往返切换。
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'remoteops.ui.language';
  const pairs = [
    ['管理控制台', 'Admin Console'],
    ['工作空间', 'Workspace'],
    ['自托管 MCP Gateway', 'Self-hosted MCP Gateway'],
    ['私有部署', 'Private deployment'],
    ['退出登录', 'Sign out'],
    ['管理员身份验证', 'Administrator verification'],
    ['登录 RemoteOps', 'Sign in to RemoteOps'],
    ['管理远程设备、MCP 连接与网关运行状态。', 'Manage remote devices, MCP connections, and gateway health.'],
    ['身份验证器验证码', 'Authenticator code'],
    ['输入身份验证器应用中的 6 位动态验证码。', 'Enter the 6-digit code from your authenticator app.'],
    ['登录控制台', 'Sign in'],
    ['开始使用前需要完成安全设置', 'Security setup required'],
    ['当前控制台尚未启用管理员身份验证。', 'Administrator verification has not been enabled.'],
    ['使用已有的管理员 Owner Token 完成验证器绑定。此操作不会修改设备凭据或 OAuth 连接。', 'Use your administrator Owner Token to enroll an authenticator. This does not change device credentials or OAuth connections.'],
    ['配置管理员验证', 'Set up administrator verification'],
    ['只有持有管理员令牌的人员可以执行初始化。', 'Only holders of the administrator token can complete setup.'],
    ['身份验证由你部署的 Gateway 独立处理', 'Authentication is handled by your own Gateway.'],
    ['工作台', 'Workspace'],
    ['运行总览', 'Overview'],
    ['设备管理', 'Devices'],
    ['使用量统计', 'Usage analytics'],
    ['认证信息', 'Credentials'],
    ['ChatGPT 连接', 'ChatGPT connection'],
    ['管理', 'Administration'],
    ['操作审计', 'Audit log'],
    ['设备配对', 'Device pairing'],
    ['系统设置', 'Settings'],
    ['Gateway 已连接', 'Gateway connected'],
    ['控制台', 'Console'],
    ['网关运行中', 'Gateway operational'],
    ['刷新', 'Refresh'],
    ['统一查看设备状态、连接与工具调用情况。', 'Monitor devices, connections, and tool calls in one place.'],
    ['统一查看设备连接与工具调用情况。', 'Monitor device connections and tool calls.'],
    ['查看跨平台 Agent 连接并管理各设备的 MCP 工具。', 'Review cross-platform Agents and their MCP tools.'],
    ['分析网关工具调用趋势、延迟及错误情况。', 'Analyze tool call volume, latency, and errors.'],
    ['管理 OAuth 客户端、令牌和后台安全会话。', 'Manage OAuth clients, tokens, and secure admin sessions.'],
    ['ChatGPT 插件展示', 'ChatGPT integration'],
    ['配置自定义 MCP 服务的展示信息与接入说明。', 'Configure the MCP integration details and setup instructions.'],
    ['检索各类工具请求的安全审计记录。', 'Review security audit records for tool requests.'],
    ['通过限时授权窗口添加新的远程设备。', 'Add remote devices using a time-limited pairing window.'],
    ['配置主题、刷新频率与连接展示信息。', 'Configure appearance, refresh intervals, and integration details.'],
    ['RemoteOps · 自托管运维管理平台', 'RemoteOps · Self-hosted management'],
    ['搜索设备名称、系统或标识…', 'Search by device name, OS, or ID…'],
    ['搜索设备', 'Search devices'],
    ['未知系统', 'Unknown OS'],
    ['未报告主机名', 'Hostname unavailable'],
    ['在线', 'Online'],
    ['离线', 'Offline'],
    ['当前已连接', 'Currently connected'],
    ['从未', 'Never'],
    ['刚刚', 'Just now'],
    ['MCP 工具', 'MCP tools'],
    ['重命名', 'Rename'],
    ['注销', 'Revoke'],
    ['设置设备显示名称（最多 64 个字符）', 'Set the device display name (max. 64 characters)'],
    ['设备名称已更新', 'Device name updated'],
    ['设备已注销', 'Device revoked'],
    ['没有匹配的设备。', 'No matching devices.'],
    ['尚无注册设备，请在「设备配对」中添加。', 'No registered devices. Use Device pairing to add one.'],
    ['在线、离线和 MCP 服务状态来自网关实时上报。', 'Connection and MCP service status are reported by the Gateway.'],
    ['添加设备', 'Add device'],
    ['工具', 'Tools'],
    ['收起工具', 'Hide tools'],
    ['禁用', 'Disable'],
    ['启用', 'Enable'],
    ['移除', 'Remove'],
    ['保存', 'Save'],
    ['恢复默认', 'Restore defaults'],
    ['自定义命令…', 'Custom command…'],
    ['添加 MCP 服务', 'Add MCP server'],
    ['设备当前离线，重连后将启动服务。', 'This device is offline. The service will start when it reconnects.'],
    ['返回设备列表', 'Back to devices'],
    ['当前设备的 MCP 服务', 'MCP services on this device'],
    ['内置', 'Built-in'],
    ['已注册设备', 'Registered devices'],
    ['工具调用', 'Tool calls'],
    ['调用成功率', 'Success rate'],
    ['已授权客户端', 'Authorized clients'],
    ['静态令牌与 OAuth 客户端', 'Static tokens and OAuth clients'],
    ['调用量趋势', 'Call volume trend'],
    ['设备连接状态', 'Device connection status'],
    ['运行质量', 'Operational quality'],
    ['平均调用耗时', 'Average call duration'],
    ['失败调用', 'Failed calls'],
    ['统计基于已持久化的审计记录，非模型 Token 用量。', 'Metrics are from persisted audit records, not model token usage.'],
    ['快速入口', 'Quick actions'],
    ['查看设备管理', 'Manage devices'],
    ['使用量详情', 'Usage details'],
    ['统计时间范围', 'Date range'],
    ['调用分析', 'Call analytics'],
    ['网关审计数据 · 不包含敏感参数和工具输出', 'Gateway audit data · Sensitive inputs and outputs excluded'],
    ['总调用', 'Total calls'],
    ['成功', 'Successful'],
    ['失败', 'Failed'],
    ['平均耗时', 'Average duration'],
    ['选定统计区间', 'Selected date range'],
    ['有记录的调用耗时均值', 'Mean duration of recorded calls'],
    ['审计记录中非 success 的调用', 'Non-successful calls in audit records'],
    ['当前区间暂无工具调用记录', 'No tool calls in this period'],
    ['当前区间暂无设备调用记录', 'No device calls in this period'],
    ['工具调用趋势', 'Tool call trend'],
    ['工具调用趋势图', 'Tool call trend chart'],
    ['高频工具', 'Top tools'],
    ['按设备统计', 'By device'],
    ['暂无已注册设备', 'No registered devices'],
    ['双因素认证', 'Two-factor authentication'],
    ['已启用', 'Enabled'],
    ['未配置', 'Not configured'],
    ['后台管理员登录', 'Administrator sign-in'],
    ['OAuth 客户端', 'OAuth clients'],
    ['有效静态令牌', 'Active static tokens'],
    ['只显示数量，不展示令牌值', 'Counts only; token values are never shown'],
    ['后台登录会话', 'Admin sessions'],
    ['登录安全', 'Sign-in security'],
    ['会话空闲超时', 'Session idle timeout'],
    ['会话绝对有效期', 'Maximum session lifetime'],
    ['注销其他会话', 'Sign out other sessions'],
    ['确定注销其他所有后台登录会话？', 'Sign out all other admin sessions?'],
    ['页面不会显示、传输或导出身份验证密钥。', 'This page never displays, transmits, or exports authentication secrets.'],
    ['ChatGPT 插件展示已关闭，可在「系统设置」中启用。', 'ChatGPT integration display is disabled. Enable it in Settings.'],
    ['ChatGPT 标识', 'ChatGPT logo'],
    ['MCP · 自定义连接', 'MCP · Custom connection'],
    ['自托管', 'Self-hosted'],
    ['通过兼容 MCP 的客户端连接远程设备。展示信息可在系统设置中自定义。', 'Access remote devices through an MCP-compatible client. Customize these details in Settings.'],
    ['复制', 'Copy'],
    ['已复制 MCP 地址', 'MCP URL copied'],
    ['复制失败，请手动选择地址', 'Could not copy. Please select the URL manually.'],
    ['打开 ChatGPT 的应用与连接设置。', 'Open ChatGPT app and connection settings.'],
    ['添加支持的自定义 MCP 连接。', 'Add a supported custom MCP connection.'],
    ['填写 MCP 服务器地址。', 'Enter the MCP server URL.'],
    ['使用下方提供的 HTTPS 接入地址。', 'Use the HTTPS endpoint below.'],
    ['完成 OAuth 授权。', 'Complete OAuth authorization.'],
    ['使用网关提供的标准认证流程审核连接。', 'Approve the connection using the Gateway OAuth flow.'],
    ['验证工具访问。', 'Verify tool access.'],
    ['先检查设备列表与权限，再执行需要授权的操作。', 'Check devices and permissions before executing authorized actions.'],
    ['MCP 服务接入地址', 'MCP server endpoint'],
    ['当前使用 HTTPS 地址。', 'The endpoint uses HTTPS.'],
    ['当前使用 HTTP 地址；跨公网连接必须配置 HTTPS。', 'The endpoint uses HTTP; HTTPS is required for public access.'],
    ['配置步骤', 'Setup steps'],
    ['是否允许创建自定义 MCP 连接，取决于 ChatGPT 账户、工作空间和平台支持情况。此页面仅管理 RemoteOps 的展示信息。', 'Custom MCP connections depend on your ChatGPT plan, workspace, and platform. This page only manages RemoteOps display information.'],
    ['控制台名称', 'Console name'],
    ['仅影响管理页面的显示名称。', 'Changes the name shown in the admin interface only.'],
    ['界面主题', 'Appearance'],
    ['跟随系统', 'System'],
    ['浅色', 'Light'],
    ['深色', 'Dark'],
    ['刷新间隔', 'Refresh interval'],
    ['默认统计周期', 'Default reporting period'],
    ['插件展示名称', 'Integration display name'],
    ['插件描述', 'Integration description'],
    ['在管理页面显示 ChatGPT 连接卡片', 'Show the ChatGPT connection card in the console'],
    ['保存全部设置', 'Save settings'],
    ['设置已保存', 'Settings saved'],
    ['基本设置', 'General settings'],
    ['所有设置由网关保存至现有 SQLite 数据库，可在重新登录后恢复。', 'Settings are stored in the Gateway SQLite database and restored when you sign in.'],
    ['ChatGPT 连接展示', 'ChatGPT connection display'],
    ['这里只影响控制台卡片文案，不修改 ChatGPT 应用、OAuth 客户端或权限。', 'Only console display text is affected; ChatGPT apps, OAuth clients, and permissions remain unchanged.'],
    ['连接与安全', 'Connection and security'],
    ['MCP 服务地址', 'MCP server URL'],
    ['后台双因素认证', 'Administrator two-factor authentication'],
    ['已开启', 'Enabled'],
    ['未启用', 'Not enabled'],
    ['涉及设备权限、配对审批和凭据轮换的操作仍使用专门的安全流程。', 'Device authorization, pairing approval, and credential rotation use separate security workflows.'],
    ['工具列表模式：', 'Tool list mode:'],
    ['固定列表（推荐）', 'Stable list (recommended)'],
    ['动态列表（随设备变化）', 'Dynamic list (changes with device)'],
    ['已授权', 'Authorized'],
    ['无有效授权', 'No active grants'],
    ['撤销', 'Revoke'],
    ['OAuth 授权客户端', 'Authorized OAuth clients'],
    ['静态访问令牌', 'Static access tokens'],
    ['暂无', 'None'],
    ['没有符合条件的审计记录。', 'No matching audit records.'],
    ['只记录调用元数据，不保存工具参数与输出。', 'Only call metadata is logged, not tool arguments or outputs.'],
    ['配对窗口已关闭', 'Pairing window closed'],
    ['立即关闭', 'Close now'],
    ['开放 3 分钟', 'Open for 3 minutes'],
    ['开放限时配对窗口，再从设备端发起配对。', 'Open a temporary pairing window, then start pairing from the device.'],
    ['等待设备申请配对…', 'Waiting for device pairing requests…'],
    ['验证次数过多', 'Too many attempts'],
    ['验证码无效或已使用，请输入新的验证码。', 'Invalid or previously used code. Enter a new code.'],
    ['访问地址不匹配，请使用网关配置的正式 HTTPS 地址。', 'Origin mismatch. Use the configured Gateway HTTPS URL.'],
    ['当前设备离线', 'Device offline'],
    ['管理员验证已启用', 'Administrator verification enabled'],
    ['安全验证已配置', 'Security setup complete'],
    ['页面不可用', 'Page unavailable'],
    ['管理员验证已经完成设置，请返回控制台登录。', 'Administrator verification is already configured. Return to sign in.'],
    ['返回控制台', 'Back to console'],
    ['安全初始化', 'Security setup'],
    ['管理员身份验证由自托管 Gateway 完成', 'Administrator verification is handled by your self-hosted Gateway'],
    ['步骤 01 / 02 · 验证管理员身份', 'Step 01 / 02 · Verify administrator'],
    ['配置安全验证', 'Set up secure access'],
    ['首次进入控制台需要绑定身份验证器。请先输入部署时生成的管理员 Owner Token。', 'To access the console, enroll an authenticator. Start with the administrator Owner Token created during deployment.'],
    ['管理员 Owner Token', 'Administrator Owner Token'],
    ['输入管理员令牌', 'Enter administrator token'],
    ['验证并继续 →', 'Verify and continue →'],
    ['Owner Token 保存在你的 Gateway 服务器中，请通过安全的管理通道获取，不要将令牌发送到聊天或公开仓库。', 'The Owner Token is stored on your Gateway. Retrieve it using a secure administration channel. Never share it in chat or public repositories.'],
    ['安全保护', 'Security protection'],
    ['尝试次数过多', 'Too many attempts'],
    ['返回验证页面', 'Back to verification'],
    ['管理员令牌不正确', 'Incorrect administrator token'],
    ['请确认令牌来自当前 Gateway 的管理员凭据。', 'Make sure the token is from this Gateway administrator credentials.'],
    ['重新输入', 'Try again'],
    ['步骤 02 / 02 · 绑定身份验证器', 'Step 02 / 02 · Enroll authenticator'],
    ['扫描二维码', 'Scan QR code'],
    ['使用 Google Authenticator、1Password 或其他兼容 TOTP 的验证器扫描下方二维码。', 'Scan this QR code with Google Authenticator, 1Password, or another TOTP-compatible authenticator.'],
    ['无法扫码？在验证器中手动输入以下密钥：', 'Cannot scan? Enter this key manually in the authenticator:'],
    ['六位动态验证码', 'Six-digit verification code'],
    ['确认并启用双因素验证 →', 'Confirm and enable two-factor authentication →'],
    ['密钥只会在本步骤显示。请勿截图、转发或保存到公开位置。', 'The secret appears only in this step. Do not screenshot, share, or save it publicly.'],
    ['验证码验证', 'Code verification'],
    ['验证码不正确', 'Incorrect verification code'],
    ['请确认验证器与服务器时间同步，然后', 'Make sure the authenticator and server clocks are synchronized, then'],
    ['重新开始设置', 'restart setup'],
    ['配置已完成', 'Setup complete'],
    ['现在可以使用身份验证器中的六位动态验证码登录控制台。', 'You can now sign in using the six-digit code from your authenticator.'],
    ['进入管理控制台 →', 'Open admin console →'],
    ['请安全备份验证器账户。遗失设备后需通过 Gateway 的独立管理员通道执行恢复。', 'Back up your authenticator securely. Recover access using an independent administrator channel if the device is lost.'],
    ['输入验证码', 'Enter code'],
    ['语言', 'Language'],
    ['中文', 'Chinese'],
    ['English', 'English'],
    ['Control center', '管理控制台'],
    ['Secure connection', '安全连接'],
    ['Connection request', '连接授权请求'],
    ['Authorize remote access', '授权远程访问'],
    ['Review this request before allowing the application to access your RemoteOps Gateway.', '请确认以下权限和客户端信息，再决定是否允许其访问 RemoteOps 网关。'],
    ['Requesting application', '请求授权的应用'],
    ['Application names are provided by the client and are not verified by RemoteOps.', '应用名称由客户端自行提供，RemoteOps 无法验证其真实身份。'],
    ['Requested access', '申请访问权限'],
    ['View connected devices and available tools', '查看已连接的设备和可用工具'],
    ['Use tools permitted by each device, including file operations and commands', '调用各设备策略允许的工具，包括文件操作和命令执行'],
    ['Redirect destination', '授权完成后的跳转地址'],
    ['Owner (admin) token', '管理员 Owner Token'],
    ['Use the Owner Token saved on your Gateway to approve this connection. Never share it with the requesting application.', '请输入保存在网关服务器上的 Owner Token 以批准本次连接。请勿向申请授权的应用透露此令牌。'],
    ['Approve access', '允许连接'],
    ['Only approve applications you recognize. Device-level policies continue to apply after authorization.', '只授权你信任的应用。授权后，各设备原有权限策略仍然有效。'],
    ['Invalid owner token.', '管理员令牌不正确。'],
    ['Unable to authorize', '无法完成授权'],
    ['Too many attempts. Wait a minute and try again.', '尝试次数过多，请一分钟后重试。'],
    ['Approved', '已批准'],
    ['Cancelled', '已取消'],
    ['Access was approved. Tap below to finish connecting in the app.', '已批准本次连接。点击下方按钮返回应用完成授权。'],
    ['Authorization was cancelled. Tap below to return to the app.', '已取消授权，点击下方按钮返回应用。'],
    ['Authorization is handled by your self-hosted RemoteOps Gateway', '本次授权由你的自托管 RemoteOps 网关处理'],
    ['Deny', '拒绝'],
    ['Auth', 'Auth'],
    ['owner', '管理员'],
    ['revoked', '已撤销'],
    ['static token', '静态令牌'],
    ['built-in', '内置'],
    ['online', '在线'],
    ['offline', '离线'],
    ['success', '成功'],
    ['error', '失败'],
    ['any status', '任意状态'],
    ['Custom command…', '自定义命令…'],
    ['Approve', '批准'],
    ['Deny', '拒绝'],
    ['Added. The device is starting it (first run may download the package).', '已添加。设备正在启动服务（首次启动可能下载依赖包）。'],
    ['Tools saved', '工具配置已保存'],
    ['Removed', '已移除'],
    ['Saved. Reconnect the client to refresh its tool list.', '已保存。请重新连接客户端以刷新工具列表。'],
    ['Token revoked', '令牌已撤销'],
    ['Client removed', '客户端已移除'],
    ['Approved. The device is collecting its credentials.', '已批准。设备正在接收凭据。'],
    ['name (a-z, 0-9, -)', '名称（小写字母、数字、连字符）'],
    ['command, e.g. npx', '命令，例如 npx'],
    ['one argument per line', '每行一个参数'],
    ['time', '时间'],
    ['client', '客户端'],
    ['device', '设备'],
    ['tool', '工具'],
    ['ms', '毫秒'],
    ['status', '状态'],
    ['detail', '详情'],
  ];

  // 保持项目中已有的中文/英文原始文案，不修改数据库或第三方名称。
  const zhToEn = new Map();
  const enToZh = new Map();
  for (const [zh, en] of pairs) {
    if (/[\u3400-\u9fff]/.test(zh)) {
      zhToEn.set(zh, en);
      if (!enToZh.has(en)) enToZh.set(en, zh);
    } else if (/[\u3400-\u9fff]/.test(en)) {
      // 原始代码中已有的英文文案：仅在中文模式下替换。
      enToZh.set(zh, en);
    }
  }

  const original = new WeakMap();
  const displayed = new WeakMap();
  const attrSource = new WeakMap();
  let locale = 'zh-CN';
  let observer = null;

  /** @param {unknown} value 语言环境或 Accept-Language 文本 */
  function normalizeLanguage(value) {
    return /^(en)(?:[-_,;]|$)/i.test(String(value || '').trim()) ? 'en-US' : 'zh-CN';
  }

  /**
   * 在语言改变时保留带有空白的静态文本和动态统计值。
   * @param {string} source 原始用户界面文案
   * @returns {string} 目标语言文案
   */
  function translateText(source) {
    if (typeof source !== 'string' || !source.trim()) return source;
    const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(source);
    const text = match[2];
    const dictionary = locale === 'en-US' ? zhToEn : enToZh;
    const exact = dictionary.get(text);
    if (exact !== undefined) return match[1] + exact + match[3];
    const dynamic = locale === 'en-US' ? [
      [/^(\d+) 台当前在线$/, '$1 currently online'],
      [/^近 (\d+) 天$/, 'Last $1 days'],
      [/^(\d+) 次成功$/, '$1 successful'],
      [/^(\d+) 次失败$/, '$1 failed'],
      [/^(\d+) 次$/, '$1 calls'],
      [/^最近 (\d+) 天$/, 'Last $1 days'],
      [/^已注册设备 · (\d+)$/, 'Registered devices · $1'],
      [/^\+\s*添加设备$/, '+ Add device'],
      [/^上次在线：从未$/, 'Last seen: Never'],
      [/^上次在线：(.*)$/, 'Last seen: $1'],
      [/^(\d+) 秒$/, '$1 sec'],
      [/^(\d+) 天$/, '$1 days'],
      [/^(\d+) 分钟$/, '$1 min'],
      [/^(\d+) 小时$/, '$1 hr'],
      [/^(.+) 至 (.+)：(\d+) 次调用$/, '$1 to $2: $3 calls'],
      [/^(.+)：(\d+) 次调用$/, '$1: $2 calls'],
      [/^(\d+) 分钟前$/, '$1 min ago'],
      [/^(\d+) 小时前$/, '$1 hr ago'],
      [/^(\d+) 天前$/, '$1 days ago'],
      [/^已注销 (\d+) 个其他会话$/, 'Signed out $1 other sessions'],
      [/^最长 (\d+) 小时$/, 'Up to $1 hours'],
      [/^(\d+) 条有效授权$/, '$1 active grants'],
      [/^(\d+) (分钟|小时)$/, '$1 $2'],
      [/^成功率 ([\d.]+)%$/, 'Success rate $1%'],
      [/^窗口开放 · (.*)$/, 'Window open · $1'],
      [/^请在 (\d+) 秒后重试。$/, 'Try again in $1 seconds.'],
      [/^验证次数过多，请在 (\d+) 分钟后重试。$/, 'Too many attempts. Try again in $1 minutes.'],
      [/^登录失败：(.*)$/, 'Sign-in failed: $1'],
      [/^无法读取显示设置：(.*)$/, 'Unable to load display settings: $1'],
      [/^注销设备「([^」]+)」？注销后必须重新配对才能连接。$/, 'Revoke device "$1"? It must be paired again to reconnect.'],
      [/^(\d+) 个其他会话$/, '$1 other sessions'],
      [/^.+? · (\d+) tools(?:.*)$/, '$&'],
    ] : [
      [/^(\d+) tools(.*)$/, '$1 个工具$2'],
      [/^Window open · (.*) left$/, '配对窗口开放 · 剩余 $1'],
      [/^Return to (.+)$/, '返回 $1'],
      [/^Remove (.+) from this device\?$/, '从此设备移除 $1？'],
      [/^Revoke token "(.+)"\?(.*)$/, '撤销令牌“$1”？$2'],
      [/^Remove "(.+)"\? It must be approved again to reconnect\.$/, '移除“$1”？重新连接需要再次授权。'],
      [/^registered (.*)$/, '注册时间：$1'],
    ];
    for (const [pattern, template] of dynamic) {
      if (pattern.test(text)) return match[1] + text.replace(pattern, template) + match[3];
    }
    return source;
  }

  /**
   * 保护用户输入、设备名称、工具参数及语言按钮。
   * :param node: 当前 DOM 节点
   * :return: 是否应跳过翻译
   */
  function shouldSkip(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return !!el?.closest('[data-i18n-ignore], code, pre, .mono, .device-title');
  }

  /** 翻译节点，记录来源，语言往返切换不会累计二次翻译。 */
  function translateNode(node) {
    if (shouldSkip(node)) return;
    const current = node.nodeValue;
    let source = original.get(node);
    if (source === undefined || displayed.get(node) !== current) {
      source = current;
      original.set(node, source);
    }
    const next = translateText(source);
    displayed.set(node, next);
    if (current !== next) node.nodeValue = next;
  }

  /** 翻译 DOM 属性（不包括 value、href、业务数据）。 */
  function translateAttributes(element) {
    if (shouldSkip(element)) return;
    const allowed = ['placeholder', 'title', 'aria-label'];
    let cached = attrSource.get(element);
    if (!cached) { cached = new Map(); attrSource.set(element, cached); }
    for (const key of allowed) {
      if (!element.hasAttribute(key)) continue;
      const value = element.getAttribute(key);
      let data = cached.get(key);
      if (!data || data.output !== value) data = { source: value, output: value };
      data.output = translateText(data.source);
      cached.set(key, data);
      if (value !== data.output) element.setAttribute(key, data.output);
    }
  }

  /** 翻译静态页面与新插入的异步 API 结果。 */
  function translateTree(root) {
    if (!root || typeof document === 'undefined') return;
    if (shouldSkip(root)) return;
    if (root.nodeType === 3) { translateNode(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9) return;
    if (root.nodeType === 1) translateAttributes(root);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeType === 3) translateNode(node);
      else translateAttributes(node);
    }
  }

  /** 防止敏感的 Owner Token、TOTP 密钥或设备参数落入翻译存储。WeakMap 仅保存页面文本节点引用。 */
  function savePreference() {
    try { window.localStorage.setItem(STORAGE_KEY, locale); } catch { /* Private mode */ }
  }

  /** @param {string} value 选中的语言 */
  function setLocale(value) {
    locale = normalizeLanguage(value);
    if (typeof document !== 'undefined') {
      document.documentElement.lang = locale;
      savePreference();
      translateTree(document.body);
      const brand = document.getElementById('brand-name')?.textContent?.trim() || 'RemoteOps';
      document.title = brand + (locale === 'en-US' ? ' · Admin Console' : ' · 管理控制台');
      const switcher = document.getElementById('locale-switch');
      if (switcher) {
        switcher.textContent = locale === 'zh-CN' ? 'EN' : '中文';
        switcher.setAttribute('aria-label', locale === 'zh-CN' ? '切换为英文' : 'Switch to Chinese');
        switcher.setAttribute('title', locale === 'zh-CN' ? 'English' : '简体中文');
      }
    }
    return locale;
  }

  /** 在浏览器初始化独立的语言状态和安全的动态 DOM 翻译。 */
  function init() {
    if (typeof document === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const query = params.get('lang');
    let preferred;
    try { preferred = window.localStorage.getItem(STORAGE_KEY); } catch { /* Private mode */ }
    locale = normalizeLanguage(query || preferred || navigator.language || 'zh-CN');
    const switcher = document.getElementById('locale-switch');
    if (switcher) switcher.addEventListener('click', () => setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN'));
    // 先观察再翻译；避免动态页面加载和异步渲染漏掉文本。
    observer = new MutationObserver((records) => {
      for (const mutation of records) {
        if (mutation.type === 'characterData') translateNode(mutation.target);
        if (mutation.type === 'attributes') translateAttributes(mutation.target);
        for (const node of mutation.addedNodes) translateTree(node);
      }
    });
    observer.observe(document.body, { childList: true, characterData: true,
      attributes: true, attributeFilter: ['placeholder', 'title', 'aria-label'], subtree: true });
    setLocale(locale);
  }

  globalThis.RemoteOpsI18n = Object.freeze({
    getLocale: () => locale, normalizeLanguage, translateText, setLocale, translateTree, init,
    supported: Object.freeze(['zh-CN', 'en-US']),
  });
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})();
