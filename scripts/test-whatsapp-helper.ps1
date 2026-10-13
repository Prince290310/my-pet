$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
$references = @([System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.ControlType].Assembly.Location, [System.Windows.Rect].Assembly.Location, [System.Diagnostics.Process].Assembly.Location)
Add-Type -Path (Join-Path $PSScriptRoot '../main/windows/WhatsAppDesktop.cs') -ReferencedAssemblies $references
# These fail validation before accessing any window. No chat is opened, message sent or call placed.
$invalid = @(
  @('unknown', 'Mom', 'Hello', 'voice'),
  @('send', '', 'Hello', ''),
  @('send', "Mom`nDad", 'Hello', ''),
  @('send', 'Mom', '', ''),
  @('send', 'Mom', ('x' * 4001), ''),
  @('call', 'Mom', '', 'other')
)
foreach ($request in $invalid) {
  $result = [Shadow.WhatsAppDesktop]::Run($request[0], $request[1], $request[2], $request[3], $false)
  if ($result.ok -or $result.code -ne 'helper_error') { throw 'Invalid command reached UI automation' }
}
'PASS: Windows accessibility helper compiles and rejects invalid commands before accessing UI'
