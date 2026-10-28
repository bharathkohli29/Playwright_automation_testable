// Keeps Windows awake while the queue server / a test run is alive, so the PC can not sleep, lock the display into standby or suspend the run
// (a suspended run looks exactly like a silent freeze). Windows only; never throws; the helper ends by itself when its parent process ends.
// Switch off with KEEP_AWAKE=off in .env.
let started = false;
function keepAwake(label) {
  try {
    if (started || process.platform !== 'win32' || /^(off|0|false|no)$/i.test(process.env.KEEP_AWAKE || '')) return;
    started = true;
    const ps = [
      "Add-Type -Namespace W -Name P -MemberDefinition '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);'",
      `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { [W.P]::SetThreadExecutionState(2147483651) | Out-Null; Start-Sleep -Seconds 20 }`,
    ].join('; ');
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    const child = require('child_process').spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', enc], { stdio: 'ignore', windowsHide: true, detached: false });
    child.on('error', () => {});
    if (child.unref) child.unref();
    if (label) console.log(`  Keep-awake: the PC will not go to sleep while ${label} (KEEP_AWAKE=off in .env switches this off)`);
  } catch { /* never break the run */ }
}
module.exports = { keepAwake };
