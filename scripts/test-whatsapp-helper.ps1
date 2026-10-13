$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
$references = @([System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.ControlType].Assembly.Location, [System.Windows.Rect].Assembly.Location, [System.Diagnostics.Process].Assembly.Location)
Add-Type -Path @((Join-Path $PSScriptRoot '../main/windows/WhatsAppLayout.cs'), (Join-Path $PSScriptRoot '../main/windows/WhatsAppDesktop.cs'), (Join-Path $PSScriptRoot '../tests/WhatsAppLayoutTests.cs')) -ReferencedAssemblies $references
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
foreach ($ok in @('919876543210', '14155550123', '447700900123')) { if (-not [Shadow.WhatsAppDesktop]::ValidPhone($ok)) { throw "Valid number rejected: $ok" } }
foreach ($bad in @('', '+919876543210', '98765', '91 98765 43210', '1234567890123456', '91987654321x')) { if ([Shadow.WhatsAppDesktop]::ValidPhone($bad)) { throw 'Invalid number accepted' } }
$link = [Shadow.WhatsAppDesktop]::ChatLink('919876543210', "Hi +{ENTER} & 50% $([char]0xD83D)$([char]0xDE0A)`r`nok")
if ($link -ne 'whatsapp://send?phone=919876543210&text=Hi%20%2B%7BENTER%7D%20%26%2050%25%20%F0%9F%98%8A%0Aok') { throw "Unexpected chat link: $link" }
if ([Shadow.WhatsAppDesktop]::ChatLink('919876543210', '') -ne 'whatsapp://send?phone=919876543210') { throw 'Call link must carry no text' }
foreach ($request in @(@('send', '+91 98', 'Mom', 'Hi', ''), @('send', '919876543210', 'Mom', '', ''), @('call', '919876543210', 'Mom', '', 'other'), @('delete', '919876543210', 'Mom', 'Hi', ''))) {
  $result = [Shadow.WhatsAppDesktop]::RunLink($request[0], $request[1], $request[2], $request[3], $request[4])
  if ($result.ok -or $result.code -ne 'helper_error') { throw 'Invalid link command reached WhatsApp' }
}
'PASS: phone-number links are encoded exactly (+, braces, %, emoji, new lines) and invalid numbers never open WhatsApp'
[WhatsAppLayoutTests]::Main()
