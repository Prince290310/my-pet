$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
  $references = @([System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.ControlType].Assembly.Location, [System.Windows.Rect].Assembly.Location, [System.Diagnostics.Process].Assembly.Location)
  Add-Type -Path (Join-Path $PSScriptRoot 'WhatsAppDesktop.cs') -ReferencedAssemblies $references
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $result = [Shadow.WhatsAppDesktop]::Run([string]$request.action, [string]$request.contact, [string]$request.message, [string]$request.callType, [bool]$request.waitForApp)
  $result | ConvertTo-Json -Compress
} catch {
  # Do not write private contact/message data or raw helper exceptions to logs.
  @{ ok = $false; code = 'helper_error' } | ConvertTo-Json -Compress
}
