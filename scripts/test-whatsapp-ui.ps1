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
# IRawElementProviderSimple lives in UIAutomationTypes; AutomationInteropProvider is in UIAutomationProvider itself.
$fixtureReferences = $references + @([System.Windows.Automation.Provider.IRawElementProviderSimple].Assembly.Location, [System.Windows.Automation.Provider.AutomationInteropProvider].Assembly.Location, [System.Windows.Forms.Form].Assembly.Location, [System.Drawing.Point].Assembly.Location)
Add-Type -Path (Join-Path $PSScriptRoot '../tests/WhatsAppUiFixture.cs') -OutputAssembly $fixtureExe -OutputType WindowsApplication -ReferencedAssemblies $fixtureReferences
$cases = @(
  @{ mode = 'no-editor'; action = 'call'; kind = 'voice'; code = 'calling'; marker = 'voice' },
  @{ mode = 'no-editor'; action = 'call'; kind = 'video'; code = 'calling'; marker = 'video' },
  @{ mode = 'editor'; action = 'send'; kind = ''; code = 'sent'; marker = 'sent:Literal +{ENTER}' },
  @{ mode = 'recycled-search-no-editor'; action = 'call'; kind = 'voice'; code = 'calling'; marker = 'voice' },
  @{ mode = 'recycled-search-editor'; action = 'send'; kind = ''; code = 'sent'; marker = 'sent:Literal +{ENTER}' },
  @{ mode = 'wrong-header'; action = 'call'; kind = 'voice'; code = 'chat_not_opened'; marker = '' },
  # WebView-like fields: programmatic focus is ignored, a real click works (search and message box) ...
  @{ mode = 'click-focus'; action = 'send'; kind = ''; code = 'sent'; marker = 'sent:Literal +{ENTER}' },
  @{ mode = 'click-focus'; action = 'call'; kind = 'voice'; code = 'calling'; marker = 'voice' },
  # ... or nothing works: stop before typing anything
  @{ mode = 'focus-never'; action = 'call'; kind = 'voice'; code = 'focus_refused'; marker = '' }
)
# The phone-number route: WhatsApp's own whatsapp://send links. Only on CI, where the fixture can be the
# whatsapp: link handler without touching a real WhatsApp installation's link association.
$phone = '919876543210'
$linkCases = @(
  @{ mode = 'link'; action = 'send'; kind = ''; contact = 'Shadow fixture contact'; code = 'sent'; marker = 'sent:Literal +{ENTER}' },
  @{ mode = 'link'; action = 'call'; kind = 'video'; contact = 'Shadow fixture contact'; code = 'calling'; marker = 'video' },
  @{ mode = 'link-number'; action = 'call'; kind = 'voice'; contact = ''; code = 'calling'; marker = 'voice' },
  @{ mode = 'link-other'; action = 'send'; kind = ''; contact = 'Shadow fixture contact'; code = 'link_unverified'; marker = '' },
  @{ mode = 'link-other'; action = 'call'; kind = 'voice'; contact = 'Shadow fixture contact'; code = 'recipient_unverified'; marker = '' }
)
$linkKey = 'HKCU:\Software\Classes\whatsapp'
$canLink = $env:GITHUB_ACTIONS -eq 'true' -and -not (Test-Path $linkKey)
if ($canLink) {
  New-Item -Path "$linkKey\shell\open\command" -Force | Out-Null
  Set-ItemProperty -Path $linkKey -Name '(default)' -Value 'URL:WhatsApp fixture'
  Set-ItemProperty -Path $linkKey -Name 'URL Protocol' -Value ''
  Set-ItemProperty -Path "$linkKey\shell\open\command" -Name '(default)' -Value ('"' + $fixtureExe + '" --link "' + (Join-Path $fixtureDir 'link.txt') + '" "%1"')
  $cases += $linkCases
} else {
  'SKIP: whatsapp:// link fixtures run on CI only (they register a temporary link handler)'
}
try {
  foreach ($case in $cases) {
    $log = Join-Path $fixtureDir ([Guid]::NewGuid().ToString('N') + '.txt')
    [IO.File]::WriteAllText($log, '')
    $fixture = Start-Process -FilePath $fixtureExe -ArgumentList @(('"' + $log + '"'), $case.mode, ('"' + (Join-Path $fixtureDir 'link.txt') + '"')) -PassThru
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
      $isLink = $case.mode.StartsWith('link')
      if ($isLink) { $result = [Shadow.WhatsAppDesktop]::RunLink($case.action, $phone, $case.contact, $message, $case.kind) }
      else { $result = [Shadow.WhatsAppDesktop]::Run($case.action, 'Shadow fixture contact', $message, $case.kind, $false) }
      if ($result.code -ne $case.code) { throw "Fixture $($case.mode)/$($case.action)/$($case.kind) returned $($result.code) at $($result.stage), expected $($case.code)" }
      $events = [IO.File]::ReadAllText($log)
      if ($isLink) {
        if (-not $events.Contains("link:$phone")) { throw 'The chat was not opened through the whatsapp: link' }
        if ($events.Contains('search-keypress')) { throw 'The link route must not type into chat search' }
        if ($case.marker -and -not $events.Contains($case.marker)) { throw 'Requested link action did not happen' }
        if ($case.action -eq 'send' -and $case.marker -and -not $events.Contains("sent:$message`n")) { throw 'Link text was not delivered exactly (Unicode/multiline)' }
        if (-not $case.marker -and ($events.Contains('voice') -or $events.Contains('video') -or $events.Contains('sent:'))) { throw 'An action happened although the link did not open the right chat' }
        "PASS: native fixture $($case.mode)/$($case.action)/$($case.kind)"
        continue
      }
      if ($case.mode -eq 'focus-never') {
        if ($events.Contains('search-keypress') -or $events.Contains('opened') -or $events.Contains('voice') -or $events.Contains('sent:')) { throw 'Typed or acted although the search box never took the cursor' }
        "PASS: native fixture $($case.mode)/$($case.action)/$($case.kind)"
        continue
      }
      if ($case.mode -eq 'click-focus' -and -not ($events.Contains('focus-refused') -and $events.Contains('click'))) { throw 'The click fallback for refused focus was not exercised' }
      if (-not $events.Contains('search-keypress')) { throw 'Search was not entered through native keyboard events' }
      if ($case.mode.StartsWith('recycled-search') -and -not $events.Contains('search-recycled')) { throw 'Fixture did not replace its search accessibility element' }
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
  if ($canLink) { Remove-Item -Path $linkKey -Recurse -Force -ErrorAction SilentlyContinue } # the temporary link handler
  # Every process has exited and this directory contains only test-generated files.
  [IO.Directory]::Delete($fixtureDir, $true)
}
