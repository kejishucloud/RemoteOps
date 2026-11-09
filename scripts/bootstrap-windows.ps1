#Requires -Version 5.1
<#
.SYNOPSIS
    安装/更新 Windows RemoteOps Agent（当前管理员账户）。
.DESCRIPTION
    配对独立设备密钥；固定本地 Desktop Commander 版本；建立开机和用户登录自启任务。
    不修改 OpenSSH、FRP、网络、UAC；不写入 Git 凭据。
.PARAMETER GatewayUrl
    已配置 HTTPS 和 OAuth 的公网 Gateway 地址（新设备配对时必需）。
.PARAMETER DeviceId
    稳定的设备 ID，默认 windows。
.PARAMETER Check
    仅检查本机，不安装或修改系统。
#>
[CmdletBinding()]
param(
    [string] $GatewayUrl = "",
    [string] $DeviceId = "windows",
    [string] $TaskName = "kejishu-RemoteOps-Agent",
    [switch] $Check
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

class RemoteOpsWindowsInstaller {
    [string] $SourceDirectory
    [string] $InstallDirectory
    [string] $NodePath
    [string] $ConfigPath
    [string] $TaskName
    [string] $GatewayUrl
    [string] $DeviceId

    RemoteOpsWindowsInstaller([string]$source, [string]$task, [string]$gateway, [string]$id) {
        $this.SourceDirectory = $source
        $this.InstallDirectory = Join-Path $env:LOCALAPPDATA "kejishucloud\RemoteOps"
        $this.ConfigPath = Join-Path $env:USERPROFILE ".config\remote-mcp\device.json"
        $this.TaskName = $task
        $this.GatewayUrl = $gateway.TrimEnd('/')
        $this.DeviceId = $id
        $command = Get-Command node.exe -ErrorAction Stop
        $this.NodePath = $command.Source
    }

    [void] CheckEnvironment() {
        $v = & $this.NodePath -p 'process.versions.node'
        $parts = $v.Split('.')
        if ([int]$parts[0] -lt 22 -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 13)) {
            throw "Node >=22.13 required. Current: $v"
        }
        Write-Host "Node: $v; User: $env:USERDOMAIN\$env:USERNAME"
        Write-Host "Existing device config: $(Test-Path -LiteralPath $this.ConfigPath)"
        $task = Get-ScheduledTask -TaskName $this.TaskName -ErrorAction SilentlyContinue
        if ($null -ne $task) { Write-Host "Scheduled task: $($task.State)" }
    }

    [void] Install() {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw "Run PowerShell as the target Windows administrator; no automatic elevation."
        }
        New-Item -ItemType Directory -Path $this.InstallDirectory -Force | Out-Null
        foreach ($file in @("package.json", "package-lock.json")) {
            Copy-Item -LiteralPath (Join-Path $this.SourceDirectory $file) -Destination $this.InstallDirectory -Force
        }
        Copy-Item -LiteralPath (Join-Path $this.SourceDirectory "agent") -Destination $this.InstallDirectory -Recurse -Force
        Push-Location -LiteralPath $this.InstallDirectory
        try {
            & npm.cmd ci --omit=dev --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw "npm ci failed: $LASTEXITCODE" }
        }
        finally { Pop-Location }
        $backendRoot = Join-Path $this.InstallDirectory "desktop-backend"
        & npm.cmd install --prefix $backendRoot --save-exact --omit=dev --no-audit --no-fund "@wonderwhy-er/desktop-commander@0.3.1"
        if ($LASTEXITCODE -ne 0) { throw "backend install failed: $LASTEXITCODE" }
        if (-not (Test-Path -LiteralPath $this.ConfigPath)) {
            if (-not $this.GatewayUrl.StartsWith("https://")) {
                throw "New pairing requires -GatewayUrl https://gateway.example.com"
            }
            & $this.NodePath (Join-Path $this.InstallDirectory "agent\agent.js") pair $this.GatewayUrl --device-id $this.DeviceId
            if ($LASTEXITCODE -ne 0) { throw "Device pairing failed or gateway approval timed out" }
        }
        $this.ConfigureBackend($backendRoot)
        $this.InstallScheduledTask()
    }

    [void] ConfigureBackend([string]$backendRoot) {
        $backend = Join-Path $backendRoot "node_modules\@wonderwhy-er\desktop-commander\dist\index.js"
        if (-not (Test-Path -LiteralPath $backend)) { throw "Desktop Commander entry point missing" }
        $config = Get-Content -LiteralPath $this.ConfigPath -Raw | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace($config.device_secret)) { throw "Device secret missing" }
        if ($config.device_id -ne $this.DeviceId) {
            throw "This installation is paired as '$($config.device_id)' rather than '$($this.DeviceId)'."
        }
        $backup = $this.ConfigPath + ".before-remoteops"
        if (-not (Test-Path -LiteralPath $backup)) {
            Copy-Item -LiteralPath $this.ConfigPath -Destination $backup
        }
        $config.desktop_commander = @{ command = @($this.NodePath, $backend) }
        $json = ConvertTo-Json -InputObject $config -Depth 14
        [IO.File]::WriteAllText($this.ConfigPath, $json, (New-Object System.Text.UTF8Encoding($false)))
        $user = $env:USERDOMAIN + "\" + $env:USERNAME
        & icacls.exe $this.ConfigPath /inheritance:r | Out-Null
        & icacls.exe $this.ConfigPath /grant:r ($user + ":F") "SYSTEM:F" "Administrators:F" | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Failed to protect device credentials" }
        Write-Host "Device configured; credentials not printed."
    }

    [void] InstallScheduledTask() {
        $logs = Join-Path $this.InstallDirectory "logs"
        New-Item -ItemType Directory -Force -Path $logs | Out-Null
        $wrapper = Join-Path $this.InstallDirectory "run-agent.cmd"
        $agent = Join-Path $this.InstallDirectory "agent\agent.js"
        $logfile = Join-Path $logs "agent.log"
        $line1 = 'cd /d "{0}"' -f $this.InstallDirectory
        $line2 = '"{0}" "{1}" >> "{2}" 2>&1' -f $this.NodePath, $agent, $logfile
        $lines = [string[]]@("@echo off", $line1, $line2)
        [IO.File]::WriteAllLines($wrapper, $lines, [Text.Encoding]::ASCII)
        $taskUser = $env:USERDOMAIN + "\" + $env:USERNAME
        $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot "System32\cmd.exe") -Argument ('/d /c ""{0}""' -f $wrapper) -WorkingDirectory $this.InstallDirectory
        $triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn -User $taskUser))
        $principal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType S4U -RunLevel Highest
        $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        Register-ScheduledTask -TaskName $this.TaskName -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description "Kejishu RemoteOps agent - outbound WSS" -Force | Out-Null
        Start-ScheduledTask -TaskName $this.TaskName
        Write-Host "Scheduled task installed: $($this.TaskName), highest privilege of $taskUser"
        Write-Host "Log: $logfile"
    }
}

$source = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$installer = [RemoteOpsWindowsInstaller]::new($source, $TaskName, $GatewayUrl, $DeviceId)
$installer.CheckEnvironment()
if (-not $Check) { $installer.Install() }
