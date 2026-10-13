$ErrorActionPreference = 'Stop'
if (-not [Environment]::UserInteractive) {
  'SKIP: native UI fixtures need an interactive Windows desktop; selector checks still run separately.'
  exit 0
}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
$references = @([System.Windows.Automation.AutomationElement].Assembly.Location, [System.Windows.Automation.ControlType].Assembly.Location, [System.Windows.Rect].Assembly.Location, [System.Diagnostics.Process].Assembly.Location)
Add-Type -Path @((Join-Path $PSScriptRoot '../main/windows/WhatsAppLayout.cs'), (Join-Path $PSScriptRoot '../main/windows/WhatsAppDesktop.cs')) -ReferencedAssemblies $references
# This test is isolated to clean CI machines. Never place a command in a user's real WhatsApp window.
if ([Diagnostics.Process]::GetProcesses() | Where-Object { [Shadow.WhatsAppDesktop]::KnownProcessName($_.ProcessName) }) {
  throw 'Close existing WhatsApp processes before running the isolated UI fixture.'
}
$fixtureDir = Join-Path ([IO.Path]::GetTempPath()) ('shadow-whatsapp-fixture-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureDir | Out-Null
$fixtureExe = Join-Path $fixtureDir 'WhatsApp.Root.exe'
Add-Type -AssemblyName UIAutomationProvider, System.Windows.Forms, System.Drawing
$fixtureReferences = $references + @([System.Windows.Automation.Provider.IRawElementProviderSimple].Assembly.Location, [System.Windows.Forms.Form].Assembly.Location, [System.Drawing.Point].Assembly.Location)
Add-Type -Path (Join-Path $PSScriptRoot '../tests/WhatsAppUiFixture.cs') -OutputAssembly $fixtureExe -OutputType WindowsApplication -ReferencedAssemblies $fixtureReferences
$cases = @(
  @{ mode = 'no-editor'; action = 'call'; kind = 'voice'; code = 'calling'; marker = 'voice' },
  @{ mode = 'no-editor'; action = 'call'; kind = 'video'; code = 'calling'; marker = 'video' },
  @{ mode = 'editor'; action = 'send'; kind = ''; code = 'sent'; marker = 'sent:Literal +{ENTER}' },
  @{ mode = 'wrong-header'; action = 'call'; kind = 'voice'; code = 'chat_not_opened'; marker = '' }
)
try {
  foreach ($case in $cases) {
    $log = Join-Path $fixtureDir ([Guid]::NewGuid().ToString('N') + '.txt')
    [IO.File]::WriteAllText($log, '')
    $fixture = Start-Process -FilePath $fixtureExe -ArgumentList @(('"' + $log + '"'), $case.mode) -PassThru
    try {
      $deadline = [DateTime]::UtcNow.AddSeconds(10)
      do {
        Start-Sleep -Milliseconds 100
        $fixture.Refresh()
      } while ($fixture.MainWindowHandle -eq 0 -and -not $fixture.HasExited -and [DateTime]::UtcNow -lt $deadline)
      if ($fixture.MainWindowHandle -eq 0) { throw 'Fixture window did not start' }
      Start-Sleep -Milliseconds 300
      $status = [Shadow.WhatsAppDesktop]::Run('status', '', '', '', $false)
      if (-not $status.ok -or $status.diagnostics.composer) { throw 'Fixture must start with accessible search but no composer' }
      $message = "Literal +{ENTER} $([char]0xD83D)$([char]0xDE0A)`nSecond line"
      $result = [Shadow.WhatsAppDesktop]::Run($case.action, 'Shadow fixture contact', $message, $case.kind, $false)
      if ($result.code -ne $case.code) { throw "Fixture $($case.mode)/$($case.action)/$($case.kind) returned $($result.code) at $($result.stage), expected $($case.code)" }
      $events = [IO.File]::ReadAllText($log)
      if (-not $events.Contains('search-keypress')) { throw 'Search was not entered through native keyboard events' }
      if (-not $events.Contains('opened')) { throw 'Native helper did not activate the custom search-result row' }
      if ($case.marker -and -not $events.Contains($case.marker)) { throw 'Requested fixture action did not happen' }
      if ($case.action -eq 'send' -and -not $events.Contains("sent:$message`n")) { throw 'Literal Unicode/multiline text was not preserved' }
      if ($case.action -eq 'send' -and -not $events.Contains('draft-keypress')) { throw 'Draft was not entered through native keyboard events' }
      if (-not $case.marker -and ($events.Contains('voice') -or $events.Contains('video') -or $events.Contains('sent:'))) { throw 'An action happened despite a mismatched chat header' }
      "PASS: native fixture $($case.mode)/$($case.action)/$($case.kind)"
    } finally {
      if (-not $fixture.HasExited) { $fixture.Kill(); $fixture.WaitForExit() }
    }
  }
} finally {
  # Every process has exited and this directory contains only test-generated files.
  [IO.Directory]::Delete($fixtureDir, $true)
}
