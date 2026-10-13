'use strict';
/*
 * voice.js - J.A.R.V.I.S.'s backup voice.
 *
 * The HUD page normally speaks by itself (the browser's speech, using the Windows voices). If it
 * can't on this PC, it asks for this one: Windows' own speech engine (System.Speech) through a fixed
 * PowerShell script. The lines to say travel as base64 JSON in an environment variable - never as
 * part of the command - and the script picks a female English voice (Indian English first).
 */

const { spawn } = require('child_process');

const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
const SCRIPT = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$s=New-Object System.Speech.Synthesis.SpeechSynthesizer
$v=@($s.GetInstalledVoices()|Where-Object{$_.Enabled}|ForEach-Object{$_.VoiceInfo})
$pick=$null
if($env:SHADOW_VOICE){$pick=$v|Where-Object{$_.Name -eq $env:SHADOW_VOICE}|Select-Object -First 1}
if(-not $pick){$pick=$v|Where-Object{$_.Culture.Name -eq 'en-IN' -and "$($_.Gender)" -eq 'Female'}|Select-Object -First 1}
if(-not $pick){$pick=$v|Where-Object{$_.Culture.Name -like 'en-*' -and "$($_.Gender)" -eq 'Female'}|Select-Object -First 1}
if(-not $pick){$pick=$v|Where-Object{$_.Culture.Name -like 'en-*'}|Select-Object -First 1}
if($pick){$s.SelectVoice($pick.Name)}
$s.Rate=[int]$env:SHADOW_RATE
$s.SetOutputToDefaultAudioDevice()
$lines=@([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SHADOW_SPEECH))|ConvertFrom-Json)
[Console]::Out.WriteLine("VOICE $($s.Voice.Name)");[Console]::Out.Flush()
$i=0
foreach($l in $lines){[Console]::Out.WriteLine("START $i");[Console]::Out.Flush();$s.Speak([string]$l);$i++}
[Console]::Out.WriteLine("DONE");[Console]::Out.Flush()
`;

/** Settings speed -> System.Speech rate (-10..10). */
const RATE = { slow: -1, normal: 0, fast: 2 };

class WindowsVoice {
  constructor({ platform = process.platform, hooks = {} } = {}) {
    this.platform = platform;
    this.hooks = hooks; // tests: { speak(lines, { onLine, onEnd }) }
    this.proc = null;
  }

  available() {
    return this.platform === 'win32' || !!this.hooks.speak;
  }

  /** Say the lines in order. onLine(i) as each one starts, onEnd(finished) at the end. */
  speak(lines, { rate = 'normal', onLine = () => {}, onEnd = () => {} } = {}) {
    this.stop();
    const clean = lines.map((l) => String(l).replace(/\s+/g, ' ').trim().slice(0, 600)).filter(Boolean).slice(0, 60);
    if (!clean.length || !this.available()) {
      onEnd(false);
      return false;
    }
    if (this.hooks.speak) return this.hooks.speak(clean, { onLine, onEnd });
    const data = Buffer.from(JSON.stringify(clean), 'utf8').toString('base64').slice(0, 30000);
    const p = spawn('powershell.exe', [...PS, SCRIPT], { windowsHide: true, env: { ...process.env, SHADOW_SPEECH: data, SHADOW_VOICE: '', SHADOW_RATE: String(RATE[rate] ?? 0) } });
    this.proc = p;
    let buf = '';
    let ended = false;
    const end = (ok) => {
      if (ended) return;
      ended = true;
      if (this.proc === p) this.proc = null;
      onEnd(ok);
    };
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => {
      buf += d;
      let k;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k).trim();
        buf = buf.slice(k + 1);
        const m = /^START (\d+)$/.exec(line);
        if (m) onLine(Number(m[1]));
      }
    });
    p.on('exit', (code) => end(code === 0));
    p.on('error', () => end(false));
    return true;
  }

  stop() {
    if (!this.proc) return;
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
    this.proc = null;
  }
}

module.exports = { WindowsVoice, RATE };
