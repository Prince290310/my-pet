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
foreach ($name in @('WhatsApp', 'WhatsAppBeta', 'WhatsApp.Root', 'WhatsApp Desktop')) {
  if (-not [Shadow.WhatsAppDesktop]::KnownProcessName($name)) { throw "Unrecognized WhatsApp process: $name" }
}
foreach ($name in @('chrome', 'msedge', 'notepad', 'WhatsAppFake')) {
  if ([Shadow.WhatsAppDesktop]::KnownProcessName($name)) { throw 'Unrelated application accepted as WhatsApp' }
}
if (-not [Shadow.WhatsAppDesktop]::KnownPackage('5319275A.WhatsAppDesktop_cv1g1gvanyjgm')) { throw 'Microsoft Store package not recognized' }
if ([Shadow.WhatsAppDesktop]::KnownPackage('Other.WhatsApp_fake')) { throw 'Unrelated package accepted' }
'PASS: classic, root-process and Microsoft Store identities are recognized without accepting browsers'
$candidates = @(
  @($true, $false, $false, $false, $true), # Search identifies a window even with a changed title.
  @($false, $true, $false, $false, $true), # A minimized main window can be restored for a command.
  @($false, $true, $true, $false, $false), # Owned notifications are not main chat windows.
  @($true, $true, $false, $true, $false), # A call window is not a chat target.
  @($false, $false, $false, $false, $false)
)
foreach ($candidate in $candidates) {
  $actual = [Shadow.WhatsAppDesktop]::MainWindowCandidate($candidate[0], $candidate[1], $candidate[2], $candidate[3])
  if ($actual -ne $candidate[4]) { throw 'Incorrect main-window classification' }
}
'PASS: changed titles, minimized windows, notifications and call windows are classified correctly'
if (-not [Shadow.WhatsAppDesktop]::InChatHeader(300, 60, 250, 90)) { throw 'Valid chat header rejected' }
if ([Shadow.WhatsAppDesktop]::InChatHeader(20, 60, 250, 90)) { throw 'Sidebar contact accepted as chat header' }
if ([Shadow.WhatsAppDesktop]::InChatHeader(300, 300, 250, 90)) { throw 'Message body accepted as chat header' }
'PASS: recipient header verification does not require a composer and rejects sidebar/body matches'
